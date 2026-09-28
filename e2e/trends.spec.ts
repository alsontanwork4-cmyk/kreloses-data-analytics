import { readFile } from "node:fs/promises";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { clinicToday } from "../src/filters";
import { SYNTHETIC_ACCOUNTS } from "../src/kreloses/testing/synthetic-accounts";

import { signIn } from "./support/auth";
import { addConnection, syncMonth } from "./support/connections";
import { clearSyncedData, withRunDatabase } from "./support/db";
import { run } from "./support/run";

/**
 * Trends and doctor detail, end to end: "Sync now" reads September 2025, August 2026 and
 * September 2026 from the fake Kreloses (shared synthetic fixtures; credited figures hand-computed
 * in src/analytics/doctors.test.ts and trends.test.ts) → the Trends page draws one line per doctor
 * (toggleable), switches measure and branch in the URL, and shows year on year → clicking a doctor's
 * point opens their detail page with the same numbers.
 *
 * Doctors' credited revenue (customers):
 *   Aug 2026  Dr Bravo Brown 1,300.00 (N C7 + S C8) · Dr Delta 800.00 (S C4) · Dr Alpha Anderson 500.00 (N C1)
 *   Sep 2026  Dr Bravo Brown 3,252.00 (N 2,155.85 C2 C3 · S 1,096.15 C5 C1: 700202's 100.00 refund deducted, #6) · Dr Alpha Anderson 1,654.35
 *             (N 1,500.50 C1 C2 · S 153.85 C1) · Dr Delta 480.00 (S C4)
 *   Sep 2025  Dr Alpha Anderson N 12,345.60 (C1) · Dr Bravo Brown S 654.40 (C5)
 * Every doctor line in September 2026 is on or before the 20th, so 2026's year-to-date figures do not
 * depend on the day the suite runs (from 21 Sep 2026 on).
 */
const { both } = SYNTHETIC_ACCOUNTS;
const AUG_SEP = "from=2026-08-01&to=2026-09-30";

const rows = (table: Locator) => table.getByTestId("data-table-row");
const cell = (row: Locator, column: string) => row.locator(`[data-column="${column}"]`);

/** Each row's cells, by column key, as shown. */
async function tableText(table: Locator, columns: string[]): Promise<string[][]> {
  const result: string[][] = [];
  for (const row of await rows(table).all()) {
    result.push(await Promise.all(columns.map(async (column) => (await cell(row, column).innerText()).replace(/\s+/g, " ").trim())));
  }
  return result;
}

async function downloadCsv(page: Page, table: Locator): Promise<{ name: string; text: string }> {
  const [download] = await Promise.all([page.waitForEvent("download"), table.getByRole("button", { name: "Export CSV" }).click()]);
  return { name: download.suggestedFilename(), text: await readFile((await download.path())!, "utf8") };
}

const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test.describe("Trends → doctor detail", () => {
  test.beforeEach(clearSyncedData);
  test.afterAll(clearSyncedData);

  test("the owner sees monthly lines per doctor, switches measure and branch, compares years and opens a doctor", async ({ page, browser }) => {
    test.setTimeout(240_000);
    await signIn(page, run.ownerEmail);
    const card = await addConnection(page, { label: "Both branches", email: both.email, password: both.password });
    for (const month of ["September 2025", "August 2026", "September 2026"]) await syncMonth(card, month);
    await expect(card.getByRole("status")).toContainText("Synced September 2026");

    // Monthly revenue per doctor, highest total first.
    await page.goto(`/trends?${AUG_SEP}`);
    await expect(page.getByRole("heading", { level: 1, name: "Trends" })).toBeVisible();
    const table = page.getByTestId("trend-table");
    const months = ["doctor", "m2026-08", "m2026-09", "total"];
    expect(await tableText(table, months)).toEqual([
      ["Dr Bravo Brown", "RM 1,300.00", "RM 3,252.00", "RM 4,552.00"],
      ["Dr Alpha Anderson", "RM 500.00", "RM 1,654.35", "RM 2,154.35"],
      ["Dr Delta Not in staff list", "RM 800.00", "RM 480.00", "RM 1,280.00"],
    ]);
    const csv = await downloadCsv(page, table);
    expect(csv.name).toBe("trends-revenue_2026-08-01_to_2026-09-30.csv");
    expect(csv.text.split("\r\n").slice(1)).toEqual([
      "Dr Bravo Brown,1300.00,3252.00,4552.00",
      "Dr Alpha Anderson,500.00,1654.35,2154.35",
      "Dr Delta,800.00,480.00,1280.00",
      "",
    ]);

    // The chart: one line per doctor, with a summary for screen readers; each line can be hidden.
    const chart = page.getByTestId("trend-chart");
    await expect(chart.getByRole("img", { name: /^Monthly revenue by doctor, Aug 2026 to Sep 2026: Dr Bravo Brown: Aug 2026 RM 1,300\.00, Sep 2026 RM 3,252\.00; Dr Alpha Anderson: Aug 2026 RM 500\.00, Sep 2026 RM 1,654\.35; Dr Delta: Aug 2026 RM 800\.00, Sep 2026 RM 480\.00$/ })).toBeVisible();
    await expect(chart.locator(".recharts-line")).toHaveCount(3);
    const legend = chart.getByRole("group", { name: "Show or hide lines" });
    await legend.getByRole("button", { name: "Dr Delta" }).click();
    await expect(legend.getByRole("button", { name: "Dr Delta" })).toHaveAttribute("aria-pressed", "false");
    await expect(chart.locator(".recharts-line")).toHaveCount(2);
    await legend.getByRole("button", { name: "Show all" }).click();
    await expect(chart.locator(".recharts-line")).toHaveCount(3);

    // Measure switch (URL state): AOV per customer = the month's revenue ÷ that month's customers.
    await page.getByRole("navigation", { name: "Measure" }).getByRole("link", { name: "AOV per customer" }).click();
    await expect(page).toHaveURL(/[?&]measure=aov/);
    await expect(chart.getByText("Monthly AOV per customer by doctor", { exact: true })).toBeVisible();
    expect(await tableText(table, months)).toEqual([
      ["Dr Bravo Brown", "RM 650.00", "RM 813.00", "RM 758.67"], // whole period: 4,552.00 ÷ 6 customers
      ["Dr Alpha Anderson", "RM 500.00", "RM 827.18", "RM 1,077.18"],
      ["Dr Delta Not in staff list", "RM 800.00", "RM 480.00", "RM 1,280.00"],
    ]);

    // Branch switch (the global branch filter, URL state); the measure is kept.
    await page.getByRole("navigation", { name: "Branch" }).getByRole("link", { name: "Branch South" }).click();
    await expect(page).toHaveURL(/[?&]branch=\d+/);
    await expect(page).toHaveURL(/[?&]measure=aov/);
    await expect(page.getByRole("region", { name: "Filters" }).getByRole("combobox", { name: "Branch" })).toHaveValue(/\d+/);
    expect(await tableText(table, months)).toEqual([
      ["Dr Bravo Brown", "RM 300.00", "RM 548.08", "RM 465.38"],
      ["Dr Delta Not in staff list", "RM 800.00", "RM 480.00", "RM 1,280.00"],
      ["Dr Alpha Anderson", "—", "RM 153.85", "RM 153.85"],
    ]);

    // Year on year per doctor and branch (whole years; the date range does not apply).
    await page.goto(`/trends?${AUG_SEP}`);
    const yoy = page.getByTestId("year-on-year");
    expect(await tableText(yoy, ["doctor", "branch", "rev-2025", "rev-2026", "revchg-2026"])).toEqual([
      ["Dr Alpha Anderson", "All branches", "RM 12,345.60", "RM 2,154.35", "−82.5%"], // −10,191.25 ÷ 12,345.60
      ["Dr Alpha Anderson", "Branch North", "RM 12,345.60", "RM 2,000.50", "−83.8%"],
      ["Dr Alpha Anderson", "Branch South", "RM 0.00", "RM 153.85", "—"],
      ["Dr Bravo Brown", "All branches", "RM 654.40", "RM 4,552.00", "+595.6%"],
      ["Dr Bravo Brown", "Branch North", "RM 0.00", "RM 3,155.85", "—"],
      ["Dr Bravo Brown", "Branch South", "RM 654.40", "RM 1,396.15", "+113.3%"],
      ["Dr Delta Not in staff list", "Branch South", "RM 0.00", "RM 1,280.00", "—"],
    ]);

    // Clicking Dr Alpha Anderson's September point opens their detail page, filter kept.
    const alphaHref = await table.getByRole("link", { name: "Dr Alpha Anderson" }).getAttribute("href");
    const alphaId = /^\/doctors\/(\d+)\?/.exec(alphaHref ?? "")![1]!;
    await chart.locator(`[data-testid="trend-point"][data-series="${alphaId}"]`).last().click();
    await expect(page).toHaveURL(new RegExp(`/doctors/${alphaId}\\?${AUG_SEP}$`));
    await expect(page.getByRole("heading", { level: 1, name: "Dr Alpha Anderson" })).toBeVisible();
    const stat = (testId: string) => page.getByTestId(testId).getByTestId("stat-value");
    await expect(stat("doctor-revenue")).toHaveText("RM 2,154.35"); // = the Trends table's whole period
    await expect(stat("doctor-aov")).toHaveText("RM 1,077.18");
    await expect(stat("doctor-invoices")).toHaveText("4");
    await expect(stat("doctor-items")).toHaveText("2.00");
    await expect(stat("doctor-share")).toHaveText("25.8%"); // of all revenue in Aug–Sep 2026: 8,355.40
    await expect(stat("doctor-customers")).toHaveText("2");
    expect(await tableText(page.getByTestId("doctor-months"), ["revenue", "aov", "invoices", "customers"])).toEqual([
      ["RM 500.00", "RM 500.00", "1", "1"],
      ["RM 1,654.35", "RM 827.18", "3", "2"],
    ]);
    expect(await tableText(page.getByTestId("doctor-branches"), ["branch", "revenue", "aov", "invoices"])).toEqual([
      ["Branch North", "RM 2,000.50", "RM 1,000.25", "3"],
      ["Branch South", "RM 153.85", "RM 153.85", "1"],
    ]);
    await expect(page.getByTestId("doctor-trend-chart").locator(".recharts-line")).toHaveCount(1);

    // The page's own doctor never leaks into the global filter: a date preset, a custom range and the
    // way back to the ranking keep "all doctors".
    const filters = page.getByRole("region", { name: "Filters" });
    const mainNav = page.getByRole("navigation", { name: "Main" });
    await filters.getByRole("link", { name: "Year to date" }).click();
    await expect(page).toHaveURL(new RegExp(`/doctors/${alphaId}\\?range=year-to-date$`));
    await expect(page.getByRole("heading", { level: 1, name: "Dr Alpha Anderson" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to the doctor ranking" }).first()).toHaveAttribute("href", "/doctors?range=year-to-date");
    await expect(mainNav.getByRole("link", { name: "Overview" })).toHaveAttribute("href", "/overview?range=year-to-date");
    await filters.getByRole("button", { name: "Custom" }).click();
    await filters.getByLabel("From", { exact: true }).fill("2026-09-01");
    await filters.getByLabel("To", { exact: true }).fill("2026-09-30");
    await filters.getByRole("button", { name: "Apply" }).click();
    await expect(page).toHaveURL(new RegExp(`/doctors/${alphaId}\\?from=2026-09-01&to=2026-09-30$`));
    await expect(stat("doctor-revenue")).toHaveText("RM 1,654.35");
    await page.getByRole("link", { name: "Back to the doctor ranking" }).first().click();
    await expect(page).toHaveURL(/\/doctors\?from=2026-09-01&to=2026-09-30$/);
    await expect(rows(page.getByTestId("doctor-ranking"))).toHaveCount(3);
    await expect(filters.getByRole("combobox", { name: "Doctor" })).toHaveValue("");
    await page.goto(`/doctors/${alphaId}?${AUG_SEP}`);

    // The filter bar's doctor selector opens another doctor's page.
    await page.getByRole("region", { name: "Filters" }).getByRole("combobox", { name: "Doctor" }).selectOption({ label: "Dr Bravo Brown" });
    await expect(page.getByRole("heading", { level: 1, name: "Dr Bravo Brown" })).toBeVisible();
    await expect(stat("doctor-revenue")).toHaveText("RM 4,552.00");

    // From the Doctors ranking too; an alias-only doctor is flagged.
    await page.goto(`/doctors?${AUG_SEP}`);
    await page.getByTestId("doctor-ranking").getByRole("link", { name: "Dr Delta" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Dr Delta" })).toBeVisible();
    await expect(page.getByText("Not in staff list")).toBeVisible();
    await expect(stat("doctor-revenue")).toHaveText("RM 1,280.00");

    // An unknown id is a 404; a staff member who is not a doctor gets a page saying so.
    expect((await page.goto("/doctors/999999999"))?.status()).toBe(404);
    const [charlie] = await withRunDatabase((sql) => sql<{ id: string }[]>`select id::text from staff where full_name = 'Charlie Chen'`);
    await page.goto(`/doctors/${charlie!.id}?${AUG_SEP}`);
    await expect(page.getByRole("heading", { level: 2, name: "Charlie Chen is not a doctor" })).toBeVisible();

    // The year-on-year CSV is named after the years it covers (the date range does not apply to it): 2025 → today.
    await page.goto(`/trends?${AUG_SEP}`);
    const yoyCsv = await downloadCsv(page, yoy);
    expect(yoyCsv.name).toBe(`trends-year-on-year_2025-01-01_to_${clinicToday()}.csv`);
    expect(yoyCsv.text.split("\r\n")[1]).toMatch(/^Dr Alpha Anderson,All branches,12345\.60,/);
    // With several branches picked, a doctor's combined row is for the selected branches, not all of them.
    const branchIds = await withRunDatabase((sql) => sql<{ id: string }[]>`select id::text from branches order by id`);
    await page.goto(`/trends?${AUG_SEP}&branch=${branchIds.map((branch) => branch.id).join(",")}`);
    expect(await tableText(yoy, ["doctor", "branch"])).toEqual([
      ["Dr Alpha Anderson", "Selected branches"],
      ["Dr Alpha Anderson", "Branch North"],
      ["Dr Alpha Anderson", "Branch South"],
      ["Dr Bravo Brown", "Selected branches"],
      ["Dr Bravo Brown", "Branch North"],
      ["Dr Bravo Brown", "Branch South"],
      ["Dr Delta Not in staff list", "Branch South"],
    ]);

    // A manager sees the same pages.
    const managerContext = await browser.newContext();
    const manager = await managerContext.newPage();
    await signIn(manager, run.managerEmail);
    await manager.goto(`/trends?${AUG_SEP}`);
    await expect(rows(manager.getByTestId("trend-table"))).toHaveCount(3);
    await manager.goto(`/doctors/${alphaId}?${AUG_SEP}`);
    await expect(manager.getByTestId("doctor-revenue").getByTestId("stat-value")).toHaveText("RM 2,154.35");
    await managerContext.close();

    // On a phone: nothing scrolls sideways, and the line toggles are usable.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/trends?${AUG_SEP}`);
    await expect(chart.locator(".recharts-line")).toHaveCount(3);
    expect(await noSidewaysScroll(page)).toBeLessThanOrEqual(0);
    await legend.getByRole("button", { name: "Dr Bravo Brown" }).click();
    await expect(chart.locator(".recharts-line")).toHaveCount(2);
    await page.goto(`/doctors/${alphaId}?${AUG_SEP}`);
    await expect(stat("doctor-revenue")).toHaveText("RM 2,154.35");
    expect(await noSidewaysScroll(page)).toBeLessThanOrEqual(0);
  });
});
