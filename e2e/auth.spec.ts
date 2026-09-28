import { expect, test } from "@playwright/test";

import { addAppUser, removeAppUser } from "../src/auth/allow-list";
import { NAV_ITEMS } from "../src/components/shell/nav-config";

import { requestMagicLink, signIn } from "./support/auth";
import { withRunDatabase } from "./support/db";
import { countEmailsTo } from "./support/mailpit";
import { run } from "./support/run";
import { passwordSession, useSessionInBrowser } from "./support/supabase";

test.describe("access control", () => {
  test("anonymous visitors are sent to sign in from every page, and API routes return 401", async ({
    page,
    request,
  }) => {
    for (const item of NAV_ITEMS) {
      await page.goto(`${item.href}?range=today`);
      await expect(page, `${item.href} should require sign-in`).toHaveURL(
        `/login?next=${encodeURIComponent(`${item.href}?range=today`)}`,
      );
    }
    await expect(page.getByRole("heading", { level: 1, name: "Kreloses Analytics" })).toBeVisible();

    const response = await request.get("/api/me");
    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
  });

  test("a non-allow-listed email is refused and no sign-in link is sent", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(run.strangerEmail);
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();

    await expect(page.getByText(/not on the access list/)).toBeVisible();
    await expect(page.getByText("Check your email")).toHaveCount(0);
    expect(await countEmailsTo(run.strangerEmail)).toBe(0);
  });

  test("the owner (seeded from OWNER_EMAIL) signs in with a magic link", async ({ page }) => {
    await signIn(page, run.ownerEmail);
    await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();

    // Session cookies are never readable from page scripts.
    const authCookies = (await page.context().cookies()).filter((cookie) => cookie.name.startsWith("sb-"));
    expect(authCookies.length).toBeGreaterThan(0);
    expect(authCookies.every((cookie) => cookie.httpOnly)).toBe(true);

    const me = await page.request.get("/api/me");
    expect(me.status()).toBe(200);
    expect(await me.json()).toEqual({ email: run.ownerEmail, role: "owner" });

    // Sign out ends the session.
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL("/login");
    await page.goto("/overview");
    await expect(page).toHaveURL("/login");
  });

  test("a magic link opened in another browser (e.g. on a phone) still signs in", async ({ page, browser }) => {
    const link = await requestMagicLink(page, run.ownerEmail);
    const phone = await browser.newContext();
    try {
      const phonePage = await phone.newPage();
      await phonePage.goto(link);
      await expect(phonePage).toHaveURL(/\/overview$/);
      await expect(phonePage.getByTestId("signed-in-email").first()).toHaveText(run.ownerEmail);
    } finally {
      await phone.close();
    }
  });

  test("an expired or reused magic link is rejected", async ({ page }) => {
    const link = await requestMagicLink(page, run.ownerEmail);
    await page.goto(link);
    await expect(page).toHaveURL(/\/overview$/);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL("/login");

    await page.goto(link);
    await expect(page).toHaveURL("/login?error=link-invalid");
    await expect(page.getByText(/invalid or has expired/)).toBeVisible();
  });

  test("a session that did not come from a magic link (a password sign-in) gets no access", async ({
    page,
    context,
    baseURL,
  }) => {
    const email = `e2e-password-${run.runId}@example.test`;
    await withRunDatabase((sql) => addAppUser(sql, email, "manager"));
    await useSessionInBrowser(context, await passwordSession(email, baseURL!), baseURL!);

    expect((await page.request.get("/api/me")).status()).toBe(401);
    await page.goto("/overview");
    await expect(page).toHaveURL("/login");
    await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toBeVisible();
  });

  test("the login page never redirects a signed-in user off-site via ?next=", async ({ page }) => {
    await signIn(page, run.ownerEmail);
    // A tab is stripped by browsers, so "/<tab>/evil.example" would become "//evil.example".
    for (const next of ["/%09/evil.example", "/..//evil.example", "/%2e%2e//evil.example", "/overview/..//evil.example"]) {
      const response = await page.request.get(`/login?next=${next}`, { maxRedirects: 0 });
      expect(response.status(), next).toBe(307);
      expect(response.headers().location, next).toBe("/overview");
    }
    await page.goto("/login?next=/..//evil.example");
    await expect(page).toHaveURL("/overview");
    await page.goto("/login?next=/doctors%3Frange%3Dtoday");
    await expect(page).toHaveURL("/doctors?range=today");
  });

  test("a manager cannot open owner-only pages", async ({ page }) => {
    await signIn(page, run.managerEmail);
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav.getByRole("link", { name: "Overview" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Connections" })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "Settings" })).toHaveCount(0);

    for (const path of ["/connections", "/settings", "/settings/users"]) {
      await page.goto(path);
      await expect(page, path).toHaveURL("/forbidden");
      await expect(page.getByText("Only the clinic owner can open that page")).toBeVisible();
    }
  });

  test("someone removed from the allow-list loses access on their next page view", async ({ page }) => {
    await signIn(page, run.managerEmail);
    await withRunDatabase((sql) => removeAppUser(sql, run.managerEmail));
    try {
      await page.goto("/daily");
      await expect(page).toHaveURL("/login?error=access-denied");
      await expect(page.getByText(/does not have access/)).toBeVisible();
      // The stale session was signed out.
      expect((await page.request.get("/api/me")).status()).toBe(401);
    } finally {
      await withRunDatabase((sql) => addAppUser(sql, run.managerEmail, "manager"));
    }
  });

  test("an API route refuses a signed-in user who is not on the allow-list with 403", async ({ page }) => {
    await signIn(page, run.managerEmail);
    await withRunDatabase((sql) => removeAppUser(sql, run.managerEmail));
    try {
      const response = await page.request.get("/api/me");
      expect(response.status()).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden" });
    } finally {
      await withRunDatabase((sql) => addAppUser(sql, run.managerEmail, "manager"));
    }
  });
});
