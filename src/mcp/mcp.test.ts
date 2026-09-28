import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  getDataFreshness,
  getDoctorRanking,
  getPendingLineItems,
  METRIC_DEFINITIONS,
  searchSales,
  type DoctorRanking,
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
      expect(tools.map((tool) => tool.name).sort()).toEqual(["data_freshness", "doctor_performance", "search_sales"]);
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
      expect(client.getInstructions()!.length).toBeLessThanOrEqual(2048);
      expect(client.getServerCapabilities()).not.toHaveProperty("resources");
      expect(client.getServerCapabilities()).not.toHaveProperty("prompts");
    });

    it("never writes: every table is byte-for-byte the same after calling every tool", async () => {
      const before = await tableDigests(db.sql);
      const client = await connect();
      for (const name of ["doctor_performance", "search_sales", "data_freshness"]) {
        await structured(client, name, {});
        await structured(client, name, SEPTEMBER);
      }
      await structured(client, "doctor_performance", { ...SEPTEMBER, splitByBranch: true, branches: ["North"], doctors: ["Dr Alpha"] });
      await structured(client, "search_sales", { ...SEPTEMBER, customer: "Customer", item: "consult", minAmount: 1, sort: "largest" });
      expect(await tableDigests(db.sql)).toEqual(before);
    });

    it("every result states data as of per branch (in the data and in the text) and carries its definitions verbatim", async () => {
      const client = await connect();
      const expectedSeptember = await getDataFreshness(db.sql, SEPTEMBER);
      const asOf = expectedSeptember.map((row) => `${row.branchName} ${formatClinicDateTime(row.dataAsOf!)}`).join("; ");
      for (const name of ["doctor_performance", "search_sales", "data_freshness"]) {
        const september = await call(client, name, SEPTEMBER);
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

        // Month to date (1 Oct): no sync has read it, and the answer says so rather than looking current.
        const today = (await structured(client, name)).dataFreshness;
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
      expect(data.ranking.totalRevenue).toBe("5855.40");
      expect(data.ranking.doctors.map((doctor) => [doctor.name, doctor.revenue, doctor.aovPerCustomer, doctor.invoices, doctor.itemsPerInvoice, doctor.sharePercent])).toEqual([
        ["Dr Alpha Anderson", "1654.35", "827.18", 3, 2, 28.3],
      ]);
      expect((result.content as { text: string }[])[0]!.text).toMatch(
        /^Doctor ranking for 1 Sep 2026 – 30 Sep 2026, all branches, doctor Dr Alpha Anderson: 1 doctor with revenue; highest Dr Alpha Anderson RM 1,654\.35 \(28\.3% of all revenue\)\. All revenue in the period: RM 5,855\.40\.\nData as of/,
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
      expect(data.search).toMatchObject({ totalMatches: 9, totalPages: 3, totalRevenue: "5855.40" });
      expect(data.search.sales.map((sale) => sale.saleNumber)).toEqual(["INV-N-0105", "INV-S-0205", "INV-N-0104", "INV-S-0203"]);
      expect(data.criteria).toEqual({ customer: null, item: null, minAmount: null, maxAmount: null, sort: "newest" });
      expect((result.content as { text: string }[])[0]!.text).toMatch(
        /^Found 9 sales \(RM 5,855\.40 in total\) for 1 Sep 2026 – 30 Sep 2026, all branches; showing 1–4, newest first \(page 1 of 3\)\. Ask for page 2 for more\.\n/,
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

  describe("sales whose line items are not synced yet", () => {
    it("are counted, and the answer says doctor and item figures cannot include them yet", async () => {
      // 700104 (2,300.00, Dr Bravo Brown's biggest sale) changes in Kreloses and its page cannot be read.
      const row = h.fake.saleRows.find((candidate) => candidate.SaleId === 700104)!;
      row.TotalPayments = "2,438.00";
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
