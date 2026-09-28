import { readFile } from "node:fs/promises";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { UPSELL_SCENARIO } from "../src/analytics/testing/upsell-scenario";
import { syntheticSales } from "../src/kreloses/testing/synthetic-sales";
import { SYNTHETIC_ACCOUNTS } from "../src/kreloses/testing/synthetic-accounts";

import { signIn } from "./support/auth";
import { addConnection, syncMonth } from "./support/connections";
import { clearSyncedData } from "./support/db";
import { restoreFixtureSales, serveSales } from "./support/fake-kreloses-control";
import { run } from "./support/run";

/**
 * The Upsell page, end to end: the fake Kreloses serves the hand-built upsell scenario
 * (src/analytics/testing/upsell-scenario.ts; every figure below is hand-computed in
 * src/analytics/upsell.test.ts) → the owner runs "Sync now" for August and September 2026 → a MANAGER
 * opens /upsell from the nav and sees each doctor's attach rates on consult invoices (whole invoice, then the doctor's own lines), their chart
 * and CSV, the items-per-invoice trend (chart with toggleable lines, table, CSV), follows the branch
 * and doctor filters, and shows empty states for a period without sales.
 *
 * The app's clinic "today" is 28 Sep 2026 (`CLINIC_NOW` = `E2E_CLINIC_NOW`, playwright.config.ts), so
 * September 2026 is the current (partial) month.
 */
const { both } = SYNTHETIC_ACCOUNTS;
const RANGE = "from=2026-08-01&to=2026-09-28";

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

const ATTACH_COLUMNS = ["doctor", "consults", "diagnostics", "products", "secondService", "anyAddOn"];
const ATTACH_CSV_HEADER =
  "﻿Doctor,Consult invoices,Diagnostics (%),Diagnostics (consult invoices),Products (%),Products (consult invoices),Second service (%),Second service (consult invoices),Any add-on (%),Any add-on (consult invoices)";

test.describe("Upsell page", () => {
  test.beforeAll(async () => {
    await clearSyncedData();
    await serveSales(syntheticSales(UPSELL_SCENARIO));
  });
  test.afterAll(async () => {
    await restoreFixtureSales();
    await clearSyncedData();
  });

  test("a manager sees each doctor's consult attach rates and items per invoice over time, with CSVs, filters and empty states", async ({ page: owner, browser }) => {
    test.setTimeout(240_000);
    await signIn(owner, run.ownerEmail);
    const card = await addConnection(owner, { label: "Both branches", email: both.email, password: both.password });
    for (const month of ["August 2026", "September 2026"]) {
      await syncMonth(card, month);
      await expect(card.getByRole("status")).toContainText(`Synced ${month}:`);
    }

    // The Upsell page is for managers too: the rest is a manager's view.
    const page = await (await browser.newContext()).newPage();
    await signIn(page, run.managerEmail);
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Upsell" }).click();
    await expect(page).toHaveURL(/\/upsell$/);
    await page.goto(`/upsell?${RANGE}`);
    await expect(page.getByRole("heading", { level: 1, name: "Upsell" })).toBeVisible();
    // 820015's invoice page is missing: it cannot be classified and is named, not silently dropped.
    await expect(page.getByTestId("pending-line-items-note")).toContainText("1 invoice in this period (RM 230.00) has line items not synced yet");

    // Attach rates, whole invoice (the default): the percentage and the invoices behind it.
    const attach = page.getByTestId("attach-rates");
    await expect(page.getByRole("navigation", { name: "Count add-ons on" }).getByRole("link", { name: "Whole invoice" })).toHaveAttribute("aria-current", "true");
    expect(await tableText(attach, ATTACH_COLUMNS)).toEqual([
      ["Dr Alpha Anderson", "7", "28.6% 2 of 7", "28.6% 2 of 7", "42.9% 3 of 7", "71.4% 5 of 7"],
      ["Dr Bravo Brown", "5", "40.0% 2 of 5", "0.0% 0 of 5", "60.0% 3 of 5", "60.0% 3 of 5"],
      ["All doctors", "12", "33.3% 4 of 12", "16.7% 2 of 12", "50.0% 6 of 12", "66.7% 8 of 12"],
    ]);
    const wholeCsv = await downloadCsv(page, attach);
    expect(wholeCsv.name).toBe("upsell-attach-rates_2026-08-01_to_2026-09-28.csv");
    expect(wholeCsv.lines).toEqual([
      ATTACH_CSV_HEADER,
      "Dr Alpha Anderson,7,28.6,2,28.6,2,42.9,3,71.4,5",
      "Dr Bravo Brown,5,40.0,2,0.0,0,60.0,3,60.0,3",
      "All doctors,12,33.3,4,16.7,2,50.0,6,66.7,8",
      "",
    ]);
    const attachChart = page.getByTestId("attach-chart");
    await expect(
      attachChart.getByRole("img", {
        name: "Share of consult invoices with each add-on: Dr Alpha Anderson: Diagnostics 28.6%, Products 28.6%, Second service 42.9%; Dr Bravo Brown: Diagnostics 40.0%, Products 0.0%, Second service 60.0%; All doctors: Diagnostics 33.3%, Products 16.7%, Second service 50.0%",
      }),
    ).toBeVisible();
    await expect(attachChart.locator(".recharts-bar-rectangle")).toHaveCount(9);

    // The doctor's own lines only (URL state; the filter bar keeps it).
    await page.getByRole("navigation", { name: "Count add-ons on" }).getByRole("link", { name: "Doctor's own lines" }).click();
    await expect(page).toHaveURL(/[?&]addons=own/);
    await expect(page.getByTestId("attach-view-note")).toContainText("Only add-ons credited to the consulting doctor count.");
    expect(await tableText(attach, ATTACH_COLUMNS)).toEqual([
      ["Dr Alpha Anderson", "7", "0.0% 0 of 7", "14.3% 1 of 7", "14.3% 1 of 7", "28.6% 2 of 7"],
      ["Dr Bravo Brown", "5", "40.0% 2 of 5", "0.0% 0 of 5", "40.0% 2 of 5", "40.0% 2 of 5"],
      ["All doctors", "12", "16.7% 2 of 12", "8.3% 1 of 12", "25.0% 3 of 12", "33.3% 4 of 12"],
    ]);
    const ownCsv = await downloadCsv(page, attach);
    expect(ownCsv.name).toBe("upsell-attach-rates-own-lines_2026-08-01_to_2026-09-28.csv");
    expect(ownCsv.lines[1]).toBe("Dr Alpha Anderson,7,0.0,0,14.3,1,14.3,1,28.6,2");

    // Items per invoice per month (September is the current month, so far), as on the Doctors page.
    const items = page.getByTestId("items-per-invoice");
    expect(await tableText(items, ["doctor", "m2026-08", "m2026-09", "total"])).toEqual([
      ["Dr Alpha Anderson", "1.50", "1.60", "1.56"],
      ["Dr Bravo Brown", "1.67", "1.33", "1.50"],
    ]);
    await expect(items.getByRole("columnheader", { name: "Sep 2026 (so far)" })).toBeVisible();
    await expect(page.getByTestId("partial-months")).toContainText("Sep 2026 is the current month: its figures are for the days so far.");
    const itemsCsv = await downloadCsv(page, items);
    expect(itemsCsv.name).toBe("upsell-items-per-invoice_2026-08-01_to_2026-09-28.csv");
    expect(itemsCsv.lines).toEqual([
      "﻿Doctor,Aug 2026,Aug 2026 item lines,Aug 2026 invoices,Sep 2026 (so far),Sep 2026 (so far) item lines,Sep 2026 (so far) invoices,Whole period,Whole period item lines,Whole period invoices",
      "Dr Alpha Anderson,1.50,6,4,1.60,8,5,1.56,14,9",
      "Dr Bravo Brown,1.67,5,3,1.33,4,3,1.50,9,6",
      "",
    ]);
    const itemsChart = page.getByTestId("items-per-invoice-chart");
    await expect(
      itemsChart.getByRole("img", {
        name: "Average items per invoice by doctor, Aug 2026 to Sep 2026: Dr Alpha Anderson: Aug 2026 1.50, Sep 2026 1.60; Dr Bravo Brown: Aug 2026 1.67, Sep 2026 1.33",
      }),
    ).toBeVisible();
    await expect(itemsChart.locator(".recharts-line")).toHaveCount(2);
    const legend = itemsChart.getByRole("group", { name: "Show or hide lines" });
    await legend.getByRole("button", { name: "Dr Bravo Brown" }).click();
    await expect(itemsChart.locator(".recharts-line")).toHaveCount(1);
    await legend.getByRole("button", { name: "Show all" }).click();
    await expect(itemsChart.locator(".recharts-line")).toHaveCount(2);

    // The Doctors page's items per invoice is the same figure.
    await page.goto(`/doctors?${RANGE}`);
    expect(await tableText(page.getByTestId("doctor-ranking"), ["doctor", "items"])).toEqual(
      expect.arrayContaining([
        [expect.stringMatching(/^Dr Alpha Anderson/), "1.56"],
        [expect.stringMatching(/^Dr Bravo Brown/), "1.50"],
      ]) as unknown as string[][],
    );

    // The branch filter (the view is kept), then the doctor filter (all doctors does not change).
    await page.goto(`/upsell?${RANGE}&addons=own`);
    const filters = page.getByRole("region", { name: "Filters" });
    await filters.getByRole("combobox", { name: "Branch" }).selectOption({ label: "Branch North" });
    await expect(page).toHaveURL(/[?&]branch=\d+/);
    await expect(page).toHaveURL(/[?&]addons=own/);
    expect(await tableText(attach, ATTACH_COLUMNS)).toEqual([
      ["Dr Alpha Anderson", "6", "0.0% 0 of 6", "16.7% 1 of 6", "16.7% 1 of 6", "33.3% 2 of 6"],
      ["Dr Bravo Brown", "2", "50.0% 1 of 2", "0.0% 0 of 2", "50.0% 1 of 2", "50.0% 1 of 2"],
      ["All doctors", "8", "12.5% 1 of 8", "12.5% 1 of 8", "25.0% 2 of 8", "37.5% 3 of 8"],
    ]);
    await filters.getByRole("combobox", { name: "Branch" }).selectOption({ label: "All branches" });
    await expect(page).not.toHaveURL(/[?&]branch=/);
    await filters.getByRole("combobox", { name: "Doctor" }).selectOption({ label: "Dr Bravo Brown" });
    await expect(page).toHaveURL(/[?&]doctor=\d+/);
    await page.getByRole("navigation", { name: "Count add-ons on" }).getByRole("link", { name: "Whole invoice" }).click();
    await expect(page).not.toHaveURL(/[?&]addons=/);
    expect(await tableText(attach, ATTACH_COLUMNS)).toEqual([
      ["Dr Bravo Brown", "5", "40.0% 2 of 5", "0.0% 0 of 5", "60.0% 3 of 5", "60.0% 3 of 5"],
      ["All doctors", "12", "33.3% 4 of 12", "16.7% 2 of 12", "50.0% 6 of 12", "66.7% 8 of 12"],
    ]);
    expect(await tableText(items, ["doctor", "m2026-08", "m2026-09", "total"])).toEqual([["Dr Bravo Brown", "1.67", "1.33", "1.50"]]);

    await expect(attach).toContainText("An invoice with two consulting doctors counts once for each of them");

    // A period without sales: empty states, not empty tables (saying when a doctor filter narrows them).
    const doctorParam = new URL(page.url()).searchParams.get("doctor")!;
    await page.goto("/upsell?from=2026-07-01&to=2026-07-31");
    await expect(page.getByRole("heading", { name: "No consults in this period" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "No doctor sales in this period" })).toBeVisible();
    await expect(page.getByTestId("attach-rates")).toHaveCount(0);
    await page.goto(`/upsell?from=2026-07-01&to=2026-07-31&doctor=${doctorParam}`);
    await expect(page.getByTestId("empty-state").filter({ hasText: "No doctor sales in this period" })).toContainText(
      "No line was credited to a doctor in 1 Jul 2026 – 31 Jul 2026 for the selected doctors.",
    );
    await expect(page.getByTestId("empty-state").filter({ hasText: "No consults in this period" })).toContainText("for the selected doctors.");

    // On a phone: nothing scrolls sideways (tables scroll inside themselves).
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/upsell?${RANGE}`);
    await expect(rows(attach)).toHaveCount(3);
    await expect(itemsChart.locator(".recharts-line")).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  });
});
