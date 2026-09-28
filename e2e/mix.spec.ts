import { readFile } from "node:fs/promises";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { SYNTHETIC_ACCOUNTS } from "../src/kreloses/testing/synthetic-accounts";

import { signIn } from "./support/auth";
import { addConnection, syncMonth } from "./support/connections";
import { clearSyncedData, withRunDatabase } from "./support/db";
import { run } from "./support/run";

/**
 * Item groups → Mix page, end to end: "Sync now" reads September 2026 from the fake Kreloses, the
 * seeded item rules group every item (figures hand-computed in src/analytics/mix.test.ts) → the
 * Mix page shows revenue per group per doctor, the comparison with the clinic average, surgery /
 * consult revenue and top items (with CSV) → the owner assigns the unmapped "Skin scraping test"
 * to Diagnostics in Settings → Items and adds / deletes a rule → the Mix page follows at once,
 * without another sync. The Doctors page has revenue per working day, the Overview surgery and
 * consult tiles.
 */
const { both } = SYNTHETIC_ACCOUNTS;
const SEPTEMBER = "from=2026-09-01&to=2026-09-30";

const rows = (table: Locator) => table.getByTestId("data-table-row");
const cell = (row: Locator, column: string) => row.locator(`[data-column="${column}"]`);
const rowWhere = (table: Locator, column: string, name: string) =>
  rows(table).filter({ has: table.page().locator(`[data-column="${column}"]`, { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }) });

async function tableText(table: Locator, columns: string[]): Promise<string[][]> {
  const result: string[][] = [];
  for (const row of await rows(table).all()) {
    result.push(await Promise.all(columns.map(async (column) => (await cell(row, column).innerText()).replace(/\s+/g, " ").trim())));
  }
  return result;
}

async function downloadCsv(page: Page, table: Locator): Promise<{ name: string; text: string }> {
  const [download] = await Promise.all([page.waitForEvent("download"), table.getByRole("button", { name: "Export CSV" }).first().click()]);
  return { name: download.suggestedFilename(), text: await readFile((await download.path())!, "utf8") };
}

/** Item settings back to the seeded rules only (and no derived classifications left behind). */
async function clearItemSettings() {
  await withRunDatabase(async (sql) => {
    await sql`delete from item_assignments`;
    await sql`delete from item_classifications`;
    await sql`delete from item_group_rules where source = 'owner'`;
  });
}

async function clearAll() {
  await clearSyncedData();
  await clearItemSettings();
}

test.describe("Item groups → Mix page", () => {
  test.beforeEach(clearAll);
  test.afterAll(clearAll);

  test("the owner sees the service mix, assigns an unmapped item and edits the rules; every figure follows at once", async ({ page, browser }) => {
    await signIn(page, run.ownerEmail);
    const card = await addConnection(page, { label: "Both branches", email: both.email, password: both.password });
    await syncMonth(card, "September 2026");

    // --- The Mix page: revenue per group per doctor (seeded rules). ---
    await page.goto(`/mix?${SEPTEMBER}`);
    await expect(page.getByRole("heading", { level: 1, name: "Mix" })).toBeVisible();
    const revenue = page.getByTestId("mix-revenue");
    const mixColumns = ["name", "revenue", "consult", "surgery", "diagnostics", "hospital_treatment", "preventive", "unmapped"];
    expect(await tableText(revenue, mixColumns)).toEqual([
      ["Dr Bravo Brown", "RM 3,352.00", "RM 176.15", "RM 700.00", "RM 0.00", "RM 1,423.31", "RM 1,052.54", "RM 0.00"],
      ["Dr Alpha Anderson", "RM 1,654.35", "RM 144.00", "RM 864.00", "RM 0.00", "RM 0.00", "RM 300.50", "RM 153.85"],
      ["Dr Delta", "RM 480.00", "RM 84.37", "RM 0.00", "RM 515.63", "RM 0.00", "RM 0.00", "RM 0.00"],
      ["All doctors (clinic average)", "RM 5,486.35", "RM 404.52", "RM 1,564.00", "RM 515.63", "RM 1,423.31", "RM 1,353.04", "RM 153.85"],
      ["Whole clinic", "RM 5,855.40", "RM 404.52", "RM 1,564.00", "RM 515.63", "RM 1,472.04", "RM 1,353.04", "RM 253.75"],
    ]);
    await expect(page.getByTestId("unmapped-note")).toContainText("RM 253.75 in this period is on items no rule recognises");
    await expect(page.getByTestId("mix-chart").locator(".recharts-bar-rectangle").first()).toBeVisible();
    await expect(page.getByRole("img", { name: /^Revenue by service group: Dr Bravo Brown RM 3,352\.00 \(Consult RM 176\.15, Surgery RM 700\.00/ })).toBeVisible();

    const csv = await downloadCsv(page, revenue);
    expect(csv.name).toBe("mix-revenue_2026-09-01_to_2026-09-30.csv");
    expect(csv.text.split("\r\n").slice(0, 2)).toEqual([
      "﻿Doctor,Revenue (RM),Consult (RM),Surgery (RM),Diagnostics (RM),Hospital & treatment (RM),Rehab & TCVM (RM),Medicines & supplements (RM),Preventive (RM),Retail & other (RM),Unmapped (RM)",
      "Dr Bravo Brown,3352.00,176.15,700.00,0.00,1423.31,0.00,0.00,1052.54,0.00,0.00",
    ]);

    // Compared with all doctors together: shares and marked differences (±5 points).
    const share = page.getByTestId("mix-share");
    const alpha = rowWhere(share, "name", "Dr Alpha Anderson");
    await expect(cell(alpha, "surgery")).toContainText("52.2%");
    await expect(cell(alpha, "surgery")).toContainText("+23.7 pts");
    await expect(cell(alpha, "surgery").locator("[data-comparison]")).toHaveAttribute("data-comparison", "above");
    await expect(cell(alpha, "consult").locator("[data-comparison]")).toHaveAttribute("data-comparison", "in_line");
    await expect(cell(rowWhere(share, "name", "Dr Bravo Brown"), "surgery").locator("[data-comparison]")).toHaveAttribute("data-comparison", "below");
    // Its CSV has the shares AND what the cells mark: the difference in points and above / below / in line.
    const shareCsv = (await downloadCsv(page, share)).text.split("\r\n");
    const shareHeader = shareCsv[0]!.replace("﻿", "").split(",");
    const alphaCsv = Object.fromEntries(shareCsv.find((line) => line.startsWith("Dr Alpha Anderson,"))!.split(",").map((value, index) => [shareHeader[index], value]));
    expect([alphaCsv["Surgery (%)"], alphaCsv["Surgery vs average (points)"], alphaCsv["Surgery vs average"]]).toEqual(["52.2", "23.70", "Above"]);
    expect([alphaCsv["Consult (%)"], alphaCsv["Consult vs average (points)"], alphaCsv["Consult vs average"]]).toEqual(["8.7", "1.30", "In line"]);
    const averageCsv = shareCsv.find((line) => line.startsWith("All doctors (clinic average),"))!.split(",");
    expect(averageCsv[shareHeader.indexOf("Surgery (%)")]).toBe("28.5");
    expect(averageCsv[shareHeader.indexOf("Surgery vs average")]).toBe("");

    // Surgery and consult revenue per doctor; top items per doctor (N switchable).
    expect(await tableText(page.getByTestId("service-lines"), ["name", "surgery", "surgery-share", "consult", "consult-share"])).toEqual([
      ["Dr Bravo Brown", "RM 700.00", "20.9%", "RM 176.15", "5.3%"],
      ["Dr Alpha Anderson", "RM 864.00", "52.2%", "RM 144.00", "8.7%"],
      ["Dr Delta", "RM 0.00", "0.0%", "RM 84.37", "17.6%"],
      ["All revenue", "RM 1,564.00", "26.7%", "RM 404.52", "6.9%"],
    ]);
    await page.getByRole("navigation", { name: "Top items per doctor" }).getByRole("link", { name: "Top 3" }).click();
    await expect(page).toHaveURL(/[?&]top=3/);
    await expect(page.getByRole("heading", { name: "Top 3 items per doctor" })).toBeVisible();
    expect(await tableText(page.getByTestId("top-items"), ["doctor", "rank", "item", "group", "revenue"])).toEqual([
      ["Dr Bravo Brown", "1", "Dental scaling", "Preventive", "RM 1,052.54"],
      ["Dr Bravo Brown", "2", "Hospitalisation (per day)", "Hospital & treatment", "RM 1,023.31"],
      ["Dr Bravo Brown", "3", "Surgery - Wound stitching", "Surgery", "RM 700.00"],
      ["Dr Alpha Anderson", "1", "Surgery - Spay", "Surgery", "RM 864.00"],
      ["Dr Alpha Anderson", "2", 'Antibiotic tablets "Amoxi" {250mg}', "Medicines & supplements", "RM 192.00"],
      ["Dr Alpha Anderson", "3", "Deworming tablets", "Preventive", "RM 180.50"],
      ["Dr Delta", "1", "X-ray", "Diagnostics", "RM 515.63"],
      ["Dr Delta", "2", "Consultation", "Consult", "RM 84.37"],
    ]);

    // --- The Doctors page: revenue per working day; the Overview: surgery and consult KPIs. ---
    await page.goto(`/doctors?${SEPTEMBER}`);
    expect(await tableText(page.getByTestId("doctor-ranking"), ["doctor", "working-days", "per-working-day"])).toEqual([
      ["Dr Bravo Brown", "3", "RM 1,117.33"],
      ["Dr Alpha Anderson", "1", "RM 1,654.35"],
      ["Dr Delta Not in staff list", "1", "RM 480.00"],
    ]);
    await page.goto(`/overview?${SEPTEMBER}`);
    await expect(page.getByTestId("kpi-surgery").getByTestId("kpi-value")).toHaveText("RM 1,564.00");
    await expect(page.getByTestId("kpi-consult").getByTestId("kpi-value")).toHaveText("RM 404.52");
    await expect(page.getByTestId("service-lines-pending-note")).toHaveCount(0);
    // A sale whose line items are not synced yet is in revenue but in neither service line: the page says so.
    const pendAt = (delta: number) =>
      withRunDatabase((sql) => sql`update invoices set header_version = header_version + ${delta} where kreloses_sale_id = '700104'`);
    await pendAt(1);
    try {
      await page.reload();
      await expect(page.getByTestId("kpi-revenue").getByTestId("kpi-value")).toHaveText("RM 5,855.40");
      await expect(page.getByTestId("kpi-surgery").getByTestId("kpi-value")).toHaveText("RM 1,564.00");
      await expect(page.getByTestId("service-lines-pending-note")).toHaveText(
        "1 invoice in this period (RM 2,300.00) has line items not synced yet: it is in revenue, invoices and customers, but not yet in surgery or consult revenue. The next sync reads it.",
      );
    } finally {
      await pendAt(-1);
    }

    // --- Settings → Items: unmapped items by revenue; assign one. ---
    await page.goto(`/mix?${SEPTEMBER}`);
    await page.getByTestId("unmapped-note").getByRole("link", { name: "Assign them to a group" }).click();
    await expect(page).toHaveURL(/\/settings\/items\?from=2026-09-01&to=2026-09-30$/);
    await expect(page.getByRole("heading", { level: 2, name: "Items" })).toBeVisible();
    const unmapped = page.getByTestId("unmapped-items");
    expect(await tableText(unmapped, ["item", "type", "revenue"])).toEqual([
      ["Skin scraping test", "Service", "RM 153.85"],
      ["Ear cleaner 100ml", "Product", "RM 54.90"],
      ["Microchip", "Service", "RM 45.00"],
    ]);
    const skin = rowWhere(unmapped, "item", "Skin scraping test");
    await skin.getByRole("combobox", { name: "Group for “Skin scraping test”" }).selectOption({ label: "Diagnostics" });
    await skin.getByRole("button", { name: "Save" }).click();
    await expect(rows(unmapped)).toHaveCount(2);
    const skinItem = rowWhere(page.getByTestId("all-items"), "item", "Skin scraping test");
    await expect(cell(skinItem, "group")).toHaveText("Diagnostics");
    await expect(cell(skinItem, "decided-by")).toHaveText("Your assignment");

    // A rule: every "Microchip" is Preventive. Added, then deleted again.
    const addRule = page.getByRole("form", { name: "Add a rule" });
    await addRule.getByLabel("Match").selectOption({ label: "Exact name" });
    await addRule.getByLabel("Item name or pattern").fill("Microchip");
    await addRule.getByLabel("Priority").fill("100");
    await addRule.getByRole("combobox", { name: "Group for “new rule”" }).selectOption({ label: "Preventive" });
    await addRule.getByRole("button", { name: "Add rule" }).click();
    await expect(addRule.getByRole("status")).toContainText("Rule added");
    await expect(rows(unmapped)).toHaveCount(1);
    const rule = rowWhere(page.getByTestId("item-rules"), "pattern", "microchip");
    await expect(cell(rule, "match")).toHaveText("Exact name");
    await expect(cell(rule, "items")).toHaveText("1");
    await rule.getByRole("button", { name: "Delete rule “microchip”" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete rule" }).click();
    await expect(rows(unmapped)).toHaveCount(2);
    await expect(rowWhere(page.getByTestId("item-rules"), "pattern", "microchip")).toHaveCount(0);

    // A "leave unmapped" rule: the item stays unmapped, and the list says which rule keeps it there.
    await addRule.getByLabel("Match").selectOption({ label: "Pattern" });
    await addRule.getByLabel("Item name or pattern").fill("%ear clean%");
    await addRule.getByRole("combobox", { name: "Group for “new rule”" }).selectOption({ label: "Leave unmapped (no group)" });
    await addRule.getByRole("button", { name: "Add rule" }).click();
    await expect(addRule.getByRole("status")).toContainText("Rule added");
    const leave = rowWhere(page.getByTestId("item-rules"), "pattern", "%ear clean%");
    await expect(cell(leave, "group")).toHaveText("Leave unmapped");
    await expect(cell(leave, "items")).toHaveText("1");
    await expect(cell(rowWhere(page.getByTestId("all-items"), "item", "Ear cleaner 100ml"), "decided-by")).toHaveText("Pattern rule “%ear clean%” (leave unmapped)");
    await expect(rows(unmapped)).toHaveCount(2);
    await leave.getByRole("button", { name: "Delete rule “%ear clean%”" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete rule" }).click();
    await expect(rowWhere(page.getByTestId("item-rules"), "pattern", "%ear clean%")).toHaveCount(0);

    // --- The Mix page follows at once (no sync in between). ---
    await page.goto(`/mix?${SEPTEMBER}`);
    expect(await tableText(revenue, ["name", "diagnostics", "unmapped"])).toEqual([
      ["Dr Bravo Brown", "RM 0.00", "RM 0.00"],
      ["Dr Alpha Anderson", "RM 153.85", "RM 0.00"],
      ["Dr Delta", "RM 515.63", "RM 0.00"],
      ["All doctors (clinic average)", "RM 669.48", "RM 0.00"],
      ["Whole clinic", "RM 669.48", "RM 99.90"],
    ]);
    await expect(page.getByTestId("unmapped-note")).toContainText("RM 99.90");

    // A manager sees the Mix page but not the item settings.
    const managerContext = await browser.newContext();
    try {
      const manager = await managerContext.newPage();
      await signIn(manager, run.managerEmail);
      await manager.goto(`/mix?${SEPTEMBER}`);
      await expect(rowWhere(manager.getByTestId("mix-revenue"), "name", "Dr Alpha Anderson").locator('[data-column="diagnostics"]')).toHaveText("RM 153.85");
      await expect(manager.getByTestId("unmapped-note")).toContainText("The clinic owner can assign them");
      await manager.goto("/settings/items");
      await expect(manager).toHaveURL(/\/forbidden$/);
    } finally {
      await managerContext.close();
    }

    // More than 100 unmapped items: the page says how many and shows the top 100; the CSV has all of them.
    await withRunDatabase(async (sql) => {
      const [branch] = await sql<{ id: string }[]>`select id::text from branches order by id limit 1`;
      const [invoice] = await sql<{ id: string }[]>`
        insert into invoices (kreloses_sale_id, sale_number, branch_id, sale_at, status, status_name, gross_amount, discount_amount,
          net_amount, tax_amount, total_amount, payment_status, total_payments, total_refunds, raw_header, fetched_at)
        values ('e2e-many-items', 'INV-E2E', ${branch!.id}, now(), 'cancelled', 'Cancelled', 0, 0, 0, 0, 0, 'Unpaid', 0, 0, '{}', now())
        returning id::text
      `;
      const names = Array.from({ length: 101 }, (_, index) => ({ line_no: index + 1, item_name: `Synthetic odd item ${String(index + 1).padStart(3, "0")}` }));
      await sql`
        insert into invoice_lines (invoice_id, line_no, item_name, item_type, quantity, unit_price, amount)
        select ${invoice!.id}::bigint, r.line_no, r.item_name, 1, 1, 0, 0
        from jsonb_to_recordset(${sql.json(names)}) as r(line_no integer, item_name text)
      `;
    });
    await page.goto(`/settings/items?${SEPTEMBER}`);
    await expect(page.getByTestId("unmapped-count")).toHaveText("103 unmapped items: the top 100 are shown; the CSV has all of them.");
    await expect(rows(unmapped)).toHaveCount(100);
    const unmappedCsv = await downloadCsv(page, unmapped);
    expect(unmappedCsv.text.split("\r\n").filter(Boolean)).toHaveLength(1 + 103);

    // On a phone, nothing scrolls sideways (tables scroll inside themselves).
    await page.setViewportSize({ width: 390, height: 844 });
    for (const path of [`/mix?${SEPTEMBER}`, `/settings/items?${SEPTEMBER}`]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    }
  });
});
