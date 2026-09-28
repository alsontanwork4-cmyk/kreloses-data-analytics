import { beforeEach, describe, expect, it } from "vitest";

import { getDataFreshness } from "@/analytics";
import { invoiceRevenueBaseSen } from "@/attribution";
import { useTestDatabase } from "@/db/testing";
import { listInvoices, login } from "@/kreloses";
import { SYNTHETIC_ACCOUNTS, readFixture } from "@/kreloses/testing/fake-kreloses";
import { moneyToSen } from "@/lib/money";
import { listStaffAliases, remapAlias, setStaffKind } from "@/staff/store";

import { runSync, type SyncResult } from "./engine";
import { listSyncRuns } from "./runs";
import { saveInvoicePage } from "./store";
import { clearSyncTables, createSyncHarness, type SyncHarness } from "./test-support";

/**
 * Seam 1 (Sync Engine, #5): after each Sale List page the sync reads the Sale Overview page of every
 * new or changed active invoice (fake Kreloses, `__fixtures__/sale-overviews.json`) and stores its
 * lines, the staff names on them, and the credited lines derived by Attribution & Rules.
 */
const { both } = SYNTHETIC_ACCOUNTS;
const SEPTEMBER = { from: "2026-09-01", to: "2026-09-30" };

function ran(result: SyncResult) {
  if (!("runId" in result)) throw new Error(`expected a run, got ${JSON.stringify(result)}`);
  return result;
}

/** One sale as the Sale List shows it now (read through the Reader in a session of its own). */
async function listInvoicesFor(h: SyncHarness, saleId: string) {
  const session = await login(both, { requestDelayMs: 0, transport: h.fake.transport });
  const page = await listInvoices(session, { page: 1, dateRange: SEPTEMBER, includeCancelled: true });
  return page.invoices.filter((invoice) => invoice.saleId === saleId);
}

describe("Sync Engine: line items and credited lines", () => {
  const db = useTestDatabase();
  let h: SyncHarness;

  beforeEach(async () => {
    await clearSyncTables(db.sql);
    h = createSyncHarness(db.sql);
  });

  const overviewRequests = () => h.fake.requests.filter((request) => request.url.pathname.startsWith("/Sale/Overview/")).length;

  const linesOf = (saleId: string) => db.sql`
    select l.line_no, l.item_name, l.item_type, l.quantity, l.unit_price, l.amount, l.raw_staff_name, l.discount_name, l.discount_amount
    from invoice_lines l join invoices i on i.id = l.invoice_id
    where i.kreloses_sale_id = ${saleId} order by l.line_no
  `;
  const creditedOf = (saleId: string) => db.sql`
    select l.line_no, a.raw_name as alias, c.gross_amount, c.line_amount, c.spread_amount, c.credited_amount
    from credited_lines c join invoices i on i.id = c.invoice_id
    left join invoice_lines l on l.id = c.invoice_line_id
    left join staff_aliases a on a.id = c.staff_alias_id
    where i.kreloses_sale_id = ${saleId} order by l.line_no nulls last
  `;

  it("reads every active invoice's lines, stores them as sent, and credits them so each invoice sums to its net", async () => {
    const id = await h.connect(both);
    const result = ran(await runSync(h.deps(), id, "manual", { dateRange: SEPTEMBER, pageSize: 4 }));
    expect(result.counts).toMatchObject({ invoicesSeen: 11, lineItemsRead: 9 });
    // Cancelled sales (700103, 700204) are never opened.
    expect(overviewRequests()).toBe(9);
    expect(await db.sql`select 1 from invoices where status = 'active' and not lines_current`).toHaveLength(0);
    expect(await linesOf("700103")).toEqual([]);

    expect(await linesOf("700104")).toEqual([
      { lineNo: 1, itemName: "Hospitalisation (per day)", itemType: 4, quantity: "3.0000", unitPrice: "350.00", amount: "1050.00", rawStaffName: "Dr Bravo", discountName: null, discountAmount: "0.00" },
      { lineNo: 2, itemName: "Dental scaling", itemType: 4, quantity: "1.0000", unitPrice: "1200.00", amount: "1080.00", rawStaffName: "Dr Bravo", discountName: "10% DISCOUNT", discountAmount: "120.00" },
      { lineNo: 3, itemName: "Prescription diet 2kg", itemType: 1, quantity: "1.0000", unitPrice: "180.00", amount: "180.00", rawStaffName: null, discountName: null, discountAmount: "0.00" },
      { lineNo: 4, itemName: "IV fluids", itemType: 1, quantity: "0.5000", unitPrice: "100.00", amount: "50.00", rawStaffName: "North General", discountName: null, discountAmount: "0.00" },
      { lineNo: 5, itemName: "RM60 VOUCHER", itemType: 55, quantity: null, unitPrice: null, amount: "-60.00", rawStaffName: null, discountName: "RM60 VOUCHER", discountAmount: "60.00" },
    ]);
    // −60.00 (the voucher) spread by what each line charged, 1,050 / 1,080 / 180 / 50 → −26.69 / −27.46 / −4.58 / −1.27.
    expect(await creditedOf("700104")).toEqual([
      { lineNo: 1, alias: "Dr Bravo", grossAmount: "1050.00", lineAmount: "1050.00", spreadAmount: "-26.69", creditedAmount: "1023.31" },
      { lineNo: 2, alias: "Dr Bravo", grossAmount: "1200.00", lineAmount: "1080.00", spreadAmount: "-27.46", creditedAmount: "1052.54" },
      { lineNo: 3, alias: null, grossAmount: "180.00", lineAmount: "180.00", spreadAmount: "-4.58", creditedAmount: "175.42" },
      { lineNo: 4, alias: "North General", grossAmount: "50.00", lineAmount: "50.00", spreadAmount: "-1.27", creditedAmount: "48.73" },
    ]);

    const sums = await db.sql`
      select i.kreloses_sale_id, i.net_amount, sum(c.credited_amount) as credited
      from invoices i join credited_lines c on c.invoice_id = i.id
      where i.status = 'active' group by i.id order by i.kreloses_sale_id
    `;
    expect(sums).toHaveLength(9);
    for (const row of sums) expect(row.credited, String(row.krelosesSaleId)).toBe(row.netAmount);

    const [stored] = await db.sql`select raw_detail from invoices where kreloses_sale_id = '700202'`;
    expect(Object.keys(stored!.rawDetail as object).sort()).toEqual(["CreditNoteInfo", "RefundInfo", "Sale", "Totals", "Transactions"]);
    expect(stored!.rawDetail).toMatchObject({ RefundInfo: { Amount: "100.00" } });
  });

  it("matches the staff names on lines to the Kreloses staff list; unknown names become alias-only staff", async () => {
    const id = await h.connect(both);
    ran(await runSync(h.deps(), id, "manual", { dateRange: SEPTEMBER }));

    expect(
      await db.sql`select full_name, kind, kind_source, source, kreloses_staff_id, active from staff order by source, full_name`,
    ).toEqual([
      { fullName: "Dr Delta", kind: "doctor", kindSource: "auto", source: "alias_only", krelosesStaffId: null, active: true },
      { fullName: "Branch North General", kind: "generic", kindSource: "auto", source: "kreloses", krelosesStaffId: "503", active: true },
      { fullName: "Branch South General", kind: "generic", kindSource: "auto", source: "kreloses", krelosesStaffId: "506", active: true },
      { fullName: "Charlie Chen", kind: "other", kindSource: "auto", source: "kreloses", krelosesStaffId: "504", active: true },
      { fullName: "Dr Alpha Anderson", kind: "doctor", kindSource: "auto", source: "kreloses", krelosesStaffId: "501", active: true },
      { fullName: "Dr Bravo Brown", kind: "doctor", kindSource: "auto", source: "kreloses", krelosesStaffId: "502", active: true },
    ]);
    expect(
      await db.sql`
        select a.raw_name, a.normalised_name, a.match, s.full_name as staff from staff_aliases a join staff s on s.id = a.staff_id
        order by a.normalised_name
      `,
    ).toEqual([
      { rawName: "Charlie", normalisedName: "charlie", match: "auto", staff: "Charlie Chen" },
      { rawName: "Dr Alpha", normalisedName: "dr alpha", match: "auto", staff: "Dr Alpha Anderson" },
      { rawName: "Dr Bravo", normalisedName: "dr bravo", match: "auto", staff: "Dr Bravo Brown" },
      { rawName: "Dr Delta", normalisedName: "dr delta", match: "unmatched", staff: "Dr Delta" },
      { rawName: "Dr. Alpha", normalisedName: "dr. alpha", match: "auto", staff: "Dr Alpha Anderson" },
      { rawName: "North General", normalisedName: "north general", match: "auto", staff: "Branch North General" },
      { rawName: "South General", normalisedName: "south general", match: "auto", staff: "Branch South General" },
    ]);
  });

  it("is idempotent: syncing again opens no invoice page and changes no row", async () => {
    const id = await h.connect(both);
    ran(await runSync(h.deps(), id, "manual", { dateRange: SEPTEMBER }));
    const snapshot = async () => ({
      lines: await db.sql`select * from invoice_lines order by id`,
      credited: await db.sql`select * from credited_lines order by id`,
      aliases: await db.sql`select * from staff_aliases order by id`,
      staff: await db.sql`select * from staff order by id`,
    });
    const before = await snapshot();
    const opened = overviewRequests();

    h.clock.advance(60_000);
    const again = ran(await runSync(h.deps(), id, "manual", { dateRange: SEPTEMBER }));
    expect(again.counts).toMatchObject({ unchanged: 11, lineItemsRead: 0 });
    expect(overviewRequests()).toBe(opened);
    expect(await snapshot()).toEqual(before);
  });

  it("re-reads an invoice's lines when its header changes, and credits the new lines", async () => {
    const id = await h.connect(both);
    ran(await runSync(h.deps(), id, "manual", { dateRange: SEPTEMBER }));
    const [lineBefore] = await db.sql`select l.id::text from invoice_lines l join invoices i on i.id = l.invoice_id where i.kreloses_sale_id = '700203' and l.line_no = 1`;

    // 700203 edited in Kreloses: the second line removed, net 250.00 → 95.00.
    const row = h.fake.saleRows.find((candidate) => candidate.SaleId === 700203)!;
    row.GrossAmount = "100.00";
    row.NetAmount = "95.00";
    row.Total = "95.00";
    row.TotalPayments = "95.00";
    const model = h.fake.saleOverviews["700203"] as { Items: unknown[]; Totals: Record<string, string> };
    model.Items = model.Items.slice(0, 1);
    model.Totals.NetAmount = "95.00";
    h.clock.advance(60_000);
    const next = ran(await runSync(h.deps(), id, "manual", { dateRange: SEPTEMBER }));
    expect(next.counts).toMatchObject({ updated: 1, lineItemsRead: 1 });

    expect(await creditedOf("700203")).toEqual([
      { lineNo: 1, alias: "Dr Bravo", grossAmount: "100.00", lineAmount: "100.00", spreadAmount: "-5.00", creditedAmount: "95.00" },
    ]);
    expect(await linesOf("700203")).toHaveLength(1);
    // The surviving line keeps its id.
    const [lineAfter] = await db.sql`select l.id::text from invoice_lines l join invoices i on i.id = l.invoice_id where i.kreloses_sale_id = '700203' and l.line_no = 1`;
    expect(lineAfter).toEqual(lineBefore);
  });

  it("an invoice page the Reader does not understand fails the run loudly and leaves that invoice's lines not current", async () => {
    const id = await h.connect(both);
    h.fake.intercept((request) =>
      request.url.pathname === "/Sale/Overview/700202"
        ? new Response(readFixture("sale-overview-changed.html"), { headers: { "Content-Type": "text/html" } })
        : undefined,
    );
    const result = ran(await runSync(h.deps(), id, "manual", { dateRange: SEPTEMBER }));
    expect(result).toMatchObject({ status: "failed", error: { code: "layout_changed" } });
    expect(result.error!.message).toMatch(/Sale\/Overview: no Items list in the page model/);
    const [invoice] = await db.sql`select lines_current from invoices where kreloses_sale_id = '700202'`;
    expect(invoice).toEqual({ linesCurrent: false });
    expect(await listSyncRuns(db.sql)).toMatchObject([{ status: "failed", errorCode: "layout_changed", checkpoint: { nextPage: 1 } }]);
  });

  it("fails the run when the Sale List's rows exceed its TotalCount", async () => {
    const id = await h.connect(both);
    const rows = h.fake.saleRows.slice(0, 3);
    h.fake.intercept((request) => (request.url.pathname === "/Sale/Get" ? Response.json({ Columns: [], Results: rows, TotalCount: 2 }) : undefined));
    const result = ran(await runSync(h.deps(), id, "manual", { dateRange: SEPTEMBER }));
    expect(result).toMatchObject({ status: "failed", error: { code: "layout_changed" } });
    expect(result.error!.message).toMatch(/exceed TotalCount/);
  });

  describe("invoice pages that are not there (404, or sent elsewhere)", () => {
    const missing = (...saleIds: string[]) => {
      let active = true;
      h.fake.intercept((request) => {
        const saleId = /^\/Sale\/Overview\/(\d+)$/.exec(request.url.pathname)?.[1];
        if (!active || !saleId || !saleIds.includes(saleId)) return undefined;
        return saleId === saleIds[0]
          ? new Response("<html><body>404</body></html>", { status: 404, headers: { "Content-Type": "text/html" } })
          : new Response(null, { status: 302, headers: { Location: "/Sale/List" } });
      });
      return () => (active = false);
    };

    it("skips them: the others get their lines, they stay 'not synced yet' at their net, the run ends partial; the next run retries them", async () => {
      const id = await h.connect(both);
      const restore = missing("700202", "700206");
      const result = ran(await runSync(h.deps(), id, "manual", { dateRange: SEPTEMBER }));

      expect(result).toMatchObject({ status: "partial", counts: { invoicesSeen: 11, lineItemsRead: 7, lineItemsFailed: 2 } });
      const [run] = await listSyncRuns(db.sql);
      expect(run).toMatchObject({
        status: "partial",
        errorCode: null,
        // The whole listing was read: it counts for "data as of", and "Sync now" starts over (retrying the pages).
        coveredLocationIds: ["1101", "1102"],
        checkpoint: { nextPage: 1 },
        warnings: [{ code: "invoice_pages_missing", message: expect.stringMatching(/2 invoice pages could not be opened/) }],
      });
      expect((await getDataFreshness(db.sql, { dateFrom: "2026-09-01", dateTo: "2026-09-30" })).map((branch) => branch.dataAsOf)).toEqual([
        run!.finishedAt,
        run!.finishedAt,
      ]);
      const current = await db.sql`
        select kreloses_sale_id, lines_current from invoices where status = 'active' and not lines_current order by 1
      `;
      expect(current).toEqual([
        { krelosesSaleId: "700202", linesCurrent: false },
        { krelosesSaleId: "700206", linesCurrent: false },
      ]);

      restore();
      h.clock.advance(60_000);
      const next = ran(await runSync(h.deps(), id, "manual", { dateRange: SEPTEMBER }));
      expect(next).toMatchObject({ status: "succeeded", counts: { lineItemsRead: 2, lineItemsFailed: 0 } });
      expect((await listSyncRuns(db.sql))[0]).toMatchObject({ status: "succeeded", warnings: [] });
      expect(await db.sql`select 1 from invoices where status = 'active' and not lines_current`).toEqual([]);
    });

    it("fails the run loudly when the first three pages it tries are all missing (something is systematically wrong)", async () => {
      const id = await h.connect(both);
      missing("700105", "700205", "700104");
      const result = ran(await runSync(h.deps(), id, "manual", { dateRange: SEPTEMBER }));
      expect(result).toMatchObject({ status: "failed", error: { code: "layout_changed" }, counts: { lineItemsRead: 0, lineItemsFailed: 3 } });
      expect(result.error!.message).toMatch(/could not open invoice pages/i);
    });
  });

  it("records, per invoice and per run, when an invoice's lines do not add up to its net amount (the gap monitor)", async () => {
    const id = await h.connect(both);
    const result = ran(await runSync(h.deps(), id, "manual", { dateRange: SEPTEMBER }));
    // 700203: lines 100.00 + 160.00 = 260.00 against a net of 250.00. Every other invoice adds up.
    expect(result.counts).toMatchObject({ lineItemsRead: 9, lineItemGaps: 1 });
    expect(await db.sql`select kreloses_sale_id, line_gap_amount from invoices where line_gap_amount <> 0`).toEqual([
      { krelosesSaleId: "700203", lineGapAmount: "-10.00" },
    ]);
    expect(await db.sql`select count(*)::int as n from invoices where status = 'active' and line_gap_amount = 0`).toEqual([{ n: 8 }]);
  });

  it("keeps the revenue base defined the same in TypeScript and SQL (invoiceRevenueBaseSen = invoices.revenue_base)", async () => {
    const id = await h.connect(both);
    ran(await runSync(h.deps(), id, "manual", { dateRange: { from: "2025-09-01", to: "2026-09-30" } }));
    const rows = await db.sql<{ status: "active" | "cancelled"; netAmount: string; totalRefunds: string; revenueBase: string }[]>`
      select status, net_amount, total_refunds, revenue_base from invoices
    `;
    expect(rows).toHaveLength(20);
    expect(rows.some((row) => row.status === "cancelled")).toBe(true);
    expect(rows.some((row) => row.totalRefunds !== "0.00")).toBe(true);
    for (const row of rows) {
      const ts = invoiceRevenueBaseSen({ status: row.status, netSen: moneyToSen(row.netAmount), totalRefundsSen: moneyToSen(row.totalRefunds) });
      expect(moneyToSen(row.revenueBase), JSON.stringify(row)).toBe(ts);
    }
  });

  it("never marks lines current for a header they were not read for (another sync changed it meanwhile)", async () => {
    const id = await h.connect(both);
    // While this run opens 700202's page, another connection's sync stores a newer header for it.
    h.fake.intercept(async (request) => {
      if (request.url.pathname !== "/Sale/Overview/700202") return undefined;
      const [running] = await db.sql<{ id: string }[]>`select id::text from sync_runs where status = 'running'`;
      const invoices = (await listInvoicesFor(h, "700202")).map((invoice) => ({ ...invoice, netSen: 90_000, totalSen: 90_000 }));
      await saveInvoicePage(db.sql, { runId: running!.id, connectionId: id, invoices, fetchedAt: h.clock.now });
      return undefined;
    });
    ran(await runSync(h.deps(), id, "manual", { dateRange: SEPTEMBER }));
    const [invoice] = await db.sql`select net_amount, lines_current from invoices where kreloses_sale_id = '700202'`;
    expect(invoice).toEqual({ netAmount: "900.00", linesCurrent: false });
    expect(await db.sql`select 1 from credited_lines c join invoices i on i.id = c.invoice_id where i.kreloses_sale_id = '700202'`).toEqual([]);
  });

  describe("the staff list over time", () => {
    const withStaff = (options: { Value: string; Text: string }[]) =>
      h.fake.intercept((request) => {
        if (request.url.pathname !== "/Report/GetFilter") return undefined;
        const template = JSON.parse(readFixture("report-14-filter.json")) as { Filters: { Name: string; Options?: unknown[] }[] };
        template.Filters.find((filter) => filter.Name === "Staff")!.Options = options.map((option) => ({ ...option, Selected: false }));
        return Response.json(template);
      });

    it("never moves a name that already has revenue to a newly listed staff member: it only suggests them; owner's choices stay", async () => {
      const id = await h.connect(both);
      ran(await runSync(h.deps(), id, "manual", { dateRange: SEPTEMBER }));
      const alias = async (raw: string) =>
        (await db.sql`select a.id::text, a.match, s.full_name as staff from staff_aliases a join staff s on s.id = a.staff_id where a.raw_name = ${raw}`)[0]!;
      const staffId = async (name: string) => (await db.sql`select id::text from staff where full_name = ${name}`)[0]!.id as string;

      // The owner maps "Charlie" to Dr Bravo by hand, and makes Charlie Chen a doctor.
      expect(await remapAlias(db.sql, (await alias("Charlie")).id, await staffId("Dr Bravo Brown"))).toEqual({ status: "saved" });
      expect(await setStaffKind(db.sql, await staffId("Charlie Chen"), "doctor")).toEqual({ status: "saved" });

      withStaff([
        { Value: "501", Text: "Dr Alpha Anderson" },
        { Value: "502", Text: "Dr Bravo Brown" },
        { Value: "503", Text: "Branch North General" },
        { Value: "504", Text: "Charlie Chen" },
        { Value: "506", Text: "Branch South General" },
        { Value: "507", Text: "Dr Delta Dunn" },
      ]);
      ran(await runSync(h.deps(), id, "manual", { dateRange: SEPTEMBER }));

      // "Dr Delta" (a doctor who left) keeps its history; the new "Dr Delta Dunn" is only suggested.
      expect(await alias("Dr Delta")).toMatchObject({ match: "unmatched", staff: "Dr Delta" });
      const delta = (await listStaffAliases(db.sql)).find((row) => row.rawName === "Dr Delta")!;
      expect(delta.suggestions.map((suggestion) => suggestion.name)).toEqual(["Dr Delta Dunn"]);
      expect(await alias("Charlie")).toMatchObject({ match: "manual", staff: "Dr Bravo Brown" });
      expect(await db.sql`select kind, kind_source from staff where full_name = 'Charlie Chen'`).toEqual([{ kind: "doctor", kindSource: "manual" }]);
      expect(await db.sql`select kind from staff where full_name = 'Dr Delta Dunn'`).toEqual([{ kind: "doctor" }]);
    });

    it("a template without a readable Staff filter is a warning, not a failure: lines are still credited (names unmatched), nobody is marked inactive", async () => {
      const id = await h.connect(both);
      ran(await runSync(h.deps(), id, "manual", { dateRange: SEPTEMBER }));
      h.fake.intercept((request) => {
        if (request.url.pathname !== "/Report/GetFilter") return undefined;
        const template = JSON.parse(readFixture("report-14-filter.json")) as { Filters: { Name: string }[] };
        template.Filters = template.Filters.filter((filter) => filter.Name !== "Staff");
        return Response.json(template);
      });
      // A sale with a new staff name arrives.
      (h.fake.saleOverviews["700105"] as { Items: { StaffName: string }[] }).Items[0]!.StaffName = "Dr Echo";
      h.fake.saleRows.find((row) => row.SaleId === 700105)!.PaymentStatusName = "Paid";
      h.clock.advance(60_000);

      const result = ran(await runSync(h.deps(), id, "manual", { dateRange: SEPTEMBER }));
      expect(result).toMatchObject({ status: "succeeded", counts: { lineItemsRead: 1 } });
      expect((await listSyncRuns(db.sql))[0]).toMatchObject({
        status: "succeeded",
        warnings: [{ code: "staff_list_unreadable", message: expect.stringMatching(/Staff/) }],
      });
      expect(await db.sql`select a.match, s.source from staff_aliases a join staff s on s.id = a.staff_id where a.raw_name = 'Dr Echo'`).toEqual([
        { match: "unmatched", source: "alias_only" },
      ]);
      expect(await db.sql`select count(*)::int as n from staff where source = 'kreloses' and not active`).toEqual([{ n: 0 }]);
    });

    it("marks staff Kreloses no longer lists as inactive, keeping them and their names", async () => {
      const id = await h.connect(both);
      ran(await runSync(h.deps(), id, "manual", { dateRange: SEPTEMBER }));
      withStaff([
        { Value: "501", Text: "Dr Alpha Anderson" },
        { Value: "503", Text: "Branch North General" },
        { Value: "504", Text: "Charlie Chen" },
        { Value: "506", Text: "Branch South General" },
      ]);
      ran(await runSync(h.deps(), id, "manual", { dateRange: SEPTEMBER }));
      expect(await db.sql`select full_name, active from staff where kreloses_staff_id in ('501', '502') order by full_name`).toEqual([
        { fullName: "Dr Alpha Anderson", active: true },
        { fullName: "Dr Bravo Brown", active: false },
      ]);
      expect(await db.sql`select a.match from staff_aliases a where a.raw_name = 'Dr Bravo'`).toEqual([{ match: "auto" }]);
    });
  });
});
