import { describe, expect, it } from "vitest";

import { AuthFailed, LayoutChanged, listInvoices, listLocations, login, type InvoiceListQuery, type InvoicePage, type KrelosesInvoice } from "./index";
import { SYNTHETIC_ACCOUNTS, createFakeKreloses, readFixture, type FakeKreloses } from "./testing/fake-kreloses";

/**
 * Seam 2: the Sale List (POST /Sale/Get, with the Sale List filter template from
 * POST /Report/GetFilter {report: 14}) read through the Reader from the fake Kreloses, which
 * serves the synthetic rows in `__fixtures__/sale-list-rows.json` the way Kreloses would.
 */
const fast = { requestDelayMs: 0 };
const { north, both } = SYNTHETIC_ACCOUNTS;
const SEPTEMBER = { from: "2026-09-01", to: "2026-09-30" };
const AUGUST = { from: "2026-08-01", to: "2026-08-31" };

async function signedIn(account: { email: string; password: string } = both, fake: FakeKreloses = createFakeKreloses()) {
  const session = await login(account, { ...fast, transport: fake.transport });
  return { fake, session };
}

function answerSaleGet(fake: FakeKreloses, response: () => Response) {
  fake.intercept((request) => (request.url.pathname === "/Sale/Get" ? response() : undefined));
}

function answerGetFilter(fake: FakeKreloses, body: unknown) {
  fake.intercept((request) => (request.url.pathname === "/Report/GetFilter" ? Response.json(body) : undefined));
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

/** Every page of a listing, in order. */
async function allPages(session: Awaited<ReturnType<typeof signedIn>>["session"], query: Omit<InvoiceListQuery, "page">) {
  const pages: InvoicePage[] = [];
  for (let page = 1; ; page += 1) {
    const result = await listInvoices(session, { ...query, page, previous: pages.at(-1) });
    pages.push(result);
    if (!result.hasMore) return pages;
    if (page > 20) throw new Error("runaway paging");
  }
}

const ids = (invoices: KrelosesInvoice[]) => invoices.map((invoice) => invoice.saleId);

describe("Kreloses Reader: listInvoices", () => {
  it("reads one month of the Sale List, cancelled sales included, as clean domain invoices", async () => {
    const { fake, session } = await signedIn();
    const page = await listInvoices(session, { page: 1, dateRange: SEPTEMBER, includeCancelled: true });

    expect(page).toMatchObject({ page: 1, totalCount: 11, rowCount: 11, hasMore: false });
    // Newest first, as Kreloses lists them.
    expect(ids(page.invoices)).toEqual([
      "700105", "700205", "700204", "700104", "700203", "700202", "700103", "700206", "700102", "700201", "700101",
    ]);
    expect(page.invoices.find((invoice) => invoice.saleId === "700101")).toEqual({
      saleId: "700101",
      saleNumber: "INV-N-0101",
      locationId: "1101",
      locationName: "Branch North",
      customerId: "90001",
      customerName: "Customer 0001",
      // 00:30 on 1 Sep in Kuala Lumpur is 16:30 UTC on 31 Aug: it belongs to September.
      saleAt: new Date("2026-08-31T16:30:00Z"),
      saleDate: "2026-09-01",
      status: "active",
      statusName: "Active",
      grossSen: 125_000,
      discountsSen: 5_000,
      netSen: 120_000,
      taxSen: 0,
      totalSen: 120_000,
      paymentStatus: "Paid",
      totalPaymentsSen: 120_000,
      totalRefundsSen: 0,
      raw: expect.objectContaining({ SaleId: 700101, SaleDate: "/Date(1788193800000)/", NetAmount: "1,200.00" }),
    });
    expect(page.invoices.find((invoice) => invoice.saleId === "700206")).toMatchObject({
      grossSen: -12_000,
      netSen: -12_000,
      totalSen: -12_000,
      totalRefundsSen: 12_000,
    });
    expect(page.invoices.filter((invoice) => invoice.status === "cancelled").map((invoice) => invoice.saleId)).toEqual(["700204", "700103"]);
    expect(page.invoices.find((invoice) => invoice.saleId === "700205")).toMatchObject({ customerId: null, customerName: null });

    // The request the Kreloses web UI makes, with the filter template passed back and set.
    const request = fake.requests.at(-1)!;
    expect(request.method).toBe("POST");
    expect(request.url.href).toBe("https://sea.kreloses.com/Sale/Get");
    expect(request.headers["x-requested-with"]).toBe("XMLHttpRequest");
    const body = JSON.parse(request.body!) as { request: unknown; filter: { Filters: { Name: string; Options?: { Text: string; Selected: boolean }[]; From?: string; To?: string }[] } };
    expect(body.request).toEqual({
      BasicSearchQuery: null,
      IsBasicQuery: true,
      IsOrderDesc: true,
      PageSize: 500,
      RequestingPage: 1,
      SortByColumn: null,
    });
    const filter = (name: string) => body.filter.Filters.find((candidate) => candidate.Name === name)!;
    expect(filter("Sale status").Options!.map((option) => [option.Text, option.Selected])).toEqual([
      ["Active", true],
      ["Cancelled", true],
    ]);
    expect(filter("Date")).toMatchObject({ From: "01/09/2026", To: "30/09/2026" });
    expect(filter("Location").Options!.map((option) => [option.Text, option.Selected])).toEqual([
      ["All Locations", false],
      ["Branch North", true],
      ["Branch South", true],
    ]);
  });

  it("pages through the listing and says when there is nothing more to read", async () => {
    const { session } = await signedIn();
    const pages = await allPages(session, { dateRange: SEPTEMBER, includeCancelled: true, pageSize: 4 });
    expect(pages.map((page) => [page.page, page.rowCount, page.hasMore])).toEqual([
      [1, 4, true],
      [2, 4, true],
      [3, 3, false],
    ]);
    expect(pages.every((page) => page.totalCount === 11)).toBe(true);
    expect(new Set(pages.flatMap((page) => ids(page.invoices))).size).toBe(11);
  });

  it("only returns the branches the login can see", async () => {
    const { session } = await signedIn(north);
    const page = await listInvoices(session, { page: 1, dateRange: SEPTEMBER, includeCancelled: true });
    expect(new Set(page.invoices.map((invoice) => invoice.locationId))).toEqual(new Set(["1101"]));
    expect(page.invoices).toHaveLength(5);
  });

  it("leaves cancelled sales out when asked to (the Sale List's own default)", async () => {
    const { session } = await signedIn();
    const page = await listInvoices(session, { page: 1, dateRange: SEPTEMBER, includeCancelled: false });
    expect(page.invoices).toHaveLength(9);
    expect(page.invoices.every((invoice) => invoice.status === "active")).toBe(true);
  });

  it("parses every date and number format Kreloses might send", async () => {
    const { fake, session } = await signedIn();
    answerSaleGet(fake, () => new Response(readFixture("sale-get-formats.json"), { headers: { "Content-Type": "application/json" } }));
    const page = await listInvoices(session, { page: 1, dateRange: SEPTEMBER, includeCancelled: true });
    const bySale = Object.fromEntries(page.invoices.map((invoice) => [invoice.saleId, invoice]));
    const kl0030 = new Date("2026-08-31T16:30:00Z");

    expect(bySale["800001"]).toMatchObject({
      // ISO without an offset = clinic-local wall time; plain JSON numbers; null optional amounts = 0.
      locationId: "1101",
      customerId: "90001",
      saleAt: kl0030,
      saleDate: "2026-09-01",
      grossSen: 125_000,
      discountsSen: 5_050,
      netSen: 119_950,
      taxSen: 0,
      totalSen: 119_950,
      totalPaymentsSen: 119_950,
      totalRefundsSen: 0,
    });
    expect(bySale["800002"]).toMatchObject({
      // ISO in UTC; "RM" prefixes; a negative in parentheses after the currency; any status capitalisation.
      locationId: "1102",
      saleAt: kl0030,
      saleDate: "2026-09-01",
      status: "active",
      statusName: "ACTIVE",
      grossSen: 123_450,
      discountsSen: -1_200,
      netSen: 122_250,
      taxSen: 0,
      totalSen: 122_250,
      totalPaymentsSen: 50_000,
      totalRefundsSen: 0,
    });
    expect(bySale["800003"]).toMatchObject({
      // ISO with +08:00; minus signs and parentheses; one decimal place; millions.
      saleAt: kl0030,
      grossSen: -4_510,
      discountsSen: 0,
      netSen: -4_510,
      totalSen: -100_004_510,
      totalRefundsSen: 4_510,
    });
    expect(bySale["800004"]).toMatchObject({ saleAt: kl0030, saleDate: "2026-09-01" }); // /Date(ms+0800)/
    expect(bySale["800005"]).toMatchObject({ saleAt: kl0030, saleDate: "2026-09-01" }); // dd/MM/yyyy hh:mm AM
    expect(bySale["800006"]).toMatchObject({
      // A date without a time is midnight at the clinic; "-" for an empty amount.
      saleAt: new Date("2026-08-31T16:00:00Z"),
      saleDate: "2026-09-01",
      discountsSen: 0,
      taxSen: 0,
      totalRefundsSen: 0,
      paymentStatus: null,
    });
    expect(bySale["800007"]).toMatchObject({
      saleNumber: null,
      customerId: null,
      customerName: null,
      saleAt: new Date("2026-09-30T15:59:59Z"),
      saleDate: "2026-09-30",
      status: "cancelled",
    });
    expect(bySale["800008"]).toMatchObject({
      // A zero / empty customer is no customer (a walk-in).
      customerId: null,
      customerName: null,
      saleAt: new Date("2026-09-15T06:05:00Z"),
      status: "cancelled",
      statusName: "Canceled",
    });
    expect(page).toMatchObject({ totalCount: 8, rowCount: 8, hasMore: false });
  });

  it("drops rows outside the date range and stops once a whole page is older, if Kreloses ignores the date filter", async () => {
    const fake = createFakeKreloses({ saleList: { ignoreDateFilter: true } });
    const { session } = await signedIn(both, fake);

    const august = await allPages(session, { dateRange: AUGUST, includeCancelled: true, pageSize: 4 });
    expect(august.flatMap((page) => ids(page.invoices)).sort()).toEqual(["700090", "700091", "700092", "700093", "700094"]);
    expect(august.at(-1)!.invoices).toEqual([]); // the first page entirely before 1 Aug ends the listing

    const september = await allPages(session, { dateRange: SEPTEMBER, includeCancelled: true, pageSize: 4 });
    // Page 4 holds only August sales, so page 5 (September 2025) is never requested.
    expect(september.map((page) => [page.page, page.invoices.length, page.hasMore])).toEqual([
      [1, 4, true],
      [2, 4, true],
      [3, 3, true],
      [4, 0, false],
    ]);
    // 00:30 on 1 Sep in KL is in; 23:50 on 31 Aug in KL is out.
    expect(september.flatMap((page) => ids(page.invoices))).toContain("700101");
    expect(september.flatMap((page) => ids(page.invoices))).not.toContain("700090");
  });

  it("fetches the filter template once per session", async () => {
    const { fake, session } = await signedIn();
    await listLocations(session);
    await listInvoices(session, { page: 1, dateRange: SEPTEMBER, includeCancelled: true, pageSize: 4 });
    await listInvoices(session, { page: 2, dateRange: SEPTEMBER, includeCancelled: true, pageSize: 4 });
    expect(fake.requests.filter((request) => request.url.pathname === "/Report/GetFilter")).toHaveLength(1);
  });

  it("writes the date range in the template's own format (ISO here)", async () => {
    const { fake, session } = await signedIn();
    const template = JSON.parse(readFixture("report-14-filter.json")) as { Filters: Record<string, unknown>[] };
    const date = template.Filters.find((filter) => filter.Name === "Date")!;
    Object.assign(date, { From: "2026-09-01T00:00:00", To: "2026-09-28T00:00:00" });
    answerGetFilter(fake, template);
    await listInvoices(session, { page: 1, dateRange: AUGUST, includeCancelled: true });
    const body = JSON.parse(fake.requests.at(-1)!.body!) as { filter: { Filters: Record<string, unknown>[] } };
    expect(body.filter.Filters.find((filter) => filter.Name === "Date")).toMatchObject({
      From: "2026-08-01T00:00:00",
      To: "2026-08-31T23:59:59",
    });
  });

  describe("never ends a listing early by mistake (paging it does not understand fails loudly)", () => {
    it("fails when a page is short but TotalCount says there is more (Kreloses capping the page size)", async () => {
      const { session } = await signedIn(both, createFakeKreloses({ saleList: { maxPageSize: 3 } }));
      const error = await failure(listInvoices(session, { page: 1, dateRange: SEPTEMBER, includeCancelled: true, pageSize: 4 }));
      expect(error).toBeInstanceOf(LayoutChanged);
      expect((error as Error).message).toMatch(/page 1 has 3 rows where 4 were asked for, yet TotalCount is 11/);
    });

    it("fails when a page is empty or has more rows than asked for, while TotalCount disagrees", async () => {
      const empty = await signedIn();
      answerSaleGet(empty.fake, () => Response.json({ Columns: [], Results: [], TotalCount: 5 }));
      expect(await failure(listInvoices(empty.session, { page: 1, includeCancelled: true }))).toBeInstanceOf(LayoutChanged);

      const tooMany = await signedIn();
      const rows = (JSON.parse(readFixture("sale-list-rows.json")) as { rows: unknown[] }).rows.slice(0, 5);
      answerSaleGet(tooMany.fake, () => Response.json({ Columns: [], Results: rows, TotalCount: 20 }));
      const error = await failure(listInvoices(tooMany.session, { page: 1, includeCancelled: true, pageSize: 4 }));
      expect(error).toBeInstanceOf(LayoutChanged);
      expect((error as Error).message).toMatch(/page 1 has 5 rows where 4 were asked for/);
    });

    it("fails when a page repeats the previous one (Kreloses ignoring RequestingPage)", async () => {
      const { session } = await signedIn(both, createFakeKreloses({ saleList: { ignoreRequestingPage: true } }));
      const query = { dateRange: SEPTEMBER, includeCancelled: true, pageSize: 4 };
      const first = await listInvoices(session, { ...query, page: 1 });
      expect(first.hasMore).toBe(true);
      const error = await failure(listInvoices(session, { ...query, page: 2, previous: first }));
      expect(error).toBeInstanceOf(LayoutChanged);
      expect((error as Error).message).toMatch(/page 2 repeats page 1/);
    });

    it("keeps paging to TotalCount when rows are not newest first, rather than stopping at the first old page", async () => {
      const fake = createFakeKreloses({ saleList: { ignoreDateFilter: true, oldestFirst: true } });
      const { session } = await signedIn(both, fake);
      const pages = await allPages(session, { dateRange: SEPTEMBER, includeCancelled: true, pageSize: 4 });
      expect(pages).toHaveLength(5); // all 20 rows, 4 per page: page 1 (all 2025) did not end the listing
      expect(pages.flatMap((page) => ids(page.invoices)).sort()).toEqual([
        "700101", "700102", "700103", "700104", "700105", "700201", "700202", "700203", "700204", "700205", "700206",
      ]);
    });

    it("once pages have been seen out of order, never stops early at an all-old page", async () => {
      // Each page is newest first on its own, but page 2 is newer than the end of page 1, so the
      // listing is not in date order: page 3 (all before September) must not end it.
      const order = [
        [700105, 700205, 700093, 600001],
        [700204, 700104, 700203, 700202],
        [700094, 600004, 600003, 600002],
        [700103, 700206, 700102, 700201],
        [700101, 700090, 700092, 700091],
      ];
      const { fake, session } = await signedIn();
      const bySaleId = new Map(fake.saleRows.map((row) => [row.SaleId, row]));
      fake.intercept((request) => {
        if (request.url.pathname !== "/Sale/Get") return undefined;
        const page = (JSON.parse(request.body!) as { request: { RequestingPage: number } }).request.RequestingPage;
        return Response.json({ Columns: [], Results: (order[page - 1] ?? []).map((id) => bySaleId.get(id)), TotalCount: 20 });
      });
      const pages = await allPages(session, { dateRange: SEPTEMBER, includeCancelled: true, pageSize: 4 });
      expect(pages).toHaveLength(5);
      expect(pages.flatMap((page) => ids(page.invoices))).toHaveLength(11);
    });
  });

  describe("fails loudly (LayoutChanged) instead of returning wrong numbers", () => {
    const rows = () => (JSON.parse(readFixture("sale-list-rows.json")) as { rows: Record<string, unknown>[] }).rows.slice(0, 3);
    const secrets = ["Customer 0001", "1,250.00", "1,200.00", "700101", "Branch North"];

    async function layoutError(body: unknown): Promise<LayoutChanged> {
      const { fake, session } = await signedIn();
      answerSaleGet(fake, () => Response.json(body));
      const error = await failure(listInvoices(session, { page: 1, dateRange: SEPTEMBER, includeCancelled: true }));
      expect(error).toBeInstanceOf(LayoutChanged);
      for (const secret of secrets) expect((error as Error).message).not.toContain(secret);
      return error as LayoutChanged;
    }

    it("when the response is not {Results, TotalCount}", async () => {
      const error = await layoutError(JSON.parse(readFixture("sale-get-changed.json")));
      expect(error.message).toMatch(/Sale\/Get/);
      expect(error.shape).toContain("data: {items: [");
      expect(await layoutError({ Results: rows() })).toBeInstanceOf(LayoutChanged);
      expect(await layoutError({ Results: {}, TotalCount: 3 })).toBeInstanceOf(LayoutChanged);
      expect(await layoutError({ Results: rows(), TotalCount: "lots" })).toBeInstanceOf(LayoutChanged);
    });

    it("when a row lacks a field or has an unreadable value", async () => {
      const cases: [string, (row: Record<string, unknown>) => void, RegExp][] = [
        ["missing NetAmount", (row) => delete row.NetAmount, /row 2: no NetAmount/],
        ["renamed SaleDate", (row) => ((row.Date = row.SaleDate), delete row.SaleDate), /row 2: no SaleDate/],
        ["unparseable amount", (row) => (row.NetAmount = "1.200,00"), /row 2: NetAmount is not an amount/],
        ["too many decimals", (row) => (row.Total = "12.345"), /row 2: Total is not an amount/],
        ["missing required amount", (row) => (row.GrossAmount = null), /row 2: GrossAmount is empty/],
        ["unparseable date", (row) => (row.SaleDate = "yesterday"), /row 2: SaleDate is not a date/],
        ["impossible date", (row) => (row.SaleDate = "31/02/2026"), /row 2: SaleDate is not a date/],
        ["unknown status", (row) => (row.SaleStatusName = "Draft"), /row 2: unknown sale status "Draft"/],
        ["no sale id", (row) => (row.SaleId = null), /row 2: no SaleId/],
        ["no location id", (row) => (row.LocationId = ""), /row 2: no LocationId/],
        ["row not an object", () => undefined, /row 2 is not an object/],
      ];
      for (const [label, mutate, message] of cases) {
        const page = rows();
        if (label === "row not an object") (page as unknown[])[1] = "INV-N-0102";
        else mutate(page[1]!);
        const error = await layoutError({ Columns: [], Results: page, TotalCount: 3 });
        expect(error.message, label).toMatch(message);
      }
    });

    it("when Kreloses answers with HTML", async () => {
      const { fake, session } = await signedIn();
      answerSaleGet(fake, () => new Response("<html><body>Error</body></html>", { headers: { "Content-Type": "text/html" } }));
      expect(await failure(listInvoices(session, { page: 1, dateRange: SEPTEMBER, includeCancelled: true }))).toBeInstanceOf(LayoutChanged);
    });

    it("when the filter template has no Sale status filter, so cancelled sales cannot be requested", async () => {
      const { fake, session } = await signedIn();
      const template = JSON.parse(readFixture("report-14-filter.json")) as { Filters: { Name: string }[] };
      template.Filters = template.Filters.filter((filter) => filter.Name !== "Sale status");
      answerGetFilter(fake, template);
      const error = await failure(listInvoices(session, { page: 1, dateRange: SEPTEMBER, includeCancelled: true }));
      expect(error).toBeInstanceOf(LayoutChanged);
      expect((error as Error).message).toMatch(/Sale status/);
    });

    it("when the template's Date filter has range fields the Reader does not recognise", async () => {
      const { fake, session } = await signedIn();
      const template = JSON.parse(readFixture("report-14-filter.json")) as { Filters: Record<string, unknown>[] };
      const date = template.Filters.find((filter) => filter.Name === "Date")!;
      delete date.From;
      delete date.To;
      Object.assign(date, { Begins: "01/09/2026", Ends: "28/09/2026" });
      answerGetFilter(fake, template);
      const error = await failure(listInvoices(session, { page: 1, dateRange: SEPTEMBER, includeCancelled: true }));
      expect(error).toBeInstanceOf(LayoutChanged);
      expect((error as Error).message).toMatch(/Date filter/);
    });
  });

  it("raises AuthFailed(session_expired) when the session has expired", async () => {
    const { fake, session } = await signedIn();
    await listInvoices(session, { page: 1, dateRange: SEPTEMBER, includeCancelled: true });
    fake.expireSessions();
    const error = await failure(listInvoices(session, { page: 1, dateRange: SEPTEMBER, includeCancelled: true }));
    expect(error).toBeInstanceOf(AuthFailed);
    expect(error).toMatchObject({ reason: "session_expired" });
  });

  it("rejects a page number below 1", async () => {
    const { session } = await signedIn();
    await expect(listInvoices(session, { page: 0, includeCancelled: true })).rejects.toThrow(RangeError);
  });
});
