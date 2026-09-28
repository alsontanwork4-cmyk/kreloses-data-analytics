import { readFile } from "node:fs/promises";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { SYNTHETIC_ACCOUNTS } from "../src/kreloses/testing/synthetic-accounts";

import { signIn } from "./support/auth";
import { addConnection, syncMonth } from "./support/connections";
import { clearSyncedData } from "./support/db";
import { run } from "./support/run";

/**
 * Discounts, end to end: "Sync now" reads September 2026's invoices and line items from the fake
 * Kreloses → the Discounts page shows each doctor's discount total, rate and share of invoices
 * discounted and the discount types, with the figures hand-computed in
 * src/analytics/discounts.test.ts → each CSV has the same numbers → the doctor filter narrows both
 * tables → a manager sees the page too → nothing scrolls sideways on a phone.
 */
const { both } = SYNTHETIC_ACCOUNTS;
const SEPTEMBER = "from=2026-09-01&to=2026-09-30";

const rows = (table: Locator) => table.getByTestId("data-table-row");
const cell = (row: Locator, column: string) => row.locator(`[data-column="${column}"]`);
const stat = (page: Page, testId: string) => ({
  value: page.getByTestId(testId).getByTestId("stat-value"),
  detail: page.getByTestId(testId).getByTestId("stat-detail"),
});

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

test.describe("Discounts page", () => {
  test.beforeEach(clearSyncedData);
  test.afterAll(clearSyncedData);

  test("the owner syncs a month and sees discounts per doctor and by type, exports them and filters by doctor", async ({ page, browser }) => {
    await signIn(page, run.ownerEmail);
    const card = await addConnection(page, { label: "Both branches", email: both.email, password: both.password });
    await syncMonth(card, "September 2026");
    await expect(card.getByRole("status")).toContainText("Synced September 2026");

    await page.goto(`/discounts?${SEPTEMBER}`);
    await expect(page.getByRole("heading", { level: 1, name: "Discounts" })).toBeVisible();

    // Totals: 280.00 off 6,135.40 gross; 4 of 9 invoices discounted.
    await expect(stat(page, "total-discount").value).toHaveText("RM 280.00");
    await expect(stat(page, "total-discount").detail).toHaveText("off RM 6,135.40 gross");
    await expect(stat(page, "total-discount-rate").value).toHaveText("4.6%");
    await expect(stat(page, "total-discounted-invoices").value).toHaveText("44.4%");
    await expect(stat(page, "total-discounted-invoices").detail).toHaveText("4 of 9 invoices (over RM 0.05)");

    // Per doctor, highest discount first.
    const doctors = page.getByTestId("doctor-discounts");
    const columns = ["doctor", "discount", "rate", "discounted-share", "discounted", "invoices", "gross", "charged"];
    await expect(rows(doctors)).toHaveCount(3);
    expect(await tableText(doctors, columns)).toEqual([
      ["Dr Bravo Brown", "RM 178.00", "5.0%", "50.0%", "2", "4", "RM 3,530.00", "RM 3,352.00"],
      ["Dr Alpha Anderson", "RM 56.15", "3.3%", "66.7%", "2", "3", "RM 1,710.50", "RM 1,654.35"],
      ["Dr Delta Not in staff list", "RM 40.00", "7.7%", "50.0%", "1", "2", "RM 520.00", "RM 480.00"],
    ]);
    await expect(page.getByRole("img", { name: /^Discount by doctor: Dr Bravo Brown RM 178\.00; Dr Alpha Anderson RM 56\.15; Dr Delta RM 40\.00$/ })).toBeVisible();
    await expect(page.getByTestId("doctor-discount-chart").locator(".recharts-bar-rectangle")).toHaveCount(3);

    // Non-doctors are kept apart.
    expect(await tableText(page.getByTestId("discount-groups"), ["credited-to", "group", "discount", "rate", "discounted-share"])).toEqual([
      ["Charlie Chen", "Other staff", "RM 0.00", "0.0%", "0.0%"],
      ["Branch North General", "Generic account", "RM 1.27", "2.5%", "100.0%"],
      ["Branch South General", "Generic account", "RM 0.00", "0.0%", "0.0%"],
      ["No staff on line", "—", "RM 4.58", "1.9%", "50.0%"],
    ]);

    // The discount types add up to the 280.00.
    const types = page.getByTestId("discount-types");
    expect(await tableText(types, ["discount", "applied-to", "amount", "share", "invoices", "lines"])).toEqual([
      ["10% DISCOUNT", "Item", "RM 120.00", "42.9%", "1", "1"],
      ["RM60 VOUCHER", "Whole invoice", "RM 60.00", "21.4%", "1", "1"],
      ["RM50 LOYALTY", "Whole invoice", "RM 50.00", "17.9%", "1", "1"],
      ["RM40 OFF", "Whole invoice", "RM 40.00", "14.3%", "1", "1"],
      ["Difference to the invoice net (no discount line)", "—", "RM 10.00", "3.6%", "1", "—"],
    ]);

    // The CSVs have exactly the numbers on screen, as plain decimals.
    const doctorCsv = await downloadCsv(page, doctors);
    expect(doctorCsv.name).toBe("discounts-by-doctor_2026-09-01_to_2026-09-30.csv");
    expect(doctorCsv.text).toBe(
      "﻿Doctor,Discount (RM),Discount rate (%),Invoices discounted (%),Discounted invoices,Invoices,Gross (RM),Charged (RM)\r\n" +
        "Dr Bravo Brown,178.00,5.0,50.0,2,4,3530.00,3352.00\r\n" +
        "Dr Alpha Anderson,56.15,3.3,66.7,2,3,1710.50,1654.35\r\n" +
        "Dr Delta,40.00,7.7,50.0,1,2,520.00,480.00\r\n",
    );
    const typesCsv = await downloadCsv(page, types);
    expect(typesCsv.name).toBe("discount-types_2026-09-01_to_2026-09-30.csv");
    expect(typesCsv.text).toBe(
      "﻿Discount,Applied to,Amount (RM),Share of discounts (%),Invoices,Lines\r\n" +
        "10% DISCOUNT,Item,120.00,42.9,1,1\r\n" +
        "RM60 VOUCHER,Whole invoice,60.00,21.4,1,1\r\n" +
        "RM50 LOYALTY,Whole invoice,50.00,17.9,1,1\r\n" +
        "RM40 OFF,Whole invoice,40.00,14.3,1,1\r\n" +
        "Difference to the invoice net (no discount line),,10.00,3.6,1,\r\n",
    );
    const groupsCsv = await downloadCsv(page, page.getByTestId("discount-groups"));
    expect(groupsCsv.text.split("\r\n")).toEqual([
      "﻿Credited to,Group,Discount (RM),Discount rate (%),Invoices discounted (%),Discounted invoices,Invoices,Gross (RM),Charged (RM)",
      "Charlie Chen,Other staff,0.00,0.0,0.0,0,1,45.00,45.00",
      "Branch North General,Generic account,1.27,2.5,100.0,1,1,50.00,48.73",
      "Branch South General,Generic account,0.00,0.0,0.0,0,1,45.00,45.00",
      "No staff on line,—,4.58,1.9,50.0,1,2,234.90,230.32",
      "",
    ]);

    // The doctor filter: Dr Bravo's figures, and the part of each discount that fell on his lines.
    const doctorSelect = page.getByRole("region", { name: "Filters" }).getByRole("combobox", { name: "Doctor" });
    await doctorSelect.selectOption({ label: "Dr Bravo Brown" });
    await expect(page).toHaveURL(/[?&]doctor=\d+/);
    await expect(page.getByTestId("doctor-filter-note")).toBeVisible();
    await expect(rows(doctors)).toHaveCount(1);
    await expect(stat(page, "total-discount").value).toHaveText("RM 178.00");
    expect(await tableText(types, ["discount", "amount", "share"])).toEqual([
      ["10% DISCOUNT", "RM 120.00", "67.4%"],
      ["RM60 VOUCHER", "RM 54.15", "30.4%"],
      ["Difference to the invoice net (no discount line)", "RM 3.85", "2.2%"],
    ]);
    await expect(page.getByTestId("discount-groups")).toContainText("Only lines credited to the selected doctor are shown.");

    // A manager sees the same page.
    const managerContext = await browser.newContext();
    try {
      const manager = await managerContext.newPage();
      await signIn(manager, run.managerEmail);
      await manager.goto(`/discounts?${SEPTEMBER}`);
      await expect(manager.getByTestId("total-discount").getByTestId("stat-value")).toHaveText("RM 280.00");
      await expect(rows(manager.getByTestId("discount-types"))).toHaveCount(5);
    } finally {
      await managerContext.close();
    }

    // On a phone, nothing scrolls sideways (the tables scroll inside themselves).
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/discounts?${SEPTEMBER}`);
    await expect(rows(doctors)).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  });
});
