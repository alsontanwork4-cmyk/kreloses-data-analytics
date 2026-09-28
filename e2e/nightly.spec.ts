import { expect, test } from "@playwright/test";

import { SYNTHETIC_ACCOUNTS } from "../src/kreloses/testing/synthetic-accounts";

import { signIn } from "./support/auth";
import { addConnection } from "./support/connections";
import { clearSyncedData } from "./support/db";
import { run } from "./support/run";

/**
 * The nightly sync (#6), called as Vercel Cron calls it: `GET /api/cron/nightly` with
 * `Authorization: Bearer <CRON_SECRET>` (the suite's app gets a throwaway secret). A connection whose
 * nightly sync fails puts a banner on every page, for the owner (with a link to Connections) and for
 * managers (message only).
 */
const { both, brokenSaleList } = SYNTHETIC_ACCOUNTS;
const CRON = "/api/cron/nightly";
const cronSecret = () => {
  const secret = process.env.E2E_CRON_SECRET;
  if (!secret) throw new Error("E2E_CRON_SECRET is not set; run the suite with `npm run test:e2e`");
  return secret;
};

test.describe("Nightly sync (cron) and the failure banner", () => {
  test.beforeEach(clearSyncedData);
  test.afterAll(clearSyncedData);

  test("the cron endpoint answers 401 without the right bearer, and never redirects to sign-in", async ({ playwright, baseURL }) => {
    const anonymous = await playwright.request.newContext({ baseURL });
    try {
      const attempts: Record<string, string>[] = [
        {},
        { Authorization: "Bearer wrong-secret-0123456789" },
        { Authorization: `bearer ${cronSecret()}` },
        { Authorization: cronSecret() },
      ];
      for (const headers of attempts) {
        const response = await anonymous.get(CRON, { headers, maxRedirects: 0 });
        expect(response.status(), JSON.stringify(headers)).toBe(401);
        expect(await response.json()).toEqual({ error: "unauthorized" });
      }
    } finally {
      await anonymous.dispose();
    }
  });

  test("a failed nightly sync shows a banner with the last error: owners get a link to Connections, managers the message only", async ({ page, browser, playwright, baseURL }) => {
    await signIn(page, run.ownerEmail);
    await addConnection(page, { label: "Both branches", email: both.email, password: both.password });
    // Its login works (Connected), but its Sale List comes back in a layout the app does not know.
    await addConnection(page, { label: "Broken listing", email: brokenSaleList.email, password: brokenSaleList.password });
    await page.goto("/overview");
    await expect(page.getByTestId("sync-alert-banner")).toHaveCount(0);

    // Vercel Cron's call.
    const cron = await playwright.request.newContext({ baseURL });
    try {
      const response = await cron.get(CRON, { headers: { Authorization: `Bearer ${cronSecret()}` }, timeout: 120_000 });
      expect(response.status()).toBe(200);
      const body = (await response.json()) as { ok: boolean; connections: { connectionLabel: string; status: string; error: string | null }[] };
      expect(body.ok).toBe(true);
      expect(body.connections.map((connection) => [connection.connectionLabel, connection.status])).toEqual([
        ["Both branches", "succeeded"],
        ["Broken listing", "failed"],
      ]);
      expect(body.connections[1]!.error).toMatch(/Kreloses answered in a way the app does not recognise/);
    } finally {
      await cron.dispose();
    }

    // The owner: a banner on every page, with the error and a link to fix it.
    await page.goto("/overview");
    const banner = page.getByTestId("sync-alert-banner");
    await expect(banner.getByTestId("sync-alert")).toHaveCount(1);
    await expect(banner).toContainText("The nightly sync of “Broken listing” failed.");
    await expect(banner.getByTestId("sync-alert-message")).toContainText("Kreloses answered in a way the app does not recognise");
    await page.goto("/doctors");
    await expect(page.getByTestId("sync-alert-banner")).toContainText("Broken listing");
    await page.getByTestId("sync-alert-banner").getByRole("link", { name: "Check the connection" }).click();
    await expect(page).toHaveURL(/\/connections$/);

    // Sync status: the nightly runs with their kind and outcome.
    await page.goto("/sync");
    const runs = page.getByTestId("sync-run");
    await expect(runs).toHaveCount(2);
    const broken = page.getByRole("article", { name: "Broken listing sync" });
    await expect(broken.getByTestId("sync-run-mode")).toHaveText("Nightly");
    await expect(broken.getByTestId("sync-run-status")).toHaveText("Failed");
    await expect(broken.getByTestId("sync-run-error")).toContainText("Kreloses answered in a way the app does not recognise");
    const fine = page.getByRole("article", { name: "Both branches sync" });
    await expect(fine.getByTestId("sync-run-mode")).toHaveText("Nightly");
    await expect(fine.getByTestId("sync-run-status")).toHaveText("Succeeded");

    // On a phone the banner fits (nothing scrolls sideways).
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/overview");
    await expect(page.getByTestId("sync-alert")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

    // A manager sees the same message, without the link (Connections is the owner's).
    const managerContext = await browser.newContext();
    try {
      const manager = await managerContext.newPage();
      await signIn(manager, run.managerEmail);
      const managerBanner = manager.getByTestId("sync-alert-banner");
      await expect(managerBanner.getByTestId("sync-alert-message")).toContainText("Kreloses answered in a way the app does not recognise");
      await expect(managerBanner.getByRole("link")).toHaveCount(0);
      await expect(managerBanner).toContainText("The clinic owner can fix it on the Connections page.");
    } finally {
      await managerContext.close();
    }
  });
});
