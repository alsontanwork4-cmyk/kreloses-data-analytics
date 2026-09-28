import { readFile } from "node:fs/promises";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { SYNTHETIC_ACCOUNTS } from "../src/kreloses/testing/synthetic-accounts";

import { signIn } from "./support/auth";
import { addConnection, syncMonth } from "./support/connections";
import { clearSyncedData } from "./support/db";
import { run } from "./support/run";

/**
 * Line items → doctor credit, end to end: "Sync now" reads September 2026's invoices AND their
 * line items from the fake Kreloses → the Doctors page ranks the doctors with the figures
 * hand-computed in src/analytics/doctors.test.ts → the CSV export has the same numbers → the doctor
 * filter narrows the Overview → remapping a name / changing a kind in Settings → Doctors changes
 * the ranking at once, without another sync.
 */
const { both } = SYNTHETIC_ACCOUNTS;
const SEPTEMBER = "from=2026-09-01&to=2026-09-30";

const ranking = (page: Page) => page.getByTestId("doctor-ranking");
const rows = (table: Locator) => table.getByTestId("data-table-row");
const cell = (row: Locator, column: string) => row.locator(`[data-column="${column}"]`);
/** The row whose `column` cell starts with `name` (other cells, e.g. dropdowns, may mention it too). */
const rowWhere = (table: Locator, column: string, name: string) =>
  rows(table).filter({ has: table.page().locator(`[data-column="${column}"]`, { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }) });

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

test.describe("Line items → Doctors page", () => {
  test.beforeEach(clearSyncedData);
  test.afterAll(clearSyncedData);

  test("the owner syncs a month, sees the doctor ranking, exports it, filters by doctor and corrects a name", async ({ page }) => {
    await signIn(page, run.ownerEmail);
    const card = await addConnection(page, { label: "Both branches", email: both.email, password: both.password });
    await syncMonth(card, "September 2026");
    await expect(card.getByRole("status")).toHaveText(
      "Synced September 2026: 11 invoices read (11 new, 0 changed, 0 unchanged); line items read for 9 invoices.",
    );

    // The ranking: doctors only, highest revenue first.
    await page.goto(`/doctors?${SEPTEMBER}`);
    await expect(page.getByRole("heading", { level: 1, name: "Doctors" })).toBeVisible();
    await expect(page.getByTestId("total-revenue")).toHaveText("All revenue in this period: RM 5,855.40");
    const columns = ["doctor", "revenue", "share", "aov", "invoices", "items", "customers"];
    await expect(rows(ranking(page))).toHaveCount(3);
    expect(await tableText(ranking(page), columns)).toEqual([
      ["Dr Bravo Brown", "RM 3,351.72", "57.2%", "RM 837.93", "4", "1.50", "4"],
      ["Dr Alpha Anderson", "RM 1,654.35", "28.3%", "RM 827.18", "3", "2.00", "2"],
      ["Dr Delta Not in staff list", "RM 480.00", "8.2%", "RM 480.00", "2", "1.50", "1"],
    ]);
    await expect(page.getByRole("img", { name: /^Revenue by doctor: Dr Bravo Brown RM 3,351\.72; Dr Alpha Anderson RM 1,654\.35; Dr Delta RM 480\.00$/ })).toBeVisible();
    await expect(page.getByTestId("doctor-revenue-chart").locator(".recharts-bar-rectangle")).toHaveCount(3);
    // Non-doctors are grouped apart, never ranked.
    expect(await tableText(page.getByTestId("staff-groups"), ["credited-to", "group", "revenue", "share"])).toEqual([
      ["Charlie Chen", "Other staff", "RM 45.00", "0.8%"],
      ["Branch North General", "Generic account", "RM 48.79", "0.8%"],
      ["Branch South General", "Generic account", "RM 45.00", "0.8%"],
      ["No staff on line", "—", "RM 230.54", "3.9%"],
    ]);

    // The CSV has exactly the numbers on screen, as plain decimals.
    const csv = await downloadCsv(page, ranking(page));
    expect(csv.name).toBe("doctors_2026-09-01_to_2026-09-30.csv");
    expect(csv.text).toBe(
      "﻿Doctor,Revenue (RM),Share of revenue (%),AOV per customer (RM),Invoices,Items per invoice,Customers\r\n" +
        "Dr Bravo Brown,3351.72,57.2,837.93,4,1.50,4\r\n" +
        "Dr Alpha Anderson,1654.35,28.3,827.18,3,2.00,2\r\n" +
        "Dr Delta,480.00,8.2,480.00,2,1.50,1\r\n",
    );

    // Split by branch: AOV per customer counted per branch.
    await page.getByRole("navigation", { name: "Ranking layout" }).getByRole("link", { name: "Split by branch" }).click();
    await expect(page).toHaveURL(/[?&]split=branch/);
    await expect(rows(ranking(page))).toHaveCount(5);
    expect(await tableText(ranking(page), ["doctor", "branch", "revenue", "aov"])).toEqual([
      ["Dr Bravo Brown", "Branch North", "RM 2,155.57", "RM 1,077.79"],
      ["Dr Bravo Brown", "Branch South", "RM 1,196.15", "RM 598.08"],
      ["Dr Alpha Anderson", "Branch North", "RM 1,500.50", "RM 750.25"],
      ["Dr Alpha Anderson", "Branch South", "RM 153.85", "RM 153.85"],
      ["Dr Delta Not in staff list", "Branch South", "RM 480.00", "RM 480.00"],
    ]);
    const split = await downloadCsv(page, ranking(page));
    expect(split.name).toBe("doctors-by-branch_2026-09-01_to_2026-09-30.csv");
    expect(split.text.split("\r\n")).toEqual([
      "﻿Doctor,Branch,Revenue (RM),Share of revenue (%),AOV per customer (RM),Invoices,Items per invoice,Customers",
      "Dr Bravo Brown,Branch North,2155.57,36.8,1077.79,2,1.50,2",
      "Dr Bravo Brown,Branch South,1196.15,20.4,598.08,2,1.50,2",
      "Dr Alpha Anderson,Branch North,1500.50,25.6,750.25,2,2.50,2",
      "Dr Alpha Anderson,Branch South,153.85,2.6,153.85,1,1.00,1",
      "Dr Delta,Branch South,480.00,8.2,480.00,2,1.50,1",
      "",
    ]);

    // A doctor opens their detail page (a placeholder until #10), keeping the filter.
    await ranking(page).getByRole("link", { name: "Dr Alpha Anderson" }).first().click();
    await expect(page).toHaveURL(/\/doctors\/\d+\?from=2026-09-01&to=2026-09-30$/);
    await expect(page.getByRole("heading", { level: 1, name: "Dr Alpha Anderson" })).toBeVisible();

    // The global doctor filter now narrows the Overview.
    await page.goto(`/overview?${SEPTEMBER}`);
    const doctorSelect = page.getByRole("region", { name: "Filters" }).getByRole("combobox", { name: "Doctor" });
    await expect(doctorSelect.locator("option")).toHaveText(["All doctors", "Dr Alpha Anderson", "Dr Bravo Brown", "Dr Delta"]);
    await doctorSelect.selectOption({ label: "Dr Alpha Anderson" });
    await expect(page).toHaveURL(/[?&]doctor=\d+/);
    const kpi = (testId: string) => page.getByTestId(testId).getByTestId("kpi-value");
    await expect(kpi("kpi-revenue")).toHaveText("RM 1,654.35");
    await expect(kpi("kpi-invoices")).toHaveText("3");
    await expect(kpi("kpi-customers")).toHaveText("2");
    await expect(kpi("kpi-aov")).toHaveText("RM 827.18");
    await expect(page.getByTestId("doctor-filter-note")).toBeVisible();

    // Settings → Doctors: "Dr Delta" matched nobody; the owner credits it to Dr Bravo Brown.
    await page.goto(`/settings/doctors?${SEPTEMBER}`);
    await expect(page.getByRole("heading", { level: 2, name: "Doctors" })).toBeVisible();
    const aliases = page.getByTestId("staff-aliases");
    const delta = rowWhere(aliases, "name", "Dr Delta");
    await expect(cell(delta, "match")).toHaveText("No match");
    await expect(cell(delta, "revenue")).toHaveText("RM 480.00");
    await delta.getByRole("combobox", { name: "Staff member for “Dr Delta”" }).selectOption({ label: "Dr Bravo Brown (doctor)" });
    await delta.getByRole("button", { name: "Save" }).click();
    await expect(delta.getByRole("status")).toContainText("Saved");
    await expect(cell(delta, "match")).toHaveText("Set by you");

    // …and Charlie Chen is a doctor too.
    const charlie = rowWhere(page.getByTestId("staff-members"), "staff", "Charlie Chen");
    await charlie.getByRole("combobox", { name: "Kind of Charlie Chen" }).selectOption({ label: "Doctor" });
    await charlie.getByRole("button", { name: "Save" }).click();
    await expect(charlie.getByRole("status")).toContainText("Saved");

    // The Doctors page follows at once (no sync in between).
    await page.goto(`/doctors?${SEPTEMBER}`);
    expect(await tableText(ranking(page), ["doctor", "revenue", "invoices", "customers", "aov"])).toEqual([
      ["Dr Bravo Brown", "RM 3,831.72", "6", "5", "RM 766.34"],
      ["Dr Alpha Anderson", "RM 1,654.35", "3", "2", "RM 827.18"],
      ["Charlie Chen", "RM 45.00", "1", "1", "RM 45.00"],
    ]);

    // On a phone, nothing scrolls sideways (the tables scroll inside themselves).
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/doctors?${SEPTEMBER}&split=branch`);
    await expect(rows(ranking(page))).toHaveCount(5); // Bravo N + S, Alpha N + S, Charlie N
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await page.goto(`/settings/doctors?${SEPTEMBER}`);
    await expect(rows(page.getByTestId("staff-aliases"))).toHaveCount(7);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  });
});
