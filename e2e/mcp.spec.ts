import { readFile } from "node:fs/promises";

import { expect, test, type APIRequestContext } from "@playwright/test";

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
 * the data as of per branch.
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
    expect(list.result.tools.map((tool) => tool.name).sort()).toEqual(["data_freshness", "doctor_performance", "search_sales"]);
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
    expect(csv.slice(1)).toEqual(
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
});
