import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { addAppUser, findAppUser } from "../src/auth/allow-list";
import { SETTINGS_NAV_ITEMS } from "../src/components/shell/nav-config";

import { signIn } from "./support/auth";
import { withRunDatabase } from "./support/db";
import { countEmailsTo, waitForMagicLink } from "./support/mailpit";
import { run } from "./support/run";

const USERS_PATH = "/settings/users";

/** A fresh synthetic address per call (unique across runs and `--repeat-each`). */
const email = (label: string) => `e2e-${label}-${run.runId}-${crypto.randomUUID().slice(0, 8)}@example.test`;
const lookUp = (address: string) => withRunDatabase((sql) => findAppUser(sql, address));

/** The row whose email IS `address` (not rows that merely mention it, e.g. "Invited by <owner>"). */
function rowFor(page: Page, address: string) {
  return page.getByTestId("allow-list-row").filter({
    has: page.getByTestId("allow-list-email").and(page.getByText(address, { exact: true })),
  });
}

async function authCookieNames(page: Page): Promise<string[]> {
  return (await page.context().cookies())
    .map((cookie) => cookie.name)
    .filter((name) => name.startsWith("sb-"))
    .sort();
}

async function invite(page: Page, address: string) {
  await page.getByLabel("Email").fill(address);
  await page.getByRole("button", { name: "Invite manager" }).click();
}

async function removeFromList(page: Page, address: string) {
  await rowFor(page, address).getByRole("button", { name: `Remove ${address}` }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove access" }).click();
}

interface CapturedAction {
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * Runs `trigger` in the owner's page and captures the Server Action request it makes, WITHOUT
 * letting it reach the server — so it can be replayed from someone else's session.
 */
async function captureServerAction(page: Page, trigger: () => Promise<void>): Promise<CapturedAction> {
  let captured: CapturedAction | undefined;
  await page.route(`**${USERS_PATH}`, async (route) => {
    const request = route.request();
    if (request.method() !== "POST" || !request.headers()["next-action"]) return route.continue();
    captured = { url: request.url(), headers: request.headers(), body: request.postDataBuffer()! };
    await route.abort();
  });
  await trigger();
  await expect.poll(() => captured !== undefined).toBe(true);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  return captured!;
}

/** Sends a captured Server Action request with `page`'s cookies (i.e. as whoever is signed in there). */
async function replay(page: Page, action: CapturedAction, baseURL: string) {
  const headers = Object.fromEntries(
    Object.entries(action.headers).filter(([name]) => !["cookie", "content-length", "host"].includes(name)),
  );
  return page.request.post(action.url, { headers: { ...headers, origin: baseURL }, data: action.body, maxRedirects: 0 });
}

test.describe("Settings → Users", () => {
  test("the Settings link and /settings open the first settings tab, and every tab renders for the owner", async ({
    page,
  }) => {
    const firstTab = SETTINGS_NAV_ITEMS[0]!.href;
    await signIn(page, run.ownerEmail);
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Settings" }).click();
    await expect(page).toHaveURL(firstTab);
    await page.goto("/settings");
    await expect(page).toHaveURL(firstTab);

    const tabs = page.getByRole("navigation", { name: "Settings" });
    for (const item of SETTINGS_NAV_ITEMS) {
      // Only click a tab that is not the current page: re-clicking the current page passes the
      // checks below at once, leaving its navigation in flight when the test's browser closes.
      if (new URL(page.url()).pathname !== item.href) {
        await tabs.getByRole("link", { name: item.label, exact: true }).click();
      }
      await expect(page).toHaveURL(item.href);
      await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
      await expect(page.getByRole("heading", { level: 2, name: item.label })).toBeVisible();
      await expect(tabs.getByRole("link", { name: item.label, exact: true })).toHaveAttribute("aria-current", "page");
    }
  });

  test("an invited manager gets a sign-in link, sees the dashboard but not owner pages, and is locked out as soon as they are removed", async ({
    page,
    browser,
  }) => {
    const invitee = email("invitee");
    await signIn(page, run.ownerEmail);
    await page.goto(USERS_PATH);

    // Invite (the address is normalised: trimmed by the email field, lower-cased by the server).
    const ownerCookies = await authCookieNames(page);
    const since = new Date();
    await invite(page, invitee.toUpperCase());
    await expect(page.getByTestId("invite-notice")).toHaveText(`Invited ${invitee}. We emailed them a sign-in link.`);
    // The invitation is sent without touching the owner's session cookies (no PKCE code-verifier
    // for the invitee's sign-in, nor any other new Supabase cookie, lands in the owner's browser).
    expect(await authCookieNames(page)).toEqual(ownerCookies);
    const row = rowFor(page, invitee);
    await expect(row.getByText("manager", { exact: true })).toBeVisible();
    await expect(row).toContainText(`Invited by ${run.ownerEmail}`);
    await expect(row).toContainText("Never signed in");
    expect(await lookUp(invitee)).toEqual({ email: invitee, role: "manager" });

    // The invitation email signs them straight in (opened in their own browser).
    const link = await waitForMagicLink(invitee, since);
    const theirBrowser = await browser.newContext();
    const theirApi = await browser.newContext();
    try {
      const manager = await theirBrowser.newPage();
      await manager.goto(link);
      await expect(manager).toHaveURL(/\/overview$/);
      await expect(manager.getByTestId("signed-in-email").first()).toHaveText(invitee);
      await expect(manager.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();

      const nav = manager.getByRole("navigation", { name: "Main" });
      await expect(nav.getByRole("link", { name: "Overview" })).toBeVisible();
      await expect(nav.getByRole("link", { name: "Connections" })).toHaveCount(0);
      await expect(nav.getByRole("link", { name: "Settings" })).toHaveCount(0);
      for (const path of ["/connections", "/settings", ...SETTINGS_NAV_ITEMS.map((item) => item.href)]) {
        await manager.goto(path);
        await expect(manager, path).toHaveURL("/forbidden");
      }
      expect(await (await manager.request.get("/api/me")).json()).toEqual({ email: invitee, role: "manager" });

      // A second session of theirs (signing in from the login page like any manager), used for API calls.
      const apiPage = await theirApi.newPage();
      await signIn(apiPage, invitee);
      expect((await apiPage.request.get("/api/me")).status()).toBe(200);

      // The owner can see that they have signed in.
      await page.reload();
      await expect(rowFor(page, invitee)).toContainText("Last signed in");

      // Remove them.
      await removeFromList(page, invitee);
      await expect(page.getByTestId("remove-notice")).toHaveText(`Removed ${invitee}. They no longer have access.`);
      await expect(rowFor(page, invitee)).toHaveCount(0);
      expect(await lookUp(invitee)).toBeNull();

      // Their very next API call and page view are refused, although their sessions are still valid.
      const refused = await apiPage.request.get("/api/me");
      expect(refused.status()).toBe(403);
      expect(await refused.json()).toEqual({ error: "forbidden" });
      await manager.goto("/overview");
      await expect(manager).toHaveURL("/login?error=access-denied");
      await expect(manager.getByText(/does not have access/)).toBeVisible();
    } finally {
      await theirBrowser.close();
      await theirApi.close();
    }
  });

  test("owners cannot be removed, and inviting someone already on the list changes nothing", async ({ page }) => {
    await signIn(page, run.ownerEmail);
    await page.goto(USERS_PATH);

    const ownerRow = rowFor(page, run.ownerEmail);
    await expect(ownerRow.getByText("owner", { exact: true })).toBeVisible();
    await expect(ownerRow.getByText("You", { exact: true })).toBeVisible();
    await expect(ownerRow.getByRole("button", { name: /Remove/ })).toHaveCount(0);
    await expect(rowFor(page, run.managerEmail).getByRole("button", { name: `Remove ${run.managerEmail}` })).toBeVisible();

    await invite(page, run.ownerEmail);
    await expect(page.getByTestId("invite-notice")).toHaveText(
      `${run.ownerEmail} already has access (owner). Nothing changed.`,
    );
    expect(await lookUp(run.ownerEmail)).toEqual({ email: run.ownerEmail, role: "owner" });

    await invite(page, run.managerEmail.toUpperCase());
    await expect(page.getByTestId("invite-notice")).toHaveText(
      `${run.managerEmail} already has access (manager). Nothing changed.`,
    );
  });

  test("if the invitation email cannot be sent, the invite still stands and the owner is told", async ({ page }) => {
    const invitee = email("unsent");
    await signIn(page, run.ownerEmail);
    await page.goto(USERS_PATH);
    // Warm up the invite action (a no-op invite), so the real one below is answered quickly.
    await invite(page, run.managerEmail);
    await expect(page.getByTestId("invite-notice")).toContainText("already has access");
    await page.getByLabel("Email").fill(invitee);

    // Supabase Auth refuses a second link to the same address within `max_frequency` (1s locally):
    // ask for one directly, then invite immediately, so the invitation email is refused.
    const auth = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await auth.auth.signInWithOtp({ email: invitee });
    expect(error).toBeNull();
    await page.getByRole("button", { name: "Invite manager" }).click();

    const notice = page.getByTestId("invite-notice");
    await expect(notice).toContainText(`${invitee} can now sign in, but the invitation email could not be sent`);
    await expect(notice).toContainText("/login with this email");
    await expect(rowFor(page, invitee)).toBeVisible();
    expect(await lookUp(invitee)).toEqual({ email: invitee, role: "manager" });
  });

  test("a manager cannot invite or remove anyone, even by calling the server actions directly", async ({
    page,
    browser,
    baseURL,
  }) => {
    const target = email("target");
    const intruder = email("intruder");
    await withRunDatabase((sql) => addAppUser(sql, target, "manager"));

    // Capture the owner's own invite and remove requests without letting them through.
    await signIn(page, run.ownerEmail);
    await page.goto(USERS_PATH);
    const inviteAction = await captureServerAction(page, () => invite(page, intruder));
    await page.goto(USERS_PATH);
    const removeAction = await captureServerAction(page, () => removeFromList(page, target));
    expect(await lookUp(intruder)).toBeNull();
    expect(await lookUp(target)).not.toBeNull();

    // Replayed from a manager's session: refused (sent to /forbidden), and nothing changes.
    const managerContext = await browser.newContext();
    try {
      const manager = await managerContext.newPage();
      await signIn(manager, run.managerEmail);
      for (const action of [inviteAction, removeAction]) {
        const response = await replay(manager, action, baseURL!);
        expect(response.headers()["x-action-redirect"] ?? response.headers().location).toMatch(/^\/forbidden/);
      }
      expect(await lookUp(intruder)).toBeNull();
      expect(await lookUp(target)).toEqual({ email: target, role: "manager" });
      expect(await countEmailsTo(intruder)).toBe(0);
    } finally {
      await managerContext.close();
    }

    // The very same requests from the owner's session go through, so the replay itself is sound.
    await replay(page, inviteAction, baseURL!);
    await replay(page, removeAction, baseURL!);
    expect(await lookUp(intruder)).toEqual({ email: intruder, role: "manager" });
    expect(await lookUp(target)).toBeNull();
  });

  test.describe("on a phone", () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    test("the users page fits the screen", async ({ page }) => {
      await withRunDatabase((sql) => addAppUser(sql, email("a-rather-long-manager-address-for-phones"), "manager"));
      await signIn(page, run.ownerEmail);
      await page.goto(USERS_PATH);
      await expect(page.getByRole("heading", { level: 2, name: "Users" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Invite manager" })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  });
});
