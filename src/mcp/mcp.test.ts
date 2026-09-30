import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  DAILY_GROUP_LABELS,
  getDailySales,
  getDataFreshness,
  getDiscountTypes,
  getDoctorDiscounts,
  getDoctorRanking,
  getPendingLineItems,
  getRetention,
  getServiceLinesByDoctor,
  getServiceMix,
  getTopItemsByDoctor,
  METRIC_DEFINITIONS,
  MIX_BUCKET_LABELS,
  searchSales,
  type ClinicMixBucket,
  type DailySales,
  type DoctorRanking,
  type MixBucket,
  type ServiceMix,
} from "@/analytics";
import type { Sql } from "@/db/sql";
import { formatClinicDateTime, type GlobalFilter } from "@/filters";
import { useTestDatabase } from "@/db/testing";
import { SYNTHETIC_ACCOUNTS } from "@/kreloses/testing/fake-kreloses";
import { runSync } from "@/sync/engine";
import { clearSyncTables, createSyncHarness, type SyncHarness } from "@/sync/test-support";

import { handleMcpRequest, type McpHandlerDeps } from "./handler";
import { clinicTimestamp } from "./tools/clinic-time";
import { defineTool } from "./tools/define";
import { registerMcpTool } from "./tools/registry";
import { definitionExcerpt } from "./tools/text";

/**
 * The MCP server end to end, in process: the SDK's own client talks Streamable HTTP to the route
 * handler (`handleMcpRequest`, what `/api/mcp` runs) over a throwaway database that the Sync Engine
 * filled from the fake Kreloses (the fixtures of src/analytics/doctors.test.ts). Every tool must
 * return exactly what the dashboard's Analytics Service returns for the same filter.
 */
const TOKEN = "mcp-test-token-0123456789-abcdefghijklmnopqrstuvwxyz";
const URL_ = new URL("http://clinic.test/api/mcp");
/** 1 Oct 2026, 11:00 at the clinic: "month to date" is 1 Oct, which nobody has synced. */
const NOW = new Date("2026-10-01T03:00:00Z");
const SEPTEMBER = { dateFrom: "2026-09-01", dateTo: "2026-09-30" };
const { both } = SYNTHETIC_ACCOUNTS;
/** Every tool the server offers (spec story 62), all read-only. */
const TOOLS = ["daily_sales", "data_freshness", "discounts", "doctor_performance", "item_mix", "retention", "search_sales"];
/**
 * Each tool's arguments for September 2026 (daily_sales answers for one day: its last) and for a
 * period nobody has synced: today, 1 Oct (month to date; daily_sales: today, so far).
 */
const PERIODS: Record<string, { september: Record<string, unknown>; scope: { dateFrom: string; dateTo: string }; unsynced: Record<string, unknown> }> =
  Object.fromEntries(
    TOOLS.map((name) => [
      name,
      name === "daily_sales"
        ? { september: { day: "2026-09-30" }, scope: { dateFrom: "2026-09-30", dateTo: "2026-09-30" }, unsynced: { day: "2026-10-01" } }
        : { september: SEPTEMBER, scope: SEPTEMBER, unsynced: {} },
    ]),
  );

/** daily_sales's `daily`: getDailySales's result, each group with its name. */
type DailyAnswer = Omit<DailySales, "groups"> & { groups: (DailySales["groups"][number] & { label: string })[] };

type Structured = Record<string, unknown> & {
  dataFreshness: { summary: string; checkedAt: string; branches: { branchId: string; branchName: string; dataAsOf: string | null }[] };
  definitions: Record<string, string>;
};

describe("MCP server (Streamable HTTP, in process)", () => {
  const db = useTestDatabase();
  let h: SyncHarness;
  let branch: { north: string; south: string };
  let staff: Record<string, string>;
  const clients: Client[] = [];

  const deps = (overrides: Partial<McpHandlerDeps> = {}): McpHandlerDeps => ({ token: TOKEN, sql: () => db.sql, now: () => NOW, ...overrides });

  async function connect(options: { token?: string | null; deps?: McpHandlerDeps } = {}): Promise<Client> {
    const token = options.token === undefined ? TOKEN : options.token;
    const handlerDeps = options.deps ?? deps();
    const client = new Client({ name: "vitest", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(URL_, {
      fetch: (url, init) => handleMcpRequest(new Request(url, init), handlerDeps),
      requestInit: token === null ? {} : { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    clients.push(client);
    return client;
  }

  /** A raw HTTP request to the handler (what curl would send). */
  function post(body: unknown, headers: Record<string, string> = {}, handlerDeps: McpHandlerDeps = deps(), method = "POST") {
    return handleMcpRequest(
      new Request(URL_, {
        method,
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
        body: method === "POST" ? JSON.stringify(body) : undefined,
      }),
      handlerDeps,
    );
  }
  const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "curl", version: "1" } } };

  async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    return result;
  }
  async function structured(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Structured> {
    const result = await call(client, name, args);
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    return result.structuredContent as Structured;
  }
  const errorText = async (client: Client, name: string, args: Record<string, unknown>) => {
    const result = await call(client, name, args);
    expect(result.isError).toBe(true);
    return (result.content as { text: string }[]).map((part) => part.text).join("\n");
  };
  const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  /** A result's one-line summary (also the first line of its first text block, before the data-as-of sentence). */
  const summaryOf = (result: CallToolResult) => {
    const summary = (result.structuredContent as Structured).summary as string;
    expect((result.content as { text: string }[])[0]!.text.startsWith(`${summary}\n`)).toBe(true);
    return summary;
  };

  beforeAll(async () => {
    await clearSyncTables(db.sql);
    h = createSyncHarness(db.sql, { now: new Date("2026-10-01T02:00:00Z") });
    const connectionId = await h.connect(both, "Both branches");
    expect(await runSync(h.deps(), connectionId, "manual", { dateRange: { from: "2025-09-01", to: "2026-09-30" }, pageSize: 7 })).toMatchObject({
      status: "succeeded",
    });
    const branches = await db.sql<{ id: string; krelosesLocationId: string }[]>`select id::text, kreloses_location_id from branches`;
    branch = {
      north: branches.find((row) => row.krelosesLocationId === "1101")!.id,
      south: branches.find((row) => row.krelosesLocationId === "1102")!.id,
    };
    const rows = await db.sql<{ id: string; fullName: string }[]>`select id::text, full_name from staff`;
    staff = Object.fromEntries(rows.map((row) => [row.fullName, row.id]));
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    vi.restoreAllMocks();
  });

  describe("the bearer token", () => {
    const noDatabase = () => deps({ sql: () => { throw new Error("a refused request must not open the database"); } });

    it("refuses a request without the token (401 + Bearer challenge), before touching the database", async () => {
      const response = await post(initialize, {}, noDatabase());
      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toBe('Bearer realm="kreloses-mcp"');
      await expect(connect({ token: null, deps: noDatabase() })).rejects.toThrow();
      // Every tool is behind the same check, whatever it is called with.
      for (const name of TOOLS) {
        const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: PERIODS[name]!.september } };
        expect((await post(call, {}, noDatabase())).status, name).toBe(401);
      }
    });

    it("refuses a wrong token (401 invalid_token), for every method", async () => {
      for (const method of ["POST", "GET", "DELETE"]) {
        const response = await post(initialize, { Authorization: "Bearer not-the-token-0123456789abcdefghijkl" }, noDatabase(), method);
        expect(response.status).toBe(401);
        expect(response.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
      }
      await expect(connect({ token: `${TOKEN}-x`, deps: noDatabase() })).rejects.toThrow();
    });

    it("refuses everything when the server has no MCP_BEARER_TOKEN (fail closed)", async () => {
      for (const token of [undefined, ""]) {
        const response = await post(initialize, { Authorization: `Bearer ${TOKEN}` }, deps({ token, sql: noDatabase().sql }));
        expect(response.status).toBe(503);
        expect(await response.text()).toContain("MCP_BEARER_TOKEN");
      }
    });

    it("lets the right token in: initialize answers with plain JSON, no session; GET and DELETE are 405", async () => {
      const response = await post(initialize, { Authorization: `Bearer ${TOKEN}` });
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("application/json");
      expect(response.headers.get("Mcp-Session-Id")).toBeNull();
      expect(await response.json()).toMatchObject({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "kreloses-analytics" } } });
      for (const method of ["GET", "DELETE"]) {
        const refused = await post(null, { Authorization: `Bearer ${TOKEN}` }, deps(), method);
        expect(refused.status).toBe(405);
        expect(refused.headers.get("Allow")).toBe("POST");
      }
    });
  });

  describe("tools", () => {
    it("lists exactly the read-only tools: no raw SQL, nothing that writes or reaches Kreloses", async () => {
      const client = await connect();
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(TOOLS);
      for (const tool of tools) {
        expect(tool.annotations, tool.name).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
        // Unknown arguments are refused, never silently ignored (a misspelt filter must not widen the answer).
        expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
        // Claude Code cuts descriptions after 2,048 characters.
        expect(tool.description!.length, tool.name).toBeLessThanOrEqual(2048);
        expect(tool.description, tool.name).toContain("Asia/Kuala_Lumpur");
        expect(tool.outputSchema?.properties, tool.name).toHaveProperty("dataFreshness");
      }
      // The definitions quoted in descriptions are the dashboard's, verbatim.
      const described = Object.fromEntries(tools.map((tool) => [tool.name, tool.description!]));
      expect(described.doctor_performance).toContain(METRIC_DEFINITIONS.revenue);
      expect(described.doctor_performance).toContain(METRIC_DEFINITIONS.aovPerCustomer);
      expect(described.search_sales).toContain(METRIC_DEFINITIONS.salesSearch);
      expect(described.data_freshness).toContain(METRIC_DEFINITIONS.dataAsOf);
      // #18: credited-per-line revenue and AOV per customer, the service visit and cohort rules, the discount threshold.
      expect(described.daily_sales).toContain(METRIC_DEFINITIONS.revenue);
      expect(described.daily_sales).toContain(METRIC_DEFINITIONS.aovPerCustomer);
      expect(described.item_mix).toContain(definitionExcerpt("revenue", 2));
      expect(definitionExcerpt("revenue", 2)).toMatch(/credited line by line to the staff named on each line\. .*in proportion to what each line charged/);
      expect(described.item_mix).toContain(METRIC_DEFINITIONS.serviceMix);
      expect(described.item_mix).toContain(METRIC_DEFINITIONS.mixComparison);
      expect(described.retention).toContain(METRIC_DEFINITIONS.serviceVisit);
      expect(described.retention).toContain(definitionExcerpt("yearlyCohort", 2));
      expect(described.discounts).toContain(METRIC_DEFINITIONS.discount);
      expect(described.discounts).toContain(METRIC_DEFINITIONS.discountRate);
      expect(described.discounts).toContain(METRIC_DEFINITIONS.discountedInvoices);
      expect(described.discounts).toContain("over RM 0.05");
      expect(client.getInstructions()!.length).toBeLessThanOrEqual(2048);
      expect(client.getServerCapabilities()).not.toHaveProperty("resources");
      expect(client.getServerCapabilities()).not.toHaveProperty("prompts");
    });

    it("never writes: every table is byte-for-byte the same after calling every tool", async () => {
      const before = await tableDigests(db.sql);
      const client = await connect();
      for (const name of TOOLS) {
        await structured(client, name, {});
        await structured(client, name, PERIODS[name]!.september);
      }
      await structured(client, "doctor_performance", { ...SEPTEMBER, splitByBranch: true, branches: ["North"], doctors: ["Dr Alpha"] });
      await structured(client, "search_sales", { ...SEPTEMBER, customer: "Customer", item: "consult", minAmount: 1, sort: "largest" });
      await structured(client, "daily_sales", { day: "2026-09-20", branches: ["North"], doctors: ["Bravo"] });
      await structured(client, "item_mix", { ...SEPTEMBER, branches: ["South"], doctors: ["Delta"], groups: ["diagnostics"], topItems: 1 });
      await structured(client, "retention", { dateFrom: "2025-09-01", dateTo: "2026-09-30", branches: ["North"], doctors: ["Alpha"] });
      await structured(client, "discounts", { ...SEPTEMBER, branches: ["North"], doctors: ["Bravo"] });
      expect(await tableDigests(db.sql)).toEqual(before);
    });

    it("every result states data as of per branch (in the data and in the text) and carries its definitions verbatim", async () => {
      const client = await connect();
      for (const name of TOOLS) {
        const period = PERIODS[name]!;
        const expectedSeptember = await getDataFreshness(db.sql, period.scope);
        expect(expectedSeptember.every((row) => row.dataAsOf !== null), name).toBe(true);
        const asOf = expectedSeptember.map((row) => `${row.branchName} ${formatClinicDateTime(row.dataAsOf!)}`).join("; ");
        const september = await call(client, name, period.september);
        expect(september.isError, JSON.stringify(september.content)).toBeFalsy();
        const data = september.structuredContent as Structured;
        expect(data.dataFreshness.branches, name).toEqual(
          expectedSeptember.map((row) => ({ branchId: row.branchId, branchName: row.branchName, dataAsOf: clinicTimestamp(row.dataAsOf!) })),
        );
        expect(data.dataFreshness.checkedAt).toBe("2026-10-01T11:00:00+08:00");
        const text = (september.content as { text: string }[])[0]!.text;
        expect(text, name).toContain(`\nData as of (clinic time, Asia/Kuala_Lumpur): ${asOf}. Sales changed in Kreloses after that are not included.`);
        // The summary is in the structured result too (Claude Code shows the model only that when
        // both are present), and the same JSON is in the text (clients that read only text).
        expect(text, name).toBe(`${data.summary as string}\n${data.dataFreshness.summary}`);
        expect(JSON.parse((september.content as { text: string }[])[1]!.text)).toEqual(data);
        expect(data.definitions.dataAsOf).toBe(METRIC_DEFINITIONS.dataAsOf);
        for (const [key, definition] of Object.entries(data.definitions)) {
          expect(definition, key).toBe(METRIC_DEFINITIONS[key as keyof typeof METRIC_DEFINITIONS]);
        }

        // Month to date (1 Oct; daily_sales: today): no sync has read it, and the answer says so rather than looking current.
        const today = (await structured(client, name, period.unsynced)).dataFreshness;
        expect(today.branches.map((row) => row.dataAsOf), name).toEqual([null, null]);
        expect(today.summary).toContain("Branch North — no complete sync for 1 Oct 2026 yet, so its figures may be incomplete");
      }
    });
  });

  describe("doctor_performance", () => {
    it("returns exactly the Doctors page's ranking (getDoctorRanking) for the same filter", async () => {
      const client = await connect();
      const cases: { args: Record<string, unknown>; filter: GlobalFilter; split: boolean }[] = [
        { args: SEPTEMBER, filter: SEPTEMBER, split: false },
        { args: { ...SEPTEMBER, splitByBranch: true }, filter: SEPTEMBER, split: true },
        { args: { ...SEPTEMBER, branches: ["North"] }, filter: { ...SEPTEMBER, branchIds: [branch.north] }, split: false },
        { args: { ...SEPTEMBER, branches: [branch.south], doctors: ["Dr Alpha", "Bravo Brown"] }, filter: { ...SEPTEMBER, branchIds: [branch.south], doctorIds: [staff["Dr Alpha Anderson"]!, staff["Dr Bravo Brown"]!] }, split: false },
        { args: { dateFrom: "2025-09-01", dateTo: "2026-09-30", splitByBranch: true }, filter: { dateFrom: "2025-09-01", dateTo: "2026-09-30" }, split: true },
        // "last-month" on 1 Oct 2026 is September.
        { args: { preset: "last-month" }, filter: SEPTEMBER, split: false },
      ];
      for (const { args, filter, split } of cases) {
        const data = await structured(client, "doctor_performance", args);
        expect(data.ranking, JSON.stringify(args)).toEqual(json(await getDoctorRanking(db.sql, filter, { splitByBranch: split })));
        expect(data.pendingLineItems).toEqual(await getPendingLineItems(db.sql, filter));
      }
    });

    it("answers with the hand-computed figures, says what it covered and summarises in words", async () => {
      const client = await connect();
      const result = await call(client, "doctor_performance", { ...SEPTEMBER, doctors: ["dr. alpha"] });
      const data = result.structuredContent as Structured & { ranking: DoctorRanking };
      expect(data.covers).toEqual({ ...SEPTEMBER, branches: "all", doctors: [{ id: staff["Dr Alpha Anderson"], name: "Dr Alpha Anderson" }] });
      expect(data.ranking.totalRevenue).toBe("5755.40");
      expect(data.ranking.doctors.map((doctor) => [doctor.name, doctor.revenue, doctor.aovPerCustomer, doctor.invoices, doctor.itemsPerInvoice, doctor.sharePercent])).toEqual([
        ["Dr Alpha Anderson", "1654.35", "827.18", 3, 2, 28.7],
      ]);
      expect((result.content as { text: string }[])[0]!.text).toMatch(
        /^Doctor ranking for 1 Sep 2026 – 30 Sep 2026, all branches, doctor Dr Alpha Anderson: 1 doctor with revenue; highest Dr Alpha Anderson RM 1,654\.35 \(28\.7% of all revenue\)\. All revenue in the period: RM 5,755\.40\.\nData as of/,
      );
    });

    it("explains what was wrong with the arguments, so Claude can ask again", async () => {
      const client = await connect();
      expect(await errorText(client, "doctor_performance", { doctors: ["Zed"] })).toBe(
        'No doctor matches "Zed". Doctors: Dr Alpha Anderson (id ' + staff["Dr Alpha Anderson"] + "), Dr Bravo Brown (id " + staff["Dr Bravo Brown"] + "), Dr Delta (id " + staff["Dr Delta"] + ").",
      );
      expect(await errorText(client, "doctor_performance", { branches: ["Branch"] })).toContain('Branch "Branch" matches more than one branch: Branch North');
      expect(await errorText(client, "doctor_performance", { dateTo: "2026-09-30" })).toContain("dateTo needs a dateFrom");
      expect(await errorText(client, "doctor_performance", { dateFrom: "2026-09-30", dateTo: "2026-09-01" })).toContain("is after dateTo");
      expect(await errorText(client, "doctor_performance", { preset: "last-month", dateFrom: "2026-09-01" })).toContain("not both");
      expect(await errorText(client, "doctor_performance", { dateFrom: "2026-02-30" })).toContain("real calendar date");
      expect(await errorText(client, "doctor_performance", { dateFrom: "1/9/2026" })).toContain("YYYY-MM-DD");
      // A misspelt argument is refused, not ignored.
      expect(await errorText(client, "doctor_performance", { doctor: "Dr Alpha" })).toMatch(/unrecognized key/i);
    });
  });

  describe("search_sales", () => {
    it("returns exactly searchSales for the same filter and criteria, paged", async () => {
      const client = await connect();
      const cases: { args: Record<string, unknown>; filter: GlobalFilter; criteria: Parameters<typeof searchSales>[2] }[] = [
        { args: { ...SEPTEMBER, pageSize: 4 }, filter: SEPTEMBER, criteria: { pageSize: 4 } },
        { args: { ...SEPTEMBER, pageSize: 4, page: 3 }, filter: SEPTEMBER, criteria: { pageSize: 4, page: 3 } },
        { args: { ...SEPTEMBER, customer: "customer 0001" }, filter: SEPTEMBER, criteria: { customer: "customer 0001" } },
        { args: { ...SEPTEMBER, item: "Consult", sort: "largest" }, filter: SEPTEMBER, criteria: { item: "Consult", sort: "largest" } },
        { args: { ...SEPTEMBER, minAmount: 250, maxAmount: 1200, sort: "smallest" }, filter: SEPTEMBER, criteria: { minRevenue: "250.00", maxRevenue: "1200.00", sort: "smallest" } },
        { args: { ...SEPTEMBER, doctors: ["Alpha"], branches: ["South"] }, filter: { ...SEPTEMBER, doctorIds: [staff["Dr Alpha Anderson"]!], branchIds: [branch.south] }, criteria: {} },
      ];
      for (const { args, filter, criteria } of cases) {
        const data = await structured(client, "search_sales", args);
        expect(data.search, JSON.stringify(args)).toEqual(json(await searchSales(db.sql, filter, criteria)));
      }
    });

    it("finds a customer's sales with the credited split, and says how to get the next page", async () => {
      const client = await connect();
      const result = await call(client, "search_sales", { ...SEPTEMBER, pageSize: 4 });
      const data = result.structuredContent as Structured & { search: { totalMatches: number; totalPages: number; sales: { saleNumber: string }[] } };
      expect(data.search).toMatchObject({ totalMatches: 9, totalPages: 3, totalRevenue: "5755.40" });
      expect(data.search.sales.map((sale) => sale.saleNumber)).toEqual(["INV-N-0105", "INV-S-0205", "INV-N-0104", "INV-S-0203"]);
      expect(data.criteria).toEqual({ customer: null, item: null, minAmount: null, maxAmount: null, sort: "newest" });
      expect((result.content as { text: string }[])[0]!.text).toMatch(
        /^Found 9 sales \(RM 5,755\.40 in total\) for 1 Sep 2026 – 30 Sep 2026, all branches; showing 1–4, newest first \(page 1 of 3\)\. Ask for page 2 for more\.\n/,
      );

      const bigSpenders = await call(client, "search_sales", { ...SEPTEMBER, customer: "0001", minAmount: 1000 });
      expect((bigSpenders.content as { text: string }[])[0]!.text).toMatch(/^Found 1 sale \(RM 1,200\.00 in total\) for .*, all branches, matching customer "0001", revenue at least RM 1,000\.00; showing 1–1/);
      expect((bigSpenders.structuredContent as { search: { sales: unknown[] } }).search.sales).toEqual([
        expect.objectContaining({ saleNumber: "INV-N-0101", customerName: "Customer 0001", revenue: "1200.00", credits: [expect.objectContaining({ name: "Dr Alpha Anderson", revenue: "1200.00", lines: 3 })] }),
      ]);
    });

    it("caps the page size and checks amounts", async () => {
      const client = await connect();
      expect(await errorText(client, "search_sales", { pageSize: 51 })).toMatch(/pageSize/);
      expect(await errorText(client, "search_sales", { page: 0 })).toMatch(/page/);
      expect(await errorText(client, "search_sales", { minAmount: 1.234 })).toBe("minAmount must be an amount in RM with at most two decimals (e.g. 250 or 99.9).");
      expect(await errorText(client, "search_sales", { minAmount: 500, maxAmount: 100 })).toBe("minAmount (500.00) is more than maxAmount (100.00).");
    });

    it("refuses a blank customer or item instead of silently searching everything; trims spaces around names", async () => {
      const client = await connect();
      expect(await errorText(client, "search_sales", { ...SEPTEMBER, customer: "   " })).toMatch(/customer/);
      expect(await errorText(client, "search_sales", { ...SEPTEMBER, item: " \t " })).toMatch(/item/);
      const padded = await structured(client, "search_sales", { ...SEPTEMBER, customer: "  customer 0001 ", item: " consult " });
      expect(padded.criteria).toMatchObject({ customer: "customer 0001", item: "consult" });
      expect((padded.search as { totalMatches: number }).totalMatches).toBe(2);
    });
  });

  describe("data_freshness", () => {
    it("says, per connection, whether its login works and how its latest sync went", async () => {
      const client = await connect();
      const [run] = await db.sql<{ startedAt: Date; finishedAt: Date }[]>`select started_at, finished_at from sync_runs`;
      const [connection] = await db.sql<{ lastTestedAt: Date }[]>`select last_tested_at from connections`;
      const result = await call(client, "data_freshness", SEPTEMBER);
      const data = result.structuredContent as Structured & { connections: unknown[] };
      expect(data.connections).toEqual([
        {
          connectionId: expect.any(String),
          label: "Both branches",
          loginStatus: "ok",
          loginError: null,
          lastTestedAt: clinicTimestamp(connection!.lastTestedAt),
          lastRun: {
            mode: "manual",
            outcome: "succeeded",
            dateFrom: "2025-09-01",
            dateTo: "2026-09-30",
            startedAt: clinicTimestamp(run!.startedAt),
            finishedAt: clinicTimestamp(run!.finishedAt),
            error: null,
            warnings: [],
          },
        },
      ]);
      const finished = formatClinicDateTime(run!.finishedAt);
      expect((result.content as { text: string }[])[0]!.text).toBe(
        `Kreloses connections: Both branches — last sync succeeded (1 Sep 2025 – 30 Sep 2026, finished ${finished}).\n` +
          `Data as of (clinic time, Asia/Kuala_Lumpur): Branch North ${finished}; Branch South ${finished}. Sales changed in Kreloses after that are not included.`,
      );
    });
  });

  describe("daily_sales", () => {
    const withLabels = (daily: DailySales) => json({ ...daily, groups: daily.groups.map((group) => ({ ...group, label: DAILY_GROUP_LABELS[group.group] })) });

    it("returns exactly the Daily page's figures (getDailySales) for the same day, branches and doctors, each group with its name", async () => {
      const client = await connect();
      const cases: { args: Record<string, unknown>; day: string; filter: { branchIds?: string[]; doctorIds?: string[] } }[] = [
        // No day: yesterday at the clinic (it is 1 Oct, 11:00 in Kuala Lumpur).
        { args: {}, day: "2026-09-30", filter: {} },
        // Same weekday last week (1 Sep) had a sale; this day had none.
        { args: { day: "2026-09-08" }, day: "2026-09-08", filter: {} },
        // Same date last year (3 Sep 2025) had one.
        { args: { day: "2026-09-03" }, day: "2026-09-03", filter: {} },
        { args: { day: "2026-09-20", branches: ["North"] }, day: "2026-09-20", filter: { branchIds: [branch.north] } },
        { args: { day: "2026-09-18", doctors: ["Bravo", "Alpha"] }, day: "2026-09-18", filter: { doctorIds: [staff["Dr Bravo Brown"]!, staff["Dr Alpha Anderson"]!] } },
        // Today, so far.
        { args: { day: "2026-10-01" }, day: "2026-10-01", filter: {} },
      ];
      for (const { args, day, filter } of cases) {
        const data = await structured(client, "daily_sales", args);
        const expected = await getDailySales(db.sql, day, filter);
        expect(data.daily, JSON.stringify(args)).toEqual(withLabels(expected));
        expect(data.covers).toMatchObject({ dateFrom: day, dateTo: day });
        expect(data.pendingLineItems).toEqual(await getPendingLineItems(db.sql, { dateFrom: day, dateTo: day, branchIds: filter.branchIds }));
      }
      // The day and the two days it is compared with are echoed; groups carry a name as well as a stable key.
      const lastDay = (await structured(client, "daily_sales", { day: "2026-09-30" })).daily as DailyAnswer;
      expect([lastDay.day, lastDay.comparisonDays]).toEqual(["2026-09-30", { lastWeek: "2026-09-23", lastYear: "2025-09-30" }]);
      expect(lastDay.groups.map((group) => [group.group, group.label])).toEqual([
        ["other", "Other staff"],
        ["noStaff", "No staff on line"],
      ]);
    });

    it("summarises the day against the same weekday last week and the same date last year", async () => {
      const client = await connect();
      // 30 Sep 2026: 700105 (99.90: Charlie Chen 45.00, no staff 54.90); 23 Sep: nothing; 30 Sep 2025: 600003 (100.00, no staff).
      const result = await call(client, "daily_sales", {});
      expect(summaryOf(result)).toBe(
        "Daily sales for Wednesday 30 Sep 2026, all branches: revenue RM 99.90, 1 invoice, 1 customer, AOV per customer RM 99.90. " +
          "Revenue vs Wednesday 23 Sep 2026 (same weekday last week): +RM 99.90 (none then); vs Tuesday 30 Sep 2025 (same date last year): −RM 0.10 (−0.1%). " +
          "No revenue was credited to a doctor on the day.",
      );
      // 20 Sep 2026 at North, Dr Bravo Brown only: 700104's lines credited to him.
      const bravo = await call(client, "daily_sales", { day: "2026-09-20", branches: ["North"], doctors: ["Bravo"] });
      const bravoDaily = (bravo.structuredContent as { daily: DailySales }).daily;
      expect(bravoDaily.total.revenue.value).toBe("2075.85");
      expect(summaryOf(bravo)).toBe(
        "Daily sales for Sunday 20 Sep 2026, Branch North, doctor Dr Bravo Brown: revenue RM 2,075.85, 1 invoice, 1 customer, AOV per customer RM 2,075.85. " +
          "Revenue vs Sunday 13 Sep 2026 (same weekday last week): +RM 2,075.85 (none then); vs Saturday 20 Sep 2025 (same date last year): +RM 2,075.85 (none then). " +
          "Highest doctor: Dr Bravo Brown RM 2,075.85.",
      );
    });

    it("refuses a day that is not a real date, too early or in the future, instead of answering for another day", async () => {
      const client = await connect();
      expect(await errorText(client, "daily_sales", { day: "2026-10-02" })).toBe(
        "day 2026-10-02 is in the future: today at the clinic (Asia/Kuala_Lumpur) is 2026-10-01. Ask for today or an earlier day.",
      );
      expect(await errorText(client, "daily_sales", { day: "1999-12-31" })).toBe("day 1999-12-31 is before 2000-01-01, the earliest day daily_sales answers for.");
      expect(await errorText(client, "daily_sales", { day: "2026-02-30" })).toContain("real calendar date");
      expect(await errorText(client, "daily_sales", { day: "30/09/2026" })).toContain("YYYY-MM-DD");
      // One day, not a period: a date range is refused rather than ignored.
      expect(await errorText(client, "daily_sales", SEPTEMBER)).toMatch(/unrecognized key/i);
      // Every problem at once.
      const both = await errorText(client, "daily_sales", { day: "2026-10-02", doctors: ["Zed"] });
      expect(both).toContain("day 2026-10-02 is in the future");
      expect(both).toContain('No doctor matches "Zed"');
    });
  });

  describe("item_mix", () => {
    it("returns exactly the Mix page's data (getServiceMix, getTopItemsByDoctor, getServiceLinesByDoctor) for the same filter", async () => {
      const client = await connect();
      const cases: { args: Record<string, unknown>; filter: GlobalFilter; limit: number }[] = [
        { args: SEPTEMBER, filter: SEPTEMBER, limit: 5 },
        { args: { ...SEPTEMBER, topItems: 3 }, filter: SEPTEMBER, limit: 3 },
        { args: { ...SEPTEMBER, branches: ["North"] }, filter: { ...SEPTEMBER, branchIds: [branch.north] }, limit: 5 },
        { args: { ...SEPTEMBER, doctors: ["Alpha", "Delta"], topItems: 20 }, filter: { ...SEPTEMBER, doctorIds: [staff["Dr Alpha Anderson"]!, staff["Dr Delta"]!] }, limit: 20 },
        { args: { dateFrom: "2025-09-01", dateTo: "2026-09-30" }, filter: { dateFrom: "2025-09-01", dateTo: "2026-09-30" }, limit: 5 },
        { args: { preset: "last-month" }, filter: SEPTEMBER, limit: 5 },
      ];
      for (const { args, filter, limit } of cases) {
        const data = await structured(client, "item_mix", args);
        expect(data.mix, JSON.stringify(args)).toEqual(json(await getServiceMix(db.sql, filter)));
        expect(data.topItems).toEqual(json(await getTopItemsByDoctor(db.sql, filter, { limit })));
        expect(data.serviceLines).toEqual(json(await getServiceLinesByDoctor(db.sql, filter)));
        expect(data.pendingLineItems).toEqual(await getPendingLineItems(db.sql, filter));
        expect(data.groupLabels).toEqual(MIX_BUCKET_LABELS);
      }
    });

    it("narrows to some service groups: the mix shows only them, and top items are ranked within them", async () => {
      const client = await connect();
      const groups: MixBucket[] = ["diagnostics", "unmapped"];
      const data = await structured(client, "item_mix", { ...SEPTEMBER, groups });
      const full = await getServiceMix(db.sql, SEPTEMBER);
      const only = <Bucket extends ClinicMixBucket, Cell>(record: Record<Bucket, Cell>) =>
        Object.fromEntries(Object.entries(record).filter(([bucket]) => (groups as string[]).includes(bucket)));
      expect(data.mix).toEqual(
        json({
          ...full,
          doctors: full.doctors.map((doctor) => ({ ...doctor, groups: only(doctor.groups) })),
          allDoctors: { ...full.allDoctors, groups: only(full.allDoctors.groups) },
          clinic: { ...full.clinic, groups: only(full.clinic.groups) },
        } satisfies Record<keyof ServiceMix, unknown>),
      );
      expect(data.topItems).toEqual(json(await getTopItemsByDoctor(db.sql, SEPTEMBER, { groups })));
      expect(data.groupLabels).toEqual({ diagnostics: "Diagnostics", unmapped: "Unmapped" });
      // Hand-computed (src/analytics/mix.test.ts): Dr Delta's X-ray; the clinic's unmapped items.
      const mix = data.mix as ServiceMix;
      expect(mix.doctors.find((doctor) => doctor.name === "Dr Delta")!.groups.diagnostics).toMatchObject({ revenue: "515.63", sharePercent: 107.4 });
      expect(mix.clinic.groups.unmapped).toEqual({ revenue: "253.75", sharePercent: 4.4 });
    });

    it("summarises the clinic's largest groups and the unmapped items in words", async () => {
      const client = await connect();
      const result = await call(client, "item_mix", SEPTEMBER);
      expect(summaryOf(result)).toBe(
        "Service mix for 1 Sep 2026 – 30 Sep 2026, all branches: 3 doctors with revenue. " +
          "Whole clinic RM 5,755.40; largest groups Surgery RM 1,500.36 (26.1%), Hospital & treatment RM 1,435.68 (24.9%), Preventive RM 1,353.04 (23.5%). " +
          "RM 253.75 is on items no rule recognises (Unmapped); the owner can assign them to groups in Settings → Items.",
      );
      const narrowed = await call(client, "item_mix", { ...SEPTEMBER, groups: ["diagnostics", "unmapped"], doctors: ["Delta"] });
      expect(summaryOf(narrowed)).toBe(
        "Service mix for 1 Sep 2026 – 30 Sep 2026, all branches, doctor Dr Delta, groups Diagnostics and Unmapped: 1 doctor with revenue. " +
          "Whole clinic RM 5,755.40; Diagnostics RM 515.63 (9.0%), Unmapped RM 253.75 (4.4%). " +
          "RM 253.75 is on items no rule recognises (Unmapped); the owner can assign them to groups in Settings → Items.",
      );
    });

    it("refuses an unknown group or too many top items", async () => {
      const client = await connect();
      expect(await errorText(client, "item_mix", { groups: ["dental"] })).toMatch(/expected one of .*"diagnostics".* at groups\[0\]/);
      expect(await errorText(client, "item_mix", { topItems: 21 })).toMatch(/topItems/);
      expect(await errorText(client, "item_mix", { topItems: 0 })).toMatch(/topItems/);
    });
  });

  describe("retention", () => {
    it("returns exactly the Retention page's figures (getRetention) for the same filter", async () => {
      const client = await connect();
      const cases: { args: Record<string, unknown>; filter: GlobalFilter }[] = [
        { args: SEPTEMBER, filter: SEPTEMBER },
        { args: {}, filter: { dateFrom: "2026-10-01", dateTo: "2026-10-01" } },
        { args: { dateFrom: "2025-09-01", dateTo: "2025-10-31" }, filter: { dateFrom: "2025-09-01", dateTo: "2025-10-31" } },
        { args: { ...SEPTEMBER, branches: ["South"] }, filter: { ...SEPTEMBER, branchIds: [branch.south] } },
        { args: { ...SEPTEMBER, doctors: ["Alpha"] }, filter: { ...SEPTEMBER, doctorIds: [staff["Dr Alpha Anderson"]!] } },
        { args: { preset: "last-month" }, filter: SEPTEMBER },
      ];
      for (const { args, filter } of cases) {
        const data = await structured(client, "retention", args);
        expect(data.retention, JSON.stringify(args)).toEqual(json(await getRetention(db.sql, filter)));
      }
    });

    it("summarises new vs returning customers, the 90-day return rate (and what is not mature yet) and the latest cohort", async () => {
      const client = await connect();
      // September 2026's service visits: Customer 0001 (1 and 18 Sep), 0004, 0002 (5 and 30 Sep), 0005, 0003 — only
      // Customer 0002 had no earlier service visit (their August sale was cancelled). All 7 visits are less than 90 days
      // before 30 Sep 2026. The 2025 cohort (synced from 3 Sep 2025): Customers 0001, 0005 and 0003, all back in 2026.
      const result = await call(client, "retention", SEPTEMBER);
      expect(summaryOf(result)).toBe(
        "Retention for 1 Sep 2026 – 30 Sep 2026, all branches: 5 customers had a service visit (whole clinic): 1 new (20.0%), 4 returning (80.0%). " +
          "90-day return rate: not known yet — all 7 visits in the period are less than 90 days before the latest synced day (30 Sep 2026). " +
          "Latest yearly cohort 2025 (partial year, still accruing): 3 customers, 100.0% came back in 2026 (any doctor). " +
          "3 doctors listed.",
      );
      const retention = (result.structuredContent as { retention: Awaited<ReturnType<typeof getRetention>> }).retention;
      expect(retention.clinic.newVsReturning).toEqual({ customers: 5, newCustomers: 1, returningCustomers: 4, newPercent: 20, returningPercent: 80 });
      expect(retention.clinic.returns90).toEqual({ visits: 7, notYetMature: 7, mature: 0, returned: 0, returnPercent: null });
    });
  });

  describe("discounts", () => {
    it("returns exactly the Discounts page's figures (getDoctorDiscounts, getDiscountTypes) for the same filter", async () => {
      const client = await connect();
      const cases: { args: Record<string, unknown>; filter: GlobalFilter }[] = [
        { args: SEPTEMBER, filter: SEPTEMBER },
        { args: { ...SEPTEMBER, branches: ["North"] }, filter: { ...SEPTEMBER, branchIds: [branch.north] } },
        { args: { ...SEPTEMBER, doctors: ["Bravo"] }, filter: { ...SEPTEMBER, doctorIds: [staff["Dr Bravo Brown"]!] } },
        { args: { dateFrom: "2025-09-01", dateTo: "2026-09-30" }, filter: { dateFrom: "2025-09-01", dateTo: "2026-09-30" } },
        { args: { preset: "last-month" }, filter: SEPTEMBER },
      ];
      for (const { args, filter } of cases) {
        const data = await structured(client, "discounts", args);
        expect(data.discounts, JSON.stringify(args)).toEqual(json(await getDoctorDiscounts(db.sql, filter)));
        expect(data.types).toEqual(json(await getDiscountTypes(db.sql, filter)));
      }
    });

    it("answers with the hand-computed figures and summarises them", async () => {
      const client = await connect();
      // Hand-computed in src/analytics/discounts.test.ts.
      const result = await call(client, "discounts", SEPTEMBER);
      const data = result.structuredContent as { discounts: Awaited<ReturnType<typeof getDoctorDiscounts>> };
      expect(data.discounts.total).toMatchObject({ gross: "6255.40", discount: "280.00", discountRatePercent: 4.5, invoices: 8, discountedInvoices: 4 });
      expect(summaryOf(result)).toBe(
        "Discounts for 1 Sep 2026 – 30 Sep 2026, all branches: RM 280.00 off RM 6,255.40 gross (discount rate 4.5%); 4 of 8 invoices discounted (50.0%). " +
          "Largest doctor discount: Dr Bravo Brown RM 178.00 (5.0% of gross; 2 of 4 invoices discounted). " +
          "Largest discount type: 10% DISCOUNT RM 120.00 (42.9% of discounts, 1 invoice).",
      );
    });
  });

  describe("sales whose line items are not synced yet", () => {
    it("are counted, and the answer says doctor and item figures cannot include them yet", async () => {
      // 700104 (2,300.00, Dr Bravo Brown's biggest sale) is edited in Kreloses (gross and discount
      // changed, net the same: a line-relevant change — a payment alone would not need its lines again,
      // #6) and its page cannot be read.
      const row = h.fake.saleRows.find((candidate) => candidate.SaleId === 700104)!;
      row.GrossAmount = "2,490.00";
      row.Discounts = "190.00";
      h.clock.advance(3_600_000);
      h.fake.intercept((request) => (request.url.pathname === "/Sale/Overview/700104" ? new Response("down", { status: 503 }) : undefined));
      const connectionId = (await db.sql<{ id: string }[]>`select id::text from connections`)[0]!.id;
      await runSync(h.deps(), connectionId, "manual", { dateRange: { from: "2026-09-01", to: "2026-09-30" }, maxRetries: 0 });

      const client = await connect();
      const performance = await call(client, "doctor_performance", SEPTEMBER);
      expect((performance.structuredContent as Structured).pendingLineItems).toEqual({ invoices: 1, revenue: "2300.00" });
      expect((performance.content as { text: string }[])[0]!.text).toContain(
        "1 sale (RM 2,300.00) has line items not synced yet: counted in all revenue but not credited to any doctor yet.",
      );
      const byDoctor = await call(client, "search_sales", { ...SEPTEMBER, doctors: ["Bravo"] });
      expect((byDoctor.content as { text: string }[])[0]!.text).toContain(
        "1 sale in the period has line items not synced yet, so a doctor or item search cannot find it yet.",
      );
      expect((byDoctor.structuredContent as { search: { totalMatches: number } }).search.totalMatches).toBe(3);

      // #18's tools: each still equals its page's data, and says what the unsynced sale means for its figures.
      const text = (result: CallToolResult) => (result.content as { text: string }[])[0]!.text;
      const day = await call(client, "daily_sales", { day: "2026-09-20" });
      const daily = (day.structuredContent as { daily: DailyAnswer }).daily;
      expect(daily.groups.map((group) => [group.group, group.label, group.revenue.value])).toEqual([["pending", "Line items not synced yet", "2300.00"]]);
      expect(text(day)).toContain(
        '1 sale (RM 2,300.00) has line items not synced yet: counted in the total as "Line items not synced yet", not credited to any doctor yet.',
      );
      const dayForBravo = await call(client, "daily_sales", { day: "2026-09-20", doctors: ["Bravo"] });
      expect((dayForBravo.structuredContent as { daily: unknown }).daily).toEqual(
        json(await getDailySales(db.sql, "2026-09-20", { doctorIds: [staff["Dr Bravo Brown"]!] })),
      );
      expect(text(dayForBravo)).toContain("1 sale on the day (RM 2,300.00) has line items not synced yet: not credited to any doctor yet, so not in these figures.");
      const mix = await call(client, "item_mix", SEPTEMBER);
      expect((mix.structuredContent as { mix: unknown }).mix).toEqual(json(await getServiceMix(db.sql, SEPTEMBER)));
      expect(text(mix)).toContain(
        '1 sale (RM 2,300.00) has line items not synced yet: its revenue is in the whole clinic\'s "Line items not synced yet" bucket and in no doctor\'s mix yet.',
      );
      // With groups, that bucket is not in the answer: the summary states the unsynced sale directly instead of pointing at it.
      const someGroups = await call(client, "item_mix", { ...SEPTEMBER, groups: ["diagnostics", "surgery"] });
      expect(summaryOf(someGroups)).toContain(
        "1 sale (RM 2,300.00) has line items not synced yet: its revenue is counted in the whole clinic's RM 5,755.40 but not yet in any service group or doctor's mix, so the group figures leave it out.",
      );
      expect(summaryOf(someGroups)).not.toContain("Line items not synced yet");
      expect((someGroups.structuredContent as { groupLabels: unknown }).groupLabels).toEqual({ surgery: "Surgery", diagnostics: "Diagnostics" });
      const discounts = await call(client, "discounts", SEPTEMBER);
      expect((discounts.structuredContent as { discounts: unknown }).discounts).toEqual(json(await getDoctorDiscounts(db.sql, SEPTEMBER)));
      expect(text(discounts)).toContain("1 sale (RM 2,300.00) has line items not synced yet: its discounts are not in these figures until they are read.");
      const retention = await call(client, "retention", SEPTEMBER);
      expect((retention.structuredContent as { retention: unknown }).retention).toEqual(json(await getRetention(db.sql, SEPTEMBER)));
      expect(text(retention)).toContain("1 sale has line items not synced yet: it cannot count as a service visit until the next sync reads it.");
    });
  });

  describe("the registry's guards", () => {
    it("runs every tool read-only: a tool that tries to write fails, writes nothing, and leaks no internals", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const rogue = defineTool({
        name: "rogue",
        title: "Rogue",
        description: "Tries to write.",
        input: {},
        output: {},
        definitions: [],
        async run(context) {
          await context.sql`insert into branches (kreloses_location_id, name) values ('9999', 'Rogue branch')`;
          return { data: {}, summary: "wrote", freshness: {} };
        },
      });
      const server = new McpServer({ name: "test", version: "1.0.0" });
      registerMcpTool(server, rogue, { sql: db.sql, now: () => NOW });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await server.connect(serverSide);
      const client = new Client({ name: "vitest", version: "1.0.0" });
      await client.connect(clientSide);
      clients.push(client);

      const text = await errorText(client, "rogue", {});
      expect(text).toBe("rogue failed on the server while reading the data. Try again; if it keeps failing, the app's logs say why.");
      expect(console.error).toHaveBeenCalledWith("[mcp] tool rogue failed:", expect.objectContaining({ message: expect.stringContaining("read-only transaction") }));
      expect(await db.sql`select 1 from branches where kreloses_location_id = '9999'`).toEqual([]);
      await server.close();
    });
  });
});

/** An md5 of every row of every app table. */
async function tableDigests(sql: Sql): Promise<Record<string, string>> {
  const tables = await sql<{ name: string }[]>`
    select table_name as name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1
  `;
  const digests: Record<string, string> = {};
  for (const { name } of tables) {
    const [row] = await sql.unsafe<{ digest: string }[]>(
      `select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as digest from public."${name.replace(/"/g, '""')}" t`,
    );
    digests[name] = row!.digest;
  }
  return digests;
}
