import { readFile } from "node:fs/promises";

import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

import { formatDayWithWeekday } from "../src/filters/dates";
import { SYNTHETIC_ACCOUNTS } from "../src/kreloses/testing/synthetic-accounts";

import { signIn } from "./support/auth";
import { addConnection, syncMonth } from "./support/connections";
import { clearSyncedData } from "./support/db";
import { run } from "./support/run";

/**
 * The MCP server over real HTTP against the running app (what `curl` or Claude would send):
 * refused without the bearer token (a dashboard session does not open it either), then — after
 * "Sync now" of September 2026 from the fake Kreloses — `doctor_performance` returns exactly the
 * numbers the Doctors page exports, `search_sales` finds a customer's sales, and every answer states
 * the data as of per branch; `daily_sales`, `item_mix`, `retention` and `discounts` (#18) return
 * exactly what the Daily, Mix, Retention and Discounts pages export as CSV.
 */
const { both } = SYNTHETIC_ACCOUNTS;
const TOKEN = process.env.E2E_MCP_BEARER_TOKEN!;
const SEPTEMBER = { dateFrom: "2026-09-01", dateTo: "2026-09-30" };
const HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

let nextId = 1;
function rpc(request: APIRequestContext, method: string, params: Record<string, unknown>, token: string | null = TOKEN) {
  return request.post("/api/mcp", {
    headers: token === null ? HEADERS : { ...HEADERS, Authorization: `Bearer ${token}` },
    data: { jsonrpc: "2.0", id: nextId++, method, params },
  });
}

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent: Record<string, unknown> & { dataFreshness: { branches: { branchName: string; dataAsOf: string | null }[] } };
}

async function callTool(request: APIRequestContext, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const response = await rpc(request, "tools/call", { name, arguments: args });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { result: ToolResult };
  expect(body.result.isError, body.result.content?.[0]?.text).toBeFalsy();
  return body.result;
}

test.describe("MCP server for Claude", () => {
  test.beforeEach(clearSyncedData);
  test.afterAll(clearSyncedData);

  test("refuses requests without the token; answers with the Doctors page's numbers and states data freshness", async ({ page, request }) => {
    // No token, a wrong token, or only a dashboard session: 401 with a Bearer challenge.
    const anonymous = await rpc(request, "tools/list", {}, null);
    expect(anonymous.status()).toBe(401);
    expect(anonymous.headers()["www-authenticate"]).toBe('Bearer realm="kreloses-mcp"');
    const wrong = await rpc(request, "tools/list", {}, "not-the-token-0123456789abcdefghijklmnop");
    expect(wrong.status()).toBe(401);
    expect(wrong.headers()["www-authenticate"]).toContain('error="invalid_token"');
    await signIn(page, run.ownerEmail);
    expect((await rpc(page.request, "tools/list", {}, null)).status()).toBe(401);

    // With the token: the MCP handshake, then exactly the read-only tools.
    const initialize = await rpc(request, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
    expect(initialize.status()).toBe(200);
    expect(await initialize.json()).toMatchObject({ result: { serverInfo: { name: "kreloses-analytics" } } });
    const list = (await (await rpc(request, "tools/list", {})).json()) as { result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] } };
    expect(list.result.tools.map((tool) => tool.name).sort()).toEqual([
      "daily_sales",
      "data_freshness",
      "discounts",
      "doctor_performance",
      "item_mix",
      "retention",
      "search_sales",
    ]);
    // A new tool is behind the token too.
    expect((await rpc(request, "tools/call", { name: "daily_sales", arguments: {} }, null)).status()).toBe(401);
    expect(list.result.tools.every((tool) => tool.annotations.readOnlyHint)).toBe(true);

    // Sync September 2026 through the app, as the owner would.
    const card = await addConnection(page, { label: "Both branches", email: both.email, password: both.password });
    await syncMonth(card, "September 2026");

    // doctor_performance = the Doctors page's CSV export for the same filter, number for number.
    const performance = await callTool(request, "doctor_performance", SEPTEMBER);
    const ranking = performance.structuredContent.ranking as {
      totalRevenue: string;
      doctors: { name: string; revenue: string; sharePercent: number; aovPerCustomer: string; invoices: number; itemsPerInvoice: number; customers: number }[];
    };
    expect(ranking.totalRevenue).toBe("5755.40");
    await page.goto(`/doctors?from=${SEPTEMBER.dateFrom}&to=${SEPTEMBER.dateTo}`);
    const table = page.getByTestId("doctor-ranking");
    const [download] = await Promise.all([page.waitForEvent("download"), table.getByRole("button", { name: "Export CSV" }).click()]);
    const csv = (await readFile((await download.path())!, "utf8")).replace(/^\uFEFF/, "").trim().split("\r\n");
    // The ranking's columns (the page also has working-day columns, #9, which doctor_performance does not return).
    expect(csv[0]!.split(",").slice(0, 7)).toEqual(["Doctor", "Revenue (RM)", "Share of revenue (%)", "AOV per customer (RM)", "Invoices", "Items per invoice", "Customers"]);
    expect(csv.slice(1).map((line) => line.split(",").slice(0, 7).join(","))).toEqual(
      ranking.doctors.map((d) => [d.name, d.revenue, d.sharePercent.toFixed(1), d.aovPerCustomer, d.invoices, d.itemsPerInvoice.toFixed(2), d.customers].join(",")),
    );
    expect(csv.slice(1)).toHaveLength(3);

    // Every answer says how fresh the data is, per branch, in the data and in words.
    expect(performance.structuredContent.dataFreshness.branches.map((branch) => [branch.branchName, branch.dataAsOf !== null])).toEqual([
      ["Branch North", true],
      ["Branch South", true],
    ]);
    expect(performance.content[0]!.text).toMatch(/\nData as of \(clinic time, Asia\/Kuala_Lumpur\): Branch North \d+ \w+ 2026, \d\d:\d\d; Branch South /);

    // search_sales: a customer's September sales, each with its credited split.
    const search = await callTool(request, "search_sales", { ...SEPTEMBER, customer: "Customer 0001" });
    expect(search.structuredContent.search).toMatchObject({
      totalMatches: 2,
      totalRevenue: "1450.00",
      sales: [
        { saleNumber: "INV-S-0203", revenue: "250.00", credits: [{ name: "Dr Alpha Anderson", revenue: "153.85" }, { name: "Dr Bravo Brown", revenue: "96.15" }] },
        { saleNumber: "INV-N-0101", revenue: "1200.00", credits: [{ name: "Dr Alpha Anderson", revenue: "1200.00" }] },
      ],
    });

    // data_freshness: the connection's latest sync, and a helpful error for an ambiguous name.
    const freshness = await callTool(request, "data_freshness", SEPTEMBER);
    expect(freshness.structuredContent.connections).toEqual([
      expect.objectContaining({ label: "Both branches", loginStatus: "ok", lastRun: expect.objectContaining({ mode: "manual", outcome: "succeeded" }) }),
    ]);
    const ambiguous = (await (await rpc(request, "tools/call", { name: "doctor_performance", arguments: { branches: ["Branch"] } })).json()) as { result: ToolResult };
    expect(ambiguous.result.isError).toBe(true);
    expect(ambiguous.result.content[0]!.text).toContain('Branch "Branch" matches more than one branch: Branch North');
  });

  test("daily_sales, item_mix, retention and discounts answer with exactly their pages' numbers", async ({ page, request }) => {
    await signIn(page, run.ownerEmail);
    const card = await addConnection(page, { label: "Both branches", email: both.email, password: both.password });
    await syncMonth(card, "September 2026");

    // daily_sales = the Daily page's "By doctor" CSV for 20 Sep 2026 (doctors, then the groups by name).
    const daily = (await callTool(request, "daily_sales", { day: "2026-09-20" })).structuredContent.daily as DailyAnswer;
    expect(daily.day).toBe("2026-09-20");
    await page.goto("/daily?day=2026-09-20");
    const dailyCsv = await downloadCsv(page, page.getByTestId("daily-doctors"));
    const dailyColumns = ["Doctor", "Revenue (RM)", "Revenue vs last week (RM)", "Invoices", "Customers", "AOV per customer (RM)"];
    expect(pick(dailyCsv, dailyColumns)).toEqual(
      [...daily.doctors, ...daily.groups.map((group) => ({ ...group, name: group.label }))].map((row) => [
        row.name,
        row.revenue.value,
        row.revenue.lastWeek.change,
        String(row.invoices.value),
        String(row.customers.value),
        row.aovPerCustomer.value ?? "",
      ]),
    );
    expect(dailyCsv.length).toBeGreaterThanOrEqual(3);
    // No day: yesterday at the clinic, as on the Daily page (the app's clock is CLINIC_NOW).
    const yesterday = (await callTool(request, "daily_sales", {})).structuredContent.daily as DailyAnswer;
    await page.goto("/daily");
    await expect(page.getByTestId("daily-day")).toContainText(formatDayWithWeekday(yesterday.day));

    // item_mix = the Mix page's "Revenue by service group" CSV (doctors, all doctors, whole clinic).
    const mixResult = (await callTool(request, "item_mix", SEPTEMBER)).structuredContent;
    const mix = mixResult.mix as { doctors: MixRow[]; allDoctors: MixRow; clinic: MixRow };
    const groups = Object.keys(mix.allDoctors.groups);
    const labels = mixResult.groupLabels as Record<string, string>;
    await page.goto(`/mix?from=${SEPTEMBER.dateFrom}&to=${SEPTEMBER.dateTo}`);
    const mixCsv = await downloadCsv(page, page.getByTestId("mix-revenue"));
    expect(pick(mixCsv, ["Doctor", "Revenue (RM)", ...groups.map((group) => `${labels[group]} (RM)`)])).toEqual(
      [...mix.doctors, { ...mix.allDoctors, name: "All doctors (clinic average)" }, { ...mix.clinic, name: "Whole clinic" }].map((row) => [
        row.name!,
        row.revenue,
        ...groups.map((group) => row.groups[group]!.revenue),
      ]),
    );
    expect(mix.doctors).toHaveLength(3);

    // retention = the Retention page's "New vs returning" CSV (the whole clinic, then doctors with customers).
    const retention = (await callTool(request, "retention", SEPTEMBER)).structuredContent.retention as {
      clinic: { newVsReturning: NewVsReturning };
      doctors: { name: string; newVsReturning: NewVsReturning }[];
    };
    await page.goto(`/retention?from=${SEPTEMBER.dateFrom}&to=${SEPTEMBER.dateTo}`);
    const retentionCsv = await downloadCsv(page, page.getByTestId("new-vs-returning"));
    expect(pick(retentionCsv, ["Doctor", "Customers seen", "New", "New share (%)", "Returning", "Returning share (%)"])).toEqual(
      [{ name: "Whole clinic (all staff)", newVsReturning: retention.clinic.newVsReturning }, ...retention.doctors]
        .filter((row) => row.newVsReturning.customers > 0)
        .map(({ name, newVsReturning: n }) => [name, String(n.customers), String(n.newCustomers), fixed(n.newPercent), String(n.returningCustomers), fixed(n.returningPercent)]),
    );
    expect(retention.clinic.newVsReturning.customers).toBeGreaterThan(0);

    // discounts = the Discounts page's per-doctor and discount-type CSVs.
    const discountsResult = (await callTool(request, "discounts", SEPTEMBER)).structuredContent;
    const discounts = discountsResult.discounts as { total: { discount: string }; doctors: DiscountRow[] };
    const types = discountsResult.types as { types: { label: string; amount: string; invoices: number }[] };
    expect(discounts.total.discount).toBe("280.00");
    await page.goto(`/discounts?from=${SEPTEMBER.dateFrom}&to=${SEPTEMBER.dateTo}`);
    const byDoctor = await downloadCsv(page, page.getByTestId("doctor-discounts"));
    expect(pick(byDoctor, ["Doctor", "Discount (RM)", "Discount rate (%)", "Invoices discounted (%)", "Invoices"])).toEqual(
      discounts.doctors.map((row) => [row.name, row.discount, fixed(row.discountRatePercent), fixed(row.discountedInvoicesPercent), String(row.invoices)]),
    );
    const byType = await downloadCsv(page, page.getByTestId("discount-types"));
    expect(pick(byType, ["Discount", "Amount (RM)", "Invoices"])).toEqual(types.types.map((row) => [row.label, row.amount, String(row.invoices)]));
  });
});

interface Metric<T> {
  value: T;
  lastWeek: { base: T; change: T; changePercent: number | null };
}
interface DailyRow {
  name: string;
  revenue: Metric<string>;
  invoices: Metric<number>;
  customers: Metric<number>;
  aovPerCustomer: Metric<string | null>;
}
interface DailyAnswer {
  day: string;
  doctors: DailyRow[];
  groups: (Omit<DailyRow, "name"> & { label: string })[];
}
interface MixRow {
  name?: string;
  revenue: string;
  groups: Record<string, { revenue: string } | undefined>;
}
interface NewVsReturning {
  customers: number;
  newCustomers: number;
  returningCustomers: number;
  newPercent: number | null;
  returningPercent: number | null;
}
interface DiscountRow {
  name: string;
  discount: string;
  discountRatePercent: number | null;
  discountedInvoicesPercent: number | null;
  invoices: number;
}

/** A percentage as the CSV writes it ("50.0"; empty for none). */
const fixed = (value: number | null) => (value === null ? "" : value.toFixed(1));

/** A table's CSV export, parsed (RFC 4180: quoted cells, doubled quotes), one record per row keyed by header. */
async function downloadCsv(page: Page, table: Locator): Promise<Record<string, string>[]> {
  const [download] = await Promise.all([page.waitForEvent("download"), table.getByRole("button", { name: "Export CSV" }).first().click()]);
  const [header, ...rows] = (await readFile((await download.path())!, "utf8"))
    .replace(/^﻿/, "")
    .trim()
    .split("\r\n")
    .map(splitCsvLine);
  return rows.map((row) => Object.fromEntries(header!.map((name, index) => [name, row[index] ?? ""])));
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        cell += '"';
        index++;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      cells.push(cell);
      cell = "";
    } else cell += char;
  }
  cells.push(cell);
  return cells;
}

/** The given columns of every CSV row (failing clearly when the page has no such column). */
function pick(rows: Record<string, string>[], columns: string[]): string[][] {
  for (const column of columns) expect(rows[0] ?? {}, `CSV column "${column}"`).toHaveProperty([column]);
  return rows.map((row) => columns.map((column) => row[column]!));
}
