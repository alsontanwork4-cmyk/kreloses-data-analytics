import { expect, test, type Locator, type Page } from "@playwright/test";

import { SYNTHETIC_ACCOUNTS } from "../src/kreloses/testing/synthetic-accounts";

import { signIn } from "./support/auth";
import { withRunDatabase } from "./support/db";
import { run } from "./support/run";

/**
 * The first end-to-end data path: "Sync now" on a connection reads a month of the fake Kreloses's
 * synthetic Sale List (src/kreloses/__fixtures__/sale-list-rows.json) → Sync status shows the run →
 * Overview shows the KPIs (hand-computed in src/analytics/overview.test.ts).
 */
const { both } = SYNTHETIC_ACCOUNTS;

/** Leaves the run's database as the other specs expect it: no sales, branches, runs or connections. */
async function clearSales() {
  await withRunDatabase(async (sql) => {
    await sql`delete from invoices`;
    await sql`delete from customers`;
    await sql`delete from sync_runs`;
    await sql`delete from branches`;
    await sql`delete from connections`;
  });
}

async function addConnection(page: Page, values: { label: string; email: string; password: string }): Promise<Locator> {
  await page.goto("/connections");
  await page.getByRole("button", { name: "Add connection" }).click();
  const form = page.getByRole("form", { name: "Add a Kreloses login" });
  await form.getByLabel("Name").fill(values.label);
  await form.getByLabel("Kreloses email").fill(values.email);
  await form.getByLabel("Kreloses password").fill(values.password);
  await form.getByRole("button", { name: "Save and test" }).click();
  await expect(form).toBeHidden();
  const card = page.getByRole("article", { name: values.label, exact: true });
  await expect(card.getByTestId("connection-status")).toHaveText("Connected");
  return card;
}

async function syncMonth(card: Locator, month: string) {
  await card.getByLabel("Month to sync").selectOption({ label: month });
  await card.getByRole("button", { name: "Sync now" }).click();
  await expect(card.getByRole("form", { name: "Sync sales" }).getByRole("button", { name: "Sync now" })).toBeEnabled({ timeout: 60_000 });
}

test.describe("Sync now → Sync status → Overview", () => {
  test.beforeEach(clearSales);
  test.afterAll(clearSales);

  test("the owner syncs two months and the Overview shows the expected KPIs", async ({ page }) => {
    await signIn(page, run.ownerEmail);
    const card = await addConnection(page, { label: "Both branches", email: both.email, password: both.password });

    await syncMonth(card, "August 2026");
    await expect(card.getByRole("status")).toHaveText("Synced August 2026: 5 invoices read (5 new, 0 changed, 0 unchanged).");
    await syncMonth(card, "September 2026");
    await expect(card.getByRole("status")).toHaveText("Synced September 2026: 11 invoices read (11 new, 0 changed, 0 unchanged).");
    // Again: nothing changes.
    await syncMonth(card, "September 2026");
    await expect(card.getByRole("status")).toHaveText("Synced September 2026: 11 invoices read (0 new, 0 changed, 11 unchanged).");

    // Sync status: every run, newest first, and how fresh each branch is.
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Sync status" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Sync status" })).toBeVisible();
    const runs = page.getByTestId("sync-run");
    await expect(runs).toHaveCount(3);
    const [latest, september, august] = [runs.nth(0), runs.nth(1), runs.nth(2)];
    for (const syncRun of [latest, september, august]) await expect(syncRun.getByTestId("sync-run-status")).toHaveText("Succeeded");
    await expect(latest.getByTestId("sync-run-unchanged")).toHaveText("11");
    await expect(september.getByTestId("sync-run-inserted")).toHaveText("11");
    await expect(september).toContainText("1 Sep 2026 – 30 Sep 2026");
    await expect(august.getByTestId("sync-run-seen")).toContainText("5");
    // "Data as of" here is for today, so it depends on whether the synced month includes today.
    await expect(page.getByTestId("branch-freshness")).toHaveText([/^Branch North/, /^Branch South/]);

    // Overview for September 2026.
    await page.goto("/overview?from=2026-09-01&to=2026-09-30");
    const value = (testId: string, within: Page | Locator = page) => within.getByTestId(testId).getByTestId("kpi-value");
    await expect(value("kpi-revenue")).toHaveText("RM 5,855.40");
    await expect(value("kpi-invoices")).toHaveText("9");
    await expect(value("kpi-customers")).toHaveText("5");
    await expect(value("kpi-aov")).toHaveText("RM 1,171.08");
    await expect(page.getByTestId("kpi-revenue").getByTestId("kpi-vs-previous")).toHaveText("+RM 3,555.40 (+154.6%) vs previous period");
    await expect(page.getByTestId("kpi-aov").getByTestId("kpi-vs-previous")).toHaveText("+RM 404.41 (+52.7%) vs previous period");
    // September 2025 was never synced: nothing to compare with.
    await expect(page.getByTestId("kpi-revenue").getByTestId("kpi-vs-last-year")).toHaveText("No sales in the same period last year");

    const branches = page.getByTestId("branch-kpis");
    await expect(branches).toHaveCount(2);
    const north = page.getByRole("article", { name: "Branch North" });
    const south = page.getByRole("article", { name: "Branch South" });
    await expect(value("branch-kpi-revenue", north)).toHaveText("RM 3,980.40");
    await expect(value("branch-kpi-customers", north)).toHaveText("3");
    await expect(value("branch-kpi-aov", north)).toHaveText("RM 1,326.80");
    await expect(value("branch-kpi-revenue", south)).toHaveText("RM 1,875.00");
    await expect(value("branch-kpi-invoices", south)).toHaveText("5");
    await expect(north.getByTestId("branch-data-as-of")).toHaveText(/^Data as of \d{1,2} \w{3} \d{4}, \d{2}:\d{2}$/);

    // The branch selector lists the synced branches and narrows every number.
    const branchSelect = page.getByRole("region", { name: "Filters" }).getByRole("combobox", { name: "Branch" });
    await expect(branchSelect).toBeEnabled();
    await branchSelect.selectOption({ label: "Branch North" });
    await expect(page).toHaveURL(/[?&]branch=\d+/);
    await expect(value("kpi-revenue")).toHaveText("RM 3,980.40");
    await expect(branches).toHaveCount(1);

    // On a phone, nothing scrolls sideways.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/overview?from=2026-09-01&to=2026-09-30");
    await expect(value("kpi-revenue")).toHaveText("RM 5,855.40");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await page.goto("/sync");
    await expect(page.getByTestId("sync-run")).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  });

  test("a manager sees the numbers but cannot start a sync, even by calling the action directly", async ({ page, browser }) => {
    await signIn(page, run.ownerEmail);
    const card = await addConnection(page, { label: "Both branches", email: both.email, password: both.password });

    // Capture the owner's real "Sync now" Server Action request.
    await card.getByLabel("Month to sync").selectOption({ label: "September 2026" });
    const [actionRequest] = await Promise.all([
      page.waitForRequest((request) => request.method() === "POST" && "next-action" in request.headers()),
      card.getByRole("button", { name: "Sync now" }).click(),
    ]);
    await expect(card.getByRole("status")).toContainText("Synced September 2026");
    const runCount = async () => (await withRunDatabase((sql) => sql`select 1 from sync_runs`)).length;
    expect(await runCount()).toBe(1);

    const replay = (as: Page) =>
      as.request.post("/connections", {
        headers: {
          "next-action": actionRequest.headers()["next-action"]!,
          "content-type": actionRequest.headers()["content-type"]!,
          accept: "text/x-component",
        },
        data: actionRequest.postData()!,
        maxRedirects: 0,
        timeout: 60_000,
      });

    const managerContext = await browser.newContext();
    try {
      const manager = await managerContext.newPage();
      await signIn(manager, run.managerEmail);
      await replay(manager);
      expect(await runCount()).toBe(1);

      // Control: the identical request from the owner does start a sync, so the refusal was the role check.
      await replay(page);
      expect(await runCount()).toBe(2);

      // ...but the manager does see the synced numbers and the run.
      await manager.goto("/overview?from=2026-09-01&to=2026-09-30");
      await expect(manager.getByTestId("kpi-revenue").getByTestId("kpi-value")).toHaveText("RM 5,855.40");
      await manager.goto("/sync");
      await expect(manager.getByTestId("sync-run")).toHaveCount(2);
    } finally {
      await managerContext.close();
    }
  });
});
