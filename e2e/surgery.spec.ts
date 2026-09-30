import { readFile } from "node:fs/promises";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { SURGERY_SCENARIO, SURGERY_SCENARIO_ASSIGNMENTS } from "../src/analytics/testing/surgery-scenario";
import { syntheticSales } from "../src/kreloses/testing/synthetic-sales";
import { SYNTHETIC_ACCOUNTS } from "../src/kreloses/testing/synthetic-accounts";

import { signIn } from "./support/auth";
import { addConnection, syncMonth } from "./support/connections";
import { clearSyncedData, withRunDatabase } from "./support/db";
import { restoreFixtureSales, serveSales } from "./support/fake-kreloses-control";
import { run } from "./support/run";

/**
 * The surgery department, vaccines and dental (#15), end to end: the fake Kreloses serves the
 * synthetic surgery scenario (src/analytics/testing/surgery-scenario.ts; every figure below is
 * hand-computed in src/analytics/surgery.test.ts), its item names are assigned to groups as the
 * owner would (Settings → Items) → "Sync now" for September 2026 → Mix → "Surgery, vaccines &
 * dental" shows the cases (operations vs sedation only) per doctor and branch, fee vs whole-visit
 * value, the 14-day post-op follow-up, top procedures and vaccine / dental-scaling revenue, with
 * CSV; a doctor filter and a manager see the same definitions.
 */
const { both } = SYNTHETIC_ACCOUNTS;
const SEPTEMBER = "from=2026-09-01&to=2026-09-30";

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

/** Item settings back to the seeded rules only (and no derived classifications left behind). */
async function clearItemSettings() {
  await withRunDatabase(async (sql) => {
    await sql`delete from item_assignments`;
    await sql`delete from item_classifications`;
    await sql`delete from item_group_rules where source = 'owner'`;
  });
}

test.describe("Mix → surgery, vaccines & dental", () => {
  test.beforeAll(async () => {
    await clearSyncedData();
    await clearItemSettings();
    await serveSales(syntheticSales(SURGERY_SCENARIO));
    // The owner's assignments for the scenario's own item names, in place before the sync classifies them.
    await withRunDatabase(async (sql) => {
      for (const { itemKey, classification: c } of SURGERY_SCENARIO_ASSIGNMENTS) {
        await sql`
          insert into item_assignments (item_key, mix_group, is_surgery, is_consult, is_vaccine, is_dental_scaling, is_procedure)
          values (${itemKey}, ${c.group}, ${c.surgery}, ${c.consult}, ${c.vaccine}, ${c.dentalScaling}, ${c.procedure})
        `;
      }
    });
  });
  test.afterAll(async () => {
    await restoreFixtureSales();
    await clearSyncedData();
    await clearItemSettings();
  });

  test("shows cases, operations vs sedation only, fees vs whole visit, follow-up, top procedures and vaccines & dental", async ({ page, browser }) => {
    test.setTimeout(180_000);
    await signIn(page, run.ownerEmail);

    // Nothing synced yet: the view has its empty state (and its tabs).
    await page.goto(`/mix/surgery?${SEPTEMBER}`);
    await expect(page.getByTestId("empty-state")).toContainText("No sales data yet");
    await expect(page.getByRole("navigation", { name: "Mix views" }).getByRole("link", { name: "Surgery, vaccines & dental" })).toHaveAttribute("aria-current", "page");

    const card = await addConnection(page, { label: "Both branches", email: both.email, password: both.password });
    await syncMonth(card, "September 2026");
    await expect(card.getByRole("status")).toContainText("Synced September 2026:");

    // Mix → the surgery view, keeping the filter.
    await page.goto(`/mix?${SEPTEMBER}&top=3`);
    await page.getByRole("navigation", { name: "Mix views" }).getByRole("link", { name: "Surgery, vaccines & dental" }).click();
    await expect(page).toHaveURL(/\/mix\/surgery\?from=2026-09-01&to=2026-09-30$/);
    await expect(page.getByRole("heading", { level: 1, name: "Mix" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Surgery" })).toBeVisible();
    // 950014's invoice page is missing: its line items (a spay) are not synced, and the page says so.
    await expect(page.getByTestId("surgery-pending-note")).toContainText("1 sale in this period (RM 500.00) has line items not synced yet");

    // Cases per doctor: a case counts for every doctor with a surgery line on it (950005: Dr Alpha and Dr Bravo).
    const doctors = page.getByTestId("surgery-doctors");
    const caseColumns = ["name", "cases", "operations", "sedation-only", "fees", "whole-visit", "average-fee", "average-whole-visit", "fee-share"];
    expect(await tableText(doctors, caseColumns)).toEqual([
      ["Dr Alpha Anderson", "3", "3", "0", "RM 2,350.00", "RM 3,260.00", "RM 783.33", "RM 1,086.67", "72.1%"],
      ["Dr Bravo Brown", "3", "2", "1", "RM 1,600.00", "RM 2,620.00", "RM 533.33", "RM 873.33", "61.1%"],
      ["Dr Delta", "1", "0", "1", "RM 90.00", "RM 90.00", "RM 90.00", "RM 90.00", "100.0%"],
      ["All cases", "6", "4", "2", "RM 4,160.00", "RM 4,330.00", "RM 693.33", "RM 721.67", "96.1%"],
    ]);
    await expect(page.getByRole("img", { name: /^Surgery cases by doctor: Dr Alpha Anderson 3 cases \(Operations 3\); Dr Bravo Brown 3 cases \(Operations 2, Sedation only 1\); Dr Delta 1 case \(Sedation only 1\)$/ })).toBeVisible();
    const csv = await downloadCsv(page, doctors);
    expect(csv.name).toBe("surgery-cases-by-doctor_2026-09-01_to_2026-09-30.csv");
    expect(csv.lines.slice(0, 2)).toEqual([
      "﻿Doctor,Cases,Operations,Sedation only,Surgery fees (RM),Whole-visit value (RM),Average fee per case (RM),Average whole visit per case (RM),Fees as share of whole visit (%)",
      "Dr Alpha Anderson,3,3,0,2350.00,3260.00,783.33,1086.67,72.1",
    ]);

    // Per branch, every case once.
    expect(await tableText(page.getByTestId("surgery-branches"), caseColumns)).toEqual([
      ["Branch North", "4", "4", "0", "RM 3,870.00", "RM 3,960.00", "RM 967.50", "RM 990.00", "97.7%"],
      ["Branch South", "2", "0", "2", "RM 290.00", "RM 370.00", "RM 145.00", "RM 185.00", "78.4%"],
      ["All cases", "6", "4", "2", "RM 4,160.00", "RM 4,330.00", "RM 693.33", "RM 721.67", "96.1%"],
    ]);

    // Post-op follow-up within 14 days (synced through 27 Sep: cases after 13 Sep are not yet mature).
    const followUp = page.getByTestId("surgery-follow-up");
    await expect(followUp).toContainText("Sales are synced through 27 Sep 2026, so cases after 13 Sep 2026 are not yet mature");
    expect(await tableText(followUp, ["name", "rate", "followed-up", "mature", "not-yet-mature", "walk-ins", "cases"])).toEqual([
      ["All cases", "50.0%", "2", "4", "1", "1", "6"],
      ["Branch North", "66.7%", "2", "3", "1", "0", "4"],
      ["Branch South", "0.0%", "0", "1", "0", "1", "2"],
      ["Dr Alpha Anderson", "66.7%", "2", "3", "0", "0", "3"],
      ["Dr Bravo Brown", "0.0%", "0", "2", "1", "0", "3"],
      ["Dr Delta", "—", "0", "0", "0", "1", "1"],
    ]);

    // Top procedures by fees, overall and per doctor; N switchable.
    expect(await tableText(page.getByTestId("top-procedures"), ["procedure", "cases", "fees", "average-fee"])).toEqual([
      ["Syn Spay", "3", "RM 2,400.00", "RM 800.00"],
      ["Syn Mass removal", "2", "RM 1,100.00", "RM 550.00"],
    ]);
    expect(await tableText(page.getByTestId("top-procedures-by-doctor"), ["doctor", "rank", "procedure", "cases", "fees", "average-fee"])).toEqual([
      ["Dr Alpha Anderson", "1", "Syn Spay", "2", "RM 1,700.00", "RM 850.00"],
      ["Dr Alpha Anderson", "2", "Syn Mass removal", "1", "RM 500.00", "RM 500.00"],
      ["Dr Bravo Brown", "1", "Syn Spay", "1", "RM 700.00", "RM 700.00"],
      ["Dr Bravo Brown", "2", "Syn Mass removal", "1", "RM 600.00", "RM 600.00"],
    ]);
    const procedureCsv = await downloadCsv(page, page.getByTestId("top-procedures"));
    expect(procedureCsv.lines.slice(0, 2)).toEqual(["﻿#,Procedure,Cases,Fees (RM),Average fee (RM)", "1,Syn Spay,3,2400.00,800.00"]);
    await page.getByRole("navigation", { name: "Top procedures" }).getByRole("link", { name: "Top 10" }).click();
    await expect(page).toHaveURL(/[?&]top=10/);
    await expect(page.getByRole("heading", { name: "Top 10 procedures", exact: true })).toBeVisible();

    // Vaccines and dental scaling per doctor.
    expect(await tableText(page.getByTestId("vaccines-dental"), ["name", "vaccine", "vaccine-share", "dental", "dental-share", "revenue"])).toEqual([
      ["Dr Bravo Brown", "RM 100.00", "4.2%", "RM 450.00", "18.9%", "RM 2,380.00"],
      ["Dr Alpha Anderson", "RM 120.00", "5.5%", "RM 300.00", "13.8%", "RM 2,180.00"],
      ["Dr Delta", "RM 0.00", "0.0%", "RM 0.00", "0.0%", "RM 160.00"],
      ["All revenue", "RM 250.00", "4.6%", "RM 750.00", "13.9%", "RM 5,410.00"],
    ]);

    // A doctor filter: only Dr Bravo's cases, and only his surgery lines as fees (the whole visit stays whole).
    await page.getByRole("region", { name: "Filters" }).getByRole("combobox", { name: "Doctor" }).selectOption({ label: "Dr Bravo Brown" });
    await expect(page).toHaveURL(/[?&]doctor=\d+/);
    expect(await tableText(page.getByTestId("surgery-doctors"), ["name", "cases", "operations", "sedation-only", "fees", "whole-visit"])).toEqual([
      ["Dr Bravo Brown", "3", "2", "1", "RM 1,600.00", "RM 2,620.00"],
      ["Selected doctors", "3", "2", "1", "RM 1,600.00", "RM 2,620.00"],
    ]);

    // Sales but no surgery case in the dates (15–17 Sep: rechecks and a consult only): the case tables say so
    // instead of showing a row of zeros.
    await page.goto("/mix/surgery?from=2026-09-15&to=2026-09-17");
    for (const testId of ["surgery-doctors", "surgery-branches", "surgery-follow-up"]) {
      await expect(rows(page.getByTestId(testId))).toHaveCount(0);
      await expect(page.getByTestId(testId)).toContainText("No surgery cases in this period.");
    }
    await expect(page.getByTestId("surgery-cases-chart")).toHaveCount(0);
    await expect(rows(page.getByTestId("vaccines-dental")).first()).toBeVisible();

    // On a phone, nothing scrolls sideways (the tables scroll inside themselves).
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/mix/surgery?${SEPTEMBER}`);
    await expect(rows(page.getByTestId("surgery-doctors"))).toHaveCount(4);
    await expect(page.getByTestId("surgery-cases-chart")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole("region", { name: "Filters" }).getByRole("combobox", { name: "Doctor" }).selectOption({ label: "Dr Bravo Brown" });
    await expect(page).toHaveURL(/[?&]doctor=\d+/);

    // Back on the service mix tab, the filter is kept and the view-specific ?top= is dropped.
    await page.getByRole("navigation", { name: "Mix views" }).getByRole("link", { name: "Service mix" }).click();
    await expect(page).toHaveURL(/\/mix\?from=2026-09-01&to=2026-09-30&doctor=\d+$/);
    await expect(page.getByTestId("mix-revenue")).toBeVisible();

    // A manager sees the same view.
    const managerContext = await browser.newContext();
    try {
      const manager = await managerContext.newPage();
      await signIn(manager, run.managerEmail);
      await manager.goto(`/mix/surgery?${SEPTEMBER}`);
      await expect(cell(rows(manager.getByTestId("surgery-doctors")).last(), "cases")).toHaveText("6");
    } finally {
      await managerContext.close();
    }
  });
});
