import { readFile } from "node:fs/promises";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { SYNTHETIC_ACCOUNTS } from "../src/kreloses/testing/synthetic-accounts";

import { signIn } from "./support/auth";
import { addConnection, syncMonth } from "./support/connections";
import { clearSyncedData } from "./support/db";
import { run } from "./support/run";

/**
 * Retention, end to end: the owner "Sync now"s the four synthetic months (Sep + Oct 2025, Aug +
 * Sep 2026) from the fake Kreloses → a manager opens the Retention page and sees these
 * HAND-COMPUTED figures (definitions in src/analytics/retention-definitions.ts; the exhaustive
 * cases are in src/analytics/retention.test.ts).
 *
 * Service visits (customer, clinic day) → doctors credited with a service line on it:
 *   C0001 2025-09-03 Alpha · 2026-08-31 Alpha · 2026-09-01 Alpha · 2026-09-18 Bravo + Alpha
 *   C0002 2026-09-05 Bravo + Alpha · 2026-09-30 (other staff only)       C0003 2025-10-01 Alpha · 2026-09-20 Bravo
 *   C0004 2026-08-20 Delta · 2026-09-02 Delta (its 10 Sep return of a product is no visit)
 *   C0005 2025-09-21 Bravo · 2025-09-30 (no staff) · 2026-09-15 Bravo     C0007 2026-08-15 Bravo · C0008 2026-08-01 Bravo
 *   Cancelled sales and the walk-in never count. Synced 3 Sep 2025 → 30 Sep 2026.
 */
const { both } = SYNTHETIC_ACCOUNTS;

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

test.describe("Retention page", () => {
  test.beforeEach(clearSyncedData);
  test.afterAll(clearSyncedData);

  test("a manager sees new vs returning customers, 90-day return rates and yearly cohorts for synced sales", async ({ page, browser }) => {
    test.setTimeout(240_000);
    await signIn(page, run.ownerEmail);
    const card = await addConnection(page, { label: "Both branches", email: both.email, password: both.password });
    for (const month of ["September 2025", "October 2025", "August 2026", "September 2026"]) {
      await syncMonth(card, month);
      await expect(card.getByRole("status")).toContainText(`Synced ${month}:`);
    }

    // Retention pages are for managers too.
    const manager = await (await browser.newContext()).newPage();
    await signIn(manager, run.managerEmail);

    // Sep–Oct 2025: the very start of the synced history, so everyone is new (and the page says why).
    await manager.goto("/retention?from=2025-09-01&to=2025-10-31");
    await expect(manager.getByRole("heading", { level: 1, name: "Retention" })).toBeVisible();
    await expect(manager.getByTestId("retention-synced-through")).toHaveText(
      "Sales synced from 3 Sep 2025 through 30 Sep 2026. Returns are only seen up to that day.",
    );
    await expect(manager.getByTestId("retention-pending-note")).toHaveCount(0);
    await expect(manager.getByTestId("limited-history-note")).toContainText("only go back to 3 Sep 2025");
    const newVsReturning = manager.getByTestId("new-vs-returning");
    const nvrColumns = ["doctor", "customers", "new", "new-percent", "returning", "returning-percent"];
    expect(await tableText(newVsReturning, nvrColumns)).toEqual([
      ["Whole clinic (all staff)", "3", "3", "100.0%", "0", "0.0%"],
      ["Dr Alpha Anderson", "2", "2", "100.0%", "0", "0.0%"],
      ["Dr Bravo Brown", "1", "1", "100.0%", "0", "0.0%"],
    ]);

    // 90-day returns: C0005 came back 9 days after 21 Sep 2025; nobody else within 90 days.
    const returnsColumns = ["doctor", "rate", "returned", "mature", "not-yet-mature", "visits"];
    expect(await tableText(manager.getByTestId("returns-90"), returnsColumns)).toEqual([
      ["Whole clinic (all staff)", "25.0%", "1", "4", "0", "4"],
      ["Dr Alpha Anderson", "0.0%", "0", "2", "0", "2"],
      ["Dr Bravo Brown", "100.0%", "1", "1", "0", "1"],
    ]);
    await expect(manager.getByRole("img", { name: "90-day return rate by doctor: Dr Alpha Anderson 0.0%; Dr Bravo Brown 100.0%" })).toBeVisible();
    await expect(manager.getByTestId("return-rate-chart").locator(".recharts-bar-rectangle")).toHaveCount(2);

    // Yearly cohorts (the date range does not apply): 2025's cohort is still accruing; 2026's has no next year yet.
    const cohorts = manager.getByTestId("cohorts");
    const cohortColumns = ["doctor", "year", "status", "customers", "retained-any-percent", "retained-same-percent", "retained-any", "retained-same"];
    const cohortTable = [
      ["Whole clinic (all staff)", "2025", "Still accruing", "3", "100.0%", "—", "3", "—"],
      ["Dr Alpha Anderson", "2025", "Still accruing", "2", "100.0%", "50.0%", "2", "1"],
      ["Dr Bravo Brown", "2025", "Still accruing", "1", "100.0%", "100.0%", "1", "1"],
    ];
    expect(await tableText(cohorts, cohortColumns)).toEqual(cohortTable);
    const csv = await downloadCsv(manager, cohorts);
    expect(csv.name).toBe("retention-cohorts_2025-09-01_to_2025-10-31.csv");
    expect(csv.text).toBe(
      "﻿Doctor,Cohort year,Status,Cohort size,Retention (any doctor) (%),Retention (same doctor) (%),Back next year (any doctor),Back next year (same doctor)\r\n" +
        "Whole clinic (all staff),2025,Still accruing,3,100.0,,3,\r\n" +
        "Dr Alpha Anderson,2025,Still accruing,2,100.0,50.0,2,1\r\n" +
        "Dr Bravo Brown,2025,Still accruing,1,100.0,100.0,1,1\r\n",
    );

    // September 2026: mostly returning customers; every visit is too recent for its 90 days to have passed.
    await manager.goto("/retention?from=2026-09-01&to=2026-09-30");
    await expect(manager.getByTestId("limited-history-note")).toHaveCount(0);
    expect(await tableText(newVsReturning, nvrColumns)).toEqual([
      ["Whole clinic (all staff)", "5", "1", "20.0%", "4", "80.0%"],
      ["Dr Alpha Anderson", "2", "1", "50.0%", "1", "50.0%"],
      ["Dr Bravo Brown", "4", "1", "25.0%", "3", "75.0%"],
      ["Dr Delta Not in staff list", "1", "0", "0.0%", "1", "100.0%"],
    ]);
    await expect(manager.getByTestId("returns-90")).toContainText("Visits after 2 Jul 2026 are not yet mature");
    expect(await tableText(manager.getByTestId("returns-90"), returnsColumns)).toEqual([
      ["Whole clinic (all staff)", "—", "0", "0", "7", "7"],
      ["Dr Alpha Anderson", "—", "0", "0", "3", "3"],
      ["Dr Bravo Brown", "—", "0", "0", "4", "4"],
      ["Dr Delta Not in staff list", "—", "0", "0", "1", "1"],
    ]);
    await expect(manager.getByTestId("return-rate-chart")).toHaveCount(0);
    expect(await tableText(cohorts, cohortColumns)).toEqual(cohortTable);

    // The doctor filter keeps the whole-clinic rows and only that doctor.
    const doctorSelect = manager.getByRole("region", { name: "Filters" }).getByRole("combobox", { name: "Doctor" });
    await doctorSelect.selectOption({ label: "Dr Bravo Brown" });
    await expect(manager).toHaveURL(/[?&]doctor=\d+/);
    await expect(rows(newVsReturning)).toHaveCount(2);
    expect(await tableText(newVsReturning, ["doctor", "customers", "new"])).toEqual([
      ["Whole clinic (all staff)", "5", "1"],
      ["Dr Bravo Brown", "4", "1"],
    ]);
    expect(await tableText(cohorts, ["doctor", "retained-same-percent"])).toEqual([
      ["Whole clinic (all staff)", "—"],
      ["Dr Bravo Brown", "100.0%"],
    ]);

    // On a phone nothing scrolls sideways (the tables scroll inside themselves).
    await manager.setViewportSize({ width: 390, height: 844 });
    await manager.goto("/retention?from=2025-09-01&to=2025-10-31");
    await expect(rows(manager.getByTestId("cohorts"))).toHaveCount(3);
    expect(await manager.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await manager.context().close();
  });
});
