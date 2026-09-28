import { expect, test, type APIRequestContext } from "@playwright/test";

import { SYNTHETIC_ACCOUNTS } from "../src/kreloses/testing/synthetic-accounts";

import { signIn } from "./support/auth";
import { addConnection } from "./support/connections";
import { clearSyncedData } from "./support/db";
import { run } from "./support/run";

/**
 * The history backfill (#8), called as the GitHub Actions workflow calls it: `GET /api/cron/backfill`
 * with `Authorization: Bearer <CRON_SECRET>`. The suite's app has the clinic clock fixed at 09:00 KL
 * (`CLINIC_NOW`), a night window of 08:00–10:00 so that is "tonight", a budget of 50 Kreloses requests
 * per login per night (one call stops at it) and a 0.5 s pause between requests (playwright.config.ts).
 * The fake Kreloses serves the shared synthetic sales (Sep–Oct 2025, Aug–Sep 2026).
 */
const { both } = SYNTHETIC_ACCOUNTS;
const BACKFILL = "/api/cron/backfill";
const cronSecret = () => {
  const secret = process.env.E2E_CRON_SECRET;
  if (!secret) throw new Error("E2E_CRON_SECRET is not set; run the suite with `npm run test:e2e`");
  return secret;
};

interface BackfillAnswer {
  ok: boolean;
  inWindow: boolean;
  connections: { connectionLabel: string; status: string; reason?: string; stoppedBy?: string; requests?: number; monthsCompleted?: number }[];
}

async function callBackfill(request: APIRequestContext): Promise<BackfillAnswer> {
  const response = await request.get(BACKFILL, { headers: { Authorization: `Bearer ${cronSecret()}` }, timeout: 120_000 });
  expect(response.status()).toBe(200);
  return (await response.json()) as BackfillAnswer;
}

test.describe("History backfill", () => {
  test.beforeEach(clearSyncedData);
  test.afterAll(clearSyncedData);

  test("the backfill endpoint answers 401 without the right bearer, and never redirects to sign-in", async ({ playwright, baseURL }) => {
    const anonymous = await playwright.request.newContext({ baseURL });
    try {
      for (const headers of [{}, { Authorization: "Bearer wrong-secret-0123456789" }, { Authorization: `bearer ${cronSecret()}` }, { Authorization: cronSecret() }] as Record<string, string>[]) {
        const response = await anonymous.get(BACKFILL, { headers, maxRedirects: 0 });
        expect(response.status(), JSON.stringify(headers)).toBe(401);
        expect(await response.json()).toEqual({ error: "unauthorized" });
      }
    } finally {
      await anonymous.dispose();
    }
  });

  test("starts by itself on a new connection, loads in chunks within tonight's budget, shows progress, and the owner can pause and start it", async ({
    page,
    browser,
    playwright,
    baseURL,
  }) => {
    test.setTimeout(180_000);
    await signIn(page, run.ownerEmail);
    const card = await addConnection(page, { label: "Both branches", email: both.email, password: both.password });
    // The first successful login test asked for the history: it waits for the night window.
    await expect(card.getByTestId("connection-backfill")).toContainText("History backfill starts tonight (from January 2024).");

    await page.goto("/sync");
    const backfill = page.getByRole("article", { name: "Both branches", exact: true }).filter({ has: page.getByTestId("backfill-status") });
    await expect(backfill.getByTestId("backfill-status")).toHaveText("Starts tonight");
    await expect(backfill.getByTestId("backfill-months")).toHaveText("0 of 33 (starts with September 2026)");
    await expect(backfill.getByTestId("backfill-invoices")).toHaveText("0 invoices (total not known yet)");

    const cron = await playwright.request.newContext({ baseURL });
    try {
      // One chunk: newest month first, until tonight's 50 requests are used.
      const first = await callBackfill(cron);
      expect(first).toMatchObject({ ok: true, inWindow: true });
      expect(first.connections).toEqual([
        expect.objectContaining({ connectionLabel: "Both branches", status: "ran", stoppedBy: "request_limit", requests: 50 }),
      ]);
      const monthsDone = first.connections[0]!.monthsCompleted!;
      expect(monthsDone).toBeGreaterThan(0);

      await page.reload();
      await expect(backfill.getByTestId("backfill-status")).toHaveText("Loading history");
      await expect(backfill.getByTestId("backfill-months")).toContainText(`${monthsDone} of 33`);
      await expect(backfill.getByTestId("backfill-requests")).toHaveText("50 of 50");
      await expect(backfill.getByTestId("backfill-invoices")).toContainText(/^\d+ of about \d+ invoices$/);
      await expect(backfill.getByTestId("backfill-percent")).toHaveText(/^\d+%$/);
      await expect(backfill.getByRole("progressbar")).toBeVisible();
      await expect(backfill.getByTestId("backfill-nights")).toHaveText(/^about \d+ nights?$/);
      // Its runs (one per month) are listed apart (the latest 20), with the Kreloses requests each
      // sent, so they never push the nightly and Sync now runs off the page.
      const backfillRuns = page.getByTestId("backfill-runs");
      await backfillRuns.locator("summary").click();
      const monthRuns = backfillRuns.getByTestId("sync-run");
      await expect(monthRuns).toHaveCount(Math.min(monthsDone, 20));
      await expect(monthRuns.first().getByTestId("sync-run-mode")).toHaveText("History backfill");
      await expect(monthRuns.first().getByTestId("sync-run-requests")).toHaveText(/^\d+$/);
      await expect(page.getByRole("list", { name: "Sync runs", exact: true })).toHaveCount(0);
      await expect(page.getByText("No nightly sync or Sync now has run yet")).toBeVisible();

      // Budget spent: the next call tonight does nothing.
      expect((await callBackfill(cron)).connections).toEqual([expect.objectContaining({ status: "idle", reason: "budget_spent" })]);

      // The Connections page shows it in one line.
      await page.goto("/connections");
      await expect(page.getByRole("article", { name: "Both branches", exact: true }).getByTestId("connection-backfill")).toContainText(
        new RegExp(`Loading history: \\d+% of invoices, ${monthsDone} of 33 months`),
      );

      // Pause: chunks leave it alone. Start: it carries on (the budget still applies tonight).
      await page.goto("/sync");
      await backfill.getByRole("button", { name: "Pause backfill" }).click();
      await expect(backfill.getByTestId("backfill-status")).toHaveText("Paused");
      expect((await callBackfill(cron)).connections).toEqual([]);
      await backfill.getByRole("button", { name: "Start backfill" }).click();
      await expect(backfill.getByTestId("backfill-status")).toHaveText("Loading history");
      await expect(backfill.getByTestId("backfill-months")).toContainText(`${monthsDone} of 33`);
    } finally {
      await cron.dispose();
    }

    // On a phone nothing scrolls sideways.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(backfill.getByTestId("backfill-status")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

    // A manager sees the progress, without the owner's controls.
    const managerContext = await browser.newContext();
    try {
      const manager = await managerContext.newPage();
      await signIn(manager, run.managerEmail);
      await manager.goto("/sync");
      const managerCard = manager.getByRole("article", { name: "Both branches", exact: true }).filter({ has: manager.getByTestId("backfill-status") });
      await expect(managerCard.getByTestId("backfill-status")).toHaveText("Loading history");
      await expect(managerCard.getByRole("button")).toHaveCount(0);
    } finally {
      await managerContext.close();
    }
  });
});
