import { readFile } from "node:fs/promises";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { dailyScenario } from "../src/analytics/testing/daily-scenario";
import { addDays, addYears, clinicToday, formatIsoDate } from "../src/filters/dates";
import { syntheticSales } from "../src/kreloses/testing/synthetic-sales";
import { SYNTHETIC_ACCOUNTS } from "../src/kreloses/testing/synthetic-accounts";

import { signIn } from "./support/auth";
import { addConnection, syncMonth } from "./support/connections";
import { clearSyncedData } from "./support/db";
import { restoreFixtureSales, serveSales } from "./support/fake-kreloses-control";
import { run } from "./support/run";

/**
 * The Daily page, end to end: the fake Kreloses serves the synthetic daily scenario around
 * YESTERDAY at the clinic (src/analytics/testing/daily-scenario.ts; its figures are hand-computed
 * in src/analytics/daily.test.ts — every date in it is relative to the day) → "Sync now" for the
 * months involved → /daily opens on yesterday with those figures, compared with the same weekday
 * last week and the same date last year → both CSVs have the same numbers → choosing another day,
 * the branch filter and the (ignored) date range.
 *
 * "Now" at the clinic is fixed for the app under test (`CLINIC_NOW` = `E2E_CLINIC_NOW`, set in
 * playwright.config.ts and read by `clinicNow()`), so "yesterday" is the same day here and on the
 * server whatever the machine clock says: 27 Sep 2026, the unit test's day.
 */
const { both } = SYNTHETIC_ACCOUNTS;
if (!process.env.E2E_CLINIC_NOW) throw new Error("E2E_CLINIC_NOW is not set; run the suite with `npm run test:e2e`");
const yesterday = addDays(clinicToday(new Date(process.env.E2E_CLINIC_NOW)), -1);
const lastWeek = addDays(yesterday, -7);
const lastYear = addYears(yesterday, -1);

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthLabel = (day: string) => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;

const rows = (table: Locator) => table.getByTestId("data-table-row");
const cell = (row: Locator, column: string) => row.locator(`[data-column="${column}"]`);

/** Each row's cells, by column key, as shown (whitespace collapsed). */
async function tableText(table: Locator, columns: string[]): Promise<string[][]> {
  const result: string[][] = [];
  for (const row of await rows(table).all()) {
    result.push(await Promise.all(columns.map(async (column) => (await cell(row, column).innerText()).replace(/\s+/g, " ").trim())));
  }
  return result;
}

async function downloadCsv(page: Page, table: Locator): Promise<{ name: string; lines: string[] }> {
  const [download] = await Promise.all([page.waitForEvent("download"), table.getByRole("button", { name: "Export CSV" }).click()]);
  return { name: download.suggestedFilename(), lines: (await readFile((await download.path())!, "utf8")).split("\r\n") };
}

const tile = (page: Page, testId: string) => {
  const root = page.getByTestId(testId);
  return { value: root.getByTestId("daily-value"), lastWeek: root.getByTestId("daily-vs-last-week"), lastYear: root.getByTestId("daily-vs-last-year") };
};

const METRIC_HEADERS = ["Revenue", "AOV per customer", "Invoices", "Customers"].flatMap((metric) => {
  const unit = metric === "Revenue" || metric === "AOV per customer" ? " (RM)" : "";
  return [
    `${metric}${unit}`,
    `${metric} last week${unit}`,
    `${metric} vs last week${unit}`,
    `${metric} vs last week (%)`,
    `${metric} last year${unit}`,
    `${metric} vs last year${unit}`,
    `${metric} vs last year (%)`,
  ];
});

test.describe("Daily page", () => {
  test.beforeAll(async () => {
    await clearSyncedData();
    await serveSales(syntheticSales(dailyScenario(yesterday)));
  });
  test.afterAll(async () => {
    await restoreFixtureSales();
    await clearSyncedData();
  });

  test("opens on yesterday with its figures and comparisons, exports both tables, and switches day", async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page, run.ownerEmail);
    const card = await addConnection(page, { label: "Both branches", email: both.email, password: both.password });
    for (const month of [...new Set([yesterday, lastWeek, lastYear].map((day) => day.slice(0, 7)))]) {
      await syncMonth(card, monthLabel(`${month}-01`));
      await expect(card.getByRole("status")).toContainText(`Synced ${monthLabel(`${month}-01`)}:`);
    }

    // Defaults to yesterday at the clinic.
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Daily" }).click();
    await expect(page).toHaveURL(/\/daily$/);
    await expect(page.getByRole("heading", { level: 1, name: "Daily" })).toBeVisible();
    await expect(page.getByTestId("daily-day")).toContainText(formatIsoDate(yesterday));
    await expect(page.getByTestId("daily-day")).toContainText("(yesterday)");
    await expect(page.getByTestId("daily-comparison-days")).toContainText(`${formatIsoDate(lastWeek)} (same weekday last week)`);
    await expect(page.getByTestId("daily-comparison-days")).toContainText(`${formatIsoDate(lastYear)} (same date last year)`);
    await expect(page.getByRole("form", { name: "Choose a day" }).getByLabel("Day")).toHaveValue(yesterday);
    await expect(page.getByTestId("daily-range-note")).toContainText("the date range in the filter bar does not apply here");

    // Totals, with both comparisons (sign and arrow, not colour alone).
    const revenue = tile(page, "daily-revenue");
    await expect(revenue.value).toHaveText("RM 1,125.00");
    await expect(revenue.lastWeek).toHaveText("+RM 375.00 (+50.0%) vs last week");
    await expect(revenue.lastYear).toHaveText("+RM 125.00 (+12.5%) vs last year");
    const aov = tile(page, "daily-aov");
    await expect(aov.value).toHaveText("RM 281.25");
    await expect(aov.lastWeek).toHaveText("−RM 93.75 (−25.0%) vs last week");
    await expect(aov.lastYear).toHaveText("−RM 718.75 (−71.9%) vs last year");
    await expect(tile(page, "daily-invoices").value).toHaveText("6");
    await expect(tile(page, "daily-invoices").lastWeek).toHaveText("+3 (+100.0%) vs last week");
    await expect(tile(page, "daily-customers").value).toHaveText("4");
    await expect(tile(page, "daily-customers").lastYear).toHaveText("+3 (+300.0%) vs last year");

    // By branch: every change as a percentage and an amount; over a zero base, the amount only.
    const branches = page.getByTestId("daily-branches");
    const columns = ["revenue", "revenue-vs-last-week", "revenue-vs-last-year", "aov", "aov-vs-last-week", "aov-vs-last-year", "invoices", "invoices-vs-last-week", "customers"];
    expect(await tableText(branches, ["branch", ...columns])).toEqual([
      [
        expect.stringMatching(/^Branch North Data as of \d{1,2} \w{3} \d{4}, \d{2}:\d{2}$/),
        "RM 540.00",
        "+35.0% +RM 140.00",
        "−46.0% −RM 460.00",
        "RM 180.00",
        "−55.0% −RM 220.00",
        "−82.0% −RM 820.00",
        "3",
        "+200.0% +2",
        "3",
      ],
      [
        expect.stringMatching(/^Branch South Data as of /),
        "RM 585.00",
        "+67.1% +RM 235.00",
        "+RM 585.00 none last year",
        "RM 292.50",
        "−16.4% −RM 57.50",
        "— no customers last year",
        "3",
        "+50.0% +1",
        "2",
      ],
    ] as unknown as string[][]);

    // By doctor: doctors by revenue (Dr Delta sold nothing yesterday but did last week), then the groups.
    const doctors = page.getByTestId("daily-doctors");
    expect(await tableText(doctors, ["doctor", "revenue", "revenue-vs-last-week", "revenue-vs-last-year", "aov", "invoices"])).toEqual([
      ["Dr Bravo Brown", "RM 550.00", "+175.0% +RM 350.00", "+RM 550.00 none last year", "RM 550.00", "2"],
      ["Dr Alpha Anderson", "RM 450.00", "+12.5% +RM 50.00", "−55.0% −RM 550.00", "RM 225.00", "2"],
      ["Dr Delta Not in staff list", "RM 0.00", "−100.0% −RM 100.00", "— none on either day", "—", "0"],
      ["Other staff", "RM 25.00", "+RM 25.00 none last week", "+RM 25.00 none last year", "RM 25.00", "1"],
      ["Generic accounts", "RM 60.00", "+RM 60.00 none last week", "+RM 60.00 none last year", "—", "1"],
      ["No staff on line", "RM 40.00", "−20.0% −RM 10.00", "+RM 40.00 none last year", "RM 40.00", "1"],
    ]);

    // Both CSVs: every number on screen plus the comparison bases and percentages, as plain decimals.
    const branchCsv = await downloadCsv(page, branches);
    expect(branchCsv.name).toBe(`daily-branches_${yesterday}.csv`);
    expect(branchCsv.lines).toEqual([
      `﻿Branch,${METRIC_HEADERS.join(",")}`,
      "Branch North,540.00,400.00,140.00,35.0,1000.00,-460.00,-46.0,180.00,400.00,-220.00,-55.0,1000.00,-820.00,-82.0,3,1,2,200.0,1,2,200.0,3,1,2,200.0,1,2,200.0",
      "Branch South,585.00,350.00,235.00,67.1,0.00,585.00,,292.50,350.00,-57.50,-16.4,,,,3,2,1,50.0,0,3,,2,1,1,100.0,0,2,",
      "",
    ]);
    const doctorCsv = await downloadCsv(page, doctors);
    expect(doctorCsv.name).toBe(`daily-doctors_${yesterday}.csv`);
    expect(doctorCsv.lines).toEqual([
      `﻿Doctor,${METRIC_HEADERS.join(",")}`,
      "Dr Bravo Brown,550.00,200.00,350.00,175.0,0.00,550.00,,550.00,200.00,350.00,175.0,,,,2,1,1,100.0,0,2,,1,1,0,0.0,0,1,",
      "Dr Alpha Anderson,450.00,400.00,50.00,12.5,1000.00,-550.00,-55.0,225.00,400.00,-175.00,-43.8,1000.00,-775.00,-77.5,2,1,1,100.0,1,1,100.0,2,1,1,100.0,1,1,100.0",
      "Dr Delta,0.00,100.00,-100.00,-100.0,0.00,0.00,,,100.00,,,,,,0,1,-1,-100.0,0,0,,0,1,-1,-100.0,0,0,",
      "Other staff,25.00,0.00,25.00,,0.00,25.00,,25.00,,,,,,,1,0,1,,0,1,,1,0,1,,0,1,",
      "Generic accounts,60.00,0.00,60.00,,0.00,60.00,,,,,,,,,1,0,1,,0,1,,0,0,0,,0,0,",
      "No staff on line,40.00,50.00,-10.00,-20.0,0.00,40.00,,40.00,50.00,-10.00,-20.0,,,,1,1,0,0.0,0,1,,1,1,0,0.0,0,1,",
      "",
    ]);

    // The date range in the filter bar does not change the day (the page says so)…
    const filters = page.getByRole("region", { name: "Filters" });
    await filters.getByRole("link", { name: "Last month" }).click();
    await expect(page).toHaveURL(/[?&]range=last-month/);
    await expect(revenue.value).toHaveText("RM 1,125.00");

    // …the branch filter does.
    await filters.getByRole("combobox", { name: "Branch" }).selectOption({ label: "Branch South" });
    await expect(page).toHaveURL(/[?&]branch=\d+/);
    await expect(revenue.value).toHaveText("RM 585.00");
    await expect(revenue.lastYear).toHaveText("+RM 585.00 vs last year (none then)");
    expect(await tableText(branches, ["branch"])).toEqual([[expect.stringMatching(/^Branch South Data as of /)]] as unknown as string[][]);
    expect(await tableText(doctors, ["doctor", "revenue"])).toEqual([
      ["Dr Bravo Brown", "RM 500.00"],
      ["Dr Delta Not in staff list", "RM 0.00"],
      ["Other staff", "RM 25.00"],
      ["Generic accounts", "RM 60.00"],
      ["No staff on line", "RM 0.00"],
    ]);
    await filters.getByRole("combobox", { name: "Branch" }).selectOption({ label: "All branches" });
    await expect(revenue.value).toHaveText("RM 1,125.00");

    // Choose another day: the same weekday last week (compared with nothing: no percentages).
    const picker = page.getByRole("form", { name: "Choose a day" });
    await picker.getByLabel("Day").fill(lastWeek);
    await picker.getByRole("button", { name: "Show" }).click();
    await expect(page).toHaveURL(new RegExp(`[?&]day=${lastWeek}`));
    await expect(page.getByTestId("daily-day")).toContainText(formatIsoDate(lastWeek));
    await expect(page.getByTestId("daily-day")).not.toContainText("(yesterday)");
    await expect(revenue.value).toHaveText("RM 750.00");
    await expect(revenue.lastWeek).toHaveText("+RM 750.00 vs last week (none then)");
    await expect(tile(page, "daily-aov").value).toHaveText("RM 375.00");
    expect(await tableText(branches, ["revenue", "invoices", "customers"])).toEqual([
      ["RM 400.00", "1", "1"],
      ["RM 350.00", "2", "1"],
    ]);
    expect(await tableText(doctors, ["doctor", "revenue"])).toEqual([
      ["Dr Alpha Anderson", "RM 400.00"],
      ["Dr Bravo Brown", "RM 200.00"],
      ["Dr Delta Not in staff list", "RM 100.00"],
      ["No staff on line", "RM 50.00"],
    ]);
    const lastWeekCsv = await downloadCsv(page, branches);
    expect(lastWeekCsv.name).toBe(`daily-branches_${lastWeek}.csv`);
    expect(lastWeekCsv.lines[1]).toBe("Branch North,400.00,0.00,400.00,,0.00,400.00,,400.00,,,,,,,1,0,1,,0,1,,1,0,1,,0,1,");

    // The next day, then back to yesterday.
    await page.getByRole("link", { name: /^Next day/ }).click();
    await expect(page).toHaveURL(new RegExp(`[?&]day=${addDays(lastWeek, 1)}`));
    await expect(page.getByTestId("daily-day")).toContainText(formatIsoDate(addDays(lastWeek, 1)));
    await page.getByRole("link", { name: "Yesterday", exact: true }).click();
    await expect(page.getByTestId("daily-day")).toContainText("(yesterday)");
    await expect(page).not.toHaveURL(/[?&]day=/);
    await expect(revenue.value).toHaveText("RM 1,125.00");

    // A future (or implausible) day in the URL falls back to yesterday.
    await page.goto("/daily?day=2099-01-01");
    await expect(page.getByTestId("daily-day")).toContainText(formatIsoDate(yesterday));
    await expect(page.getByTestId("daily-day")).toContainText("(yesterday)");
    await expect(revenue.value).toHaveText("RM 1,125.00");

    // On a phone: the owner's morning check fits, nothing scrolls sideways (tables scroll inside themselves).
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(revenue.value).toHaveText("RM 1,125.00");
    await expect(rows(doctors)).toHaveCount(6);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  });
});
