import { expect, test, type Locator, type Page } from "@playwright/test";

import { SYNTHETIC_ACCOUNTS } from "../src/kreloses/testing/synthetic-accounts";

import { signIn } from "./support/auth";
import { withRunDatabase } from "./support/db";
import { run } from "./support/run";

/**
 * Connections page against the fake Kreloses (e2e/support/fake-kreloses-server.ts): every save
 * really logs in over HTTP, through the Reader, to synthetic www/sea endpoints.
 */
const { north, south, oneTimeCode, down } = SYNTHETIC_ACCOUNTS;

function card(page: Page, label: string): Locator {
  return page.getByRole("article", { name: label, exact: true });
}

async function addConnection(page: Page, values: { label: string; email: string; password: string }) {
  await page.getByRole("button", { name: "Add connection" }).click();
  const form = page.getByRole("form", { name: "Add a Kreloses login" });
  await form.getByLabel("Name").fill(values.label);
  await form.getByLabel("Kreloses email").fill(values.email);
  await form.getByLabel("Kreloses password").fill(values.password);
  await form.getByRole("button", { name: "Save and test" }).click();
  await expect(form).toBeHidden();
}

async function deleteConnection(page: Page, label: string) {
  const connection = card(page, label);
  await connection.getByRole("button", { name: "Delete" }).click();
  await connection.getByRole("button", { name: "Delete connection" }).click();
  await expect(connection).toBeHidden();
}

test.describe("Kreloses connections", () => {
  test.beforeEach(async ({ page }) => {
    await withRunDatabase((sql) => sql`delete from connections`);
    await signIn(page, run.ownerEmail);
    await page.goto("/connections");
    await expect(page.getByRole("heading", { level: 1, name: "Connections" })).toBeVisible();
  });

  test.afterAll(async () => {
    // Leave the run's database as the other specs expect it (no connections).
    await withRunDatabase((sql) => sql`delete from connections`);
  });

  test("the owner adds, tests, edits and deletes Kreloses logins", async ({ page }) => {
    await expect(page.getByTestId("empty-state")).toBeVisible();

    // A working login: saved, tested, and shows the branch it can see.
    await addConnection(page, { label: "Branch North", email: north.email, password: north.password });
    await expect(page.getByRole("status")).toHaveText("Saved “Branch North”. The login works and can see 1 branch.");
    const northCard = card(page, "Branch North");
    await expect(northCard.getByTestId("connection-status")).toHaveText("Connected");
    await expect(northCard.getByTestId("connection-email")).toHaveText(north.email);
    await expect(northCard.getByTestId("connection-branches")).toHaveText("Branch North");
    await expect(northCard.getByTestId("connection-tested-at")).not.toHaveText("Not yet");
    await expect(page.getByTestId("empty-state")).toHaveCount(0);

    // A second login with a wrong password is still saved, with a clear reason.
    await addConnection(page, { label: "Branch South", email: south.email, password: "not-the-password" });
    await expect(page.getByRole("status")).toContainText("Saved “Branch South”, but the login test failed");
    const southCard = card(page, "Branch South");
    await expect(southCard.getByTestId("connection-status")).toHaveText("Login failed");
    await expect(southCard.getByTestId("connection-error")).toContainText("Kreloses rejected this email or password.");
    await expect(southCard.getByTestId("connection-branches")).toHaveText("Unknown until the login works");
    await expect(page.getByTestId("connection")).toHaveCount(2);

    // Fix it: the password field starts empty; the new password is tested on save.
    await southCard.getByRole("button", { name: "Edit" }).click();
    const southForm = southCard.getByRole("form", { name: "Edit Branch South" });
    await expect(southForm.getByLabel("Kreloses email")).toHaveValue(south.email);
    await expect(southForm.getByLabel("Kreloses password")).toHaveValue("");
    await southForm.getByLabel("Kreloses password").fill(south.password);
    await southForm.getByRole("button", { name: "Save and test" }).click();
    await expect(southCard.getByTestId("connection-status")).toHaveText("Connected");
    await expect(southCard.getByTestId("connection-branches")).toHaveText("Branch South");
    await expect(southCard.getByTestId("connection-error")).toHaveCount(0);

    // Rename with a blank password: the saved password is kept and still works.
    await northCard.getByRole("button", { name: "Edit" }).click();
    const northForm = northCard.getByRole("form", { name: "Edit Branch North" });
    await northForm.getByLabel("Name").fill("Branch North (main)");
    await northForm.getByRole("button", { name: "Save and test" }).click();
    const renamed = card(page, "Branch North (main)");
    await expect(renamed.getByTestId("connection-status")).toHaveText("Connected");
    await expect(renamed.getByRole("status")).toHaveText("Saved “Branch North (main)”. The login works and can see 1 branch.");

    // "Test again" logs in again and updates the time.
    const testedAt = renamed.getByTestId("connection-tested-at");
    const before = await testedAt.textContent();
    await page.waitForTimeout(1_100); // the time is shown to the second
    await renamed.getByRole("button", { name: "Test again" }).click();
    await expect(testedAt).not.toHaveText(before!);
    await expect(renamed.getByTestId("connection-status")).toHaveText("Connected");

    // Passwords (and their ciphertexts) never reach the browser: not in the page's HTML or RSC payload.
    const ciphertexts = await withRunDatabase((sql) => sql<{ passwordCiphertext: string }[]>`select password_ciphertext from connections`);
    expect(ciphertexts).toHaveLength(2);
    const html = await (await page.request.get("/connections")).text();
    const rsc = await (await page.request.get("/connections", { headers: { RSC: "1" } })).text();
    for (const secret of [north.password, south.password, ...ciphertexts.map((row) => row.passwordCiphertext)]) {
      expect(html).not.toContain(secret);
      expect(rsc).not.toContain(secret);
    }
    // ...and the stored value is an encrypted envelope, not the password.
    for (const row of ciphertexts) expect(row.passwordCiphertext).toMatch(/^v1\.[0-9a-f]{8}\./);

    // Delete asks for confirmation; Cancel keeps the connection.
    await southCard.getByRole("button", { name: "Delete" }).click();
    await expect(southCard.getByText("Delete “Branch South”?")).toBeVisible();
    await southCard.getByRole("button", { name: "Cancel" }).click();
    await expect(southCard).toBeVisible();

    await deleteConnection(page, "Branch South");
    await deleteConnection(page, "Branch North (main)");
    await expect(page.getByTestId("empty-state")).toBeVisible();
    expect(await withRunDatabase((sql) => sql`select 1 from connections`)).toHaveLength(0);
  });

  test("an extra login step and an unreachable Kreloses each get their own message", async ({ page }) => {
    await addConnection(page, { label: "Two-step login", email: oneTimeCode.email, password: oneTimeCode.password });
    const otp = card(page, "Two-step login");
    await expect(otp.getByTestId("connection-status")).toHaveText("Login failed");
    await expect(otp.getByTestId("connection-error")).toContainText("Kreloses asked for a one-time code");

    await addConnection(page, { label: "Offline branch", email: down.email, password: down.password });
    const offline = card(page, "Offline branch");
    await expect(offline.getByTestId("connection-status")).toHaveText("Login failed");
    await expect(offline.getByTestId("connection-error")).toContainText("Kreloses is having problems right now (it answered HTTP 503");
  });

  test("the form explains what is missing and never echoes the password", async ({ page }) => {
    await addConnection(page, { label: "Branch North", email: north.email, password: north.password });

    await page.getByRole("button", { name: "Add connection" }).click();
    const form = page.getByRole("form", { name: "Add a Kreloses login" });
    await form.getByLabel("Name").fill("Duplicate");
    await form.getByLabel("Kreloses email").fill(north.email.toUpperCase());
    await form.getByLabel("Kreloses password").fill("typed-secret-123");
    await form.getByRole("button", { name: "Save and test" }).click();

    await expect(form.getByText("There is already a connection for this Kreloses login.")).toBeVisible();
    await expect(form.getByLabel("Name")).toHaveValue("Duplicate");
    await expect(form.getByLabel("Kreloses password")).toHaveValue("");
    expect(await page.content()).not.toContain("typed-secret-123");
    await form.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("connection")).toHaveCount(1);
  });

  test("the connection actions refuse a manager even when called directly", async ({ page, browser }) => {
    await addConnection(page, { label: "Keep me", email: north.email, password: north.password });
    await addConnection(page, { label: "Throwaway", email: south.email, password: south.password });
    const ids = await withRunDatabase((sql) => sql<{ id: string; label: string }[]>`select id::text as id, label from connections`);
    const keepId = ids.find((row) => row.label === "Keep me")!.id;
    const throwawayId = ids.find((row) => row.label === "Throwaway")!.id;

    // Capture the real Server Action request the owner's "Delete connection" sends.
    const throwaway = card(page, "Throwaway");
    await throwaway.getByRole("button", { name: "Delete" }).click();
    const [actionRequest] = await Promise.all([
      page.waitForRequest((request) => request.method() === "POST" && "next-action" in request.headers()),
      throwaway.getByRole("button", { name: "Delete connection" }).click(),
    ]);
    await expect(throwaway).toBeHidden();
    const body = actionRequest.postData()!;
    expect(body).toContain(throwawayId);
    const replay = (as: Page) =>
      as.request.post("/connections", {
        headers: {
          "next-action": actionRequest.headers()["next-action"]!,
          "content-type": actionRequest.headers()["content-type"]!,
          accept: "text/x-component",
        },
        data: body.replace(`\r\n\r\n${throwawayId}\r\n`, `\r\n\r\n${keepId}\r\n`),
        maxRedirects: 0,
      });
    const remaining = () => withRunDatabase((sql) => sql`select 1 from connections where id = ${keepId}`);

    // The same request from a signed-in manager is refused: nothing is deleted.
    const managerContext = await browser.newContext();
    try {
      const manager = await managerContext.newPage();
      await signIn(manager, run.managerEmail);
      await replay(manager);
      expect(await remaining()).toHaveLength(1);
    } finally {
      await managerContext.close();
    }

    // Control: the identical request from the owner does delete it, so the refusal was the role check.
    await replay(page);
    expect(await remaining()).toHaveLength(0);
  });

  test.describe("on a phone", () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    test("a connection card fits without sideways scrolling", async ({ page }) => {
      await addConnection(page, { label: "Branch North", email: north.email, password: north.password });
      await expect(card(page, "Branch North").getByTestId("connection-status")).toHaveText("Connected");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  });
});
