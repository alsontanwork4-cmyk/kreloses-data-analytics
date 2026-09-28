import { aliasKey, creditInvoice, invoiceRevenueBaseSen, type AttributionLine } from "@/attribution";
import type { JsonValue, Queryable, Sql } from "@/db/sql";
import type { KrelosesInvoiceDetail } from "@/kreloses";
import { moneyToSen, senToMoney } from "@/lib/money";
import { ensureAliases } from "@/staff/store";

/**
 * Line items: which invoices need their Sale Overview page read, and storing what it says —
 * `invoice_lines`, the staff aliases on them, and the `credited_lines` derived by Attribution &
 * Rules — in ONE transaction per invoice, so an invoice's credited lines always add up to the
 * header they were computed from.
 */

/**
 * After this many reads in a row that found the invoice's page missing — not there: HTTP 404/410 or
 * sent elsewhere (for the same header version) — the sync stops trying: the invoice is "permanently
 * missing" (listed on Sync status, still counted at its revenue base as "line items not synced yet")
 * until its header changes. A page that opened but could not be READ never counts here.
 */
export const MAX_PAGE_MISSING_ATTEMPTS = 3;

/** An invoice whose line items must be (re)read. */
export interface InvoiceNeedingLines {
  invoiceId: string;
  saleId: string;
  /** The header version the lines will be computed for (see `saveInvoiceLines`). */
  headerVersion: number;
  /** How many reads in a row already found its page missing (0 = never tried, or it worked). */
  missingAttempts: number;
  /** When the sale happened (the sweep's order). */
  saleAt: Date;
}

/** Where the sweep carries on: after this invoice in newest-first order. */
export interface SweepCursor {
  saleAt: Date;
  invoiceId: string;
}

/**
 * Which invoices to consider:
 * - `saleIds`: the Sale List page just stored (in the page's order) — the change detection of a run;
 * - `sweep`: any date, newest first, up to `limit`, after `after` — the nightly sweep of invoices
 *   left behind (synced before line items existed, stale after a header change outside the nightly
 *   window, or pending after a missing page) — ONLY of the branches whose Kreloses locations
 *   (`locationIds`) the connection's login listed in this run: another login cannot open them (a
 *   403 would read as an expired session, a 404 as a missing page, blaming the wrong connection).
 */
export type LinesScope = { saleIds: readonly string[] } | { sweep: { locationIds: readonly string[]; limit: number; after?: SweepCursor } };

/**
 * THE rule for which invoices need their line items (re)read (#5, refined by #6):
 *
 * - active (cancelled invoices are never read: they credit nothing);
 * - lines not current (`invoices.lines_current`: never read, or the header version moved — and it
 *   moves only when a column that can change line items or revenue changes: status, gross,
 *   discounts, net, tax, total, refunds; NOT payment status or payments alone, see
 *   `saveInvoicePage`). So an unchanged invoice never costs a request;
 * - not permanently missing (`detail_missing_count` < `MAX_PAGE_MISSING_ATTEMPTS`).
 */
export async function invoicesNeedingLines(sql: Sql, scope: LinesScope): Promise<InvoiceNeedingLines[]> {
  const needsLines = sql`i.status = 'active' and not i.lines_current and i.detail_missing_count < ${MAX_PAGE_MISSING_ATTEMPTS}`;
  const columns = sql`i.id::text as invoice_id, i.kreloses_sale_id as sale_id, i.header_version, i.detail_missing_count as missing_attempts, i.sale_at`;
  if ("saleIds" in scope) {
    if (scope.saleIds.length === 0) return [];
    const rows = await sql<InvoiceNeedingLines[]>`
      select ${columns} from invoices i where i.kreloses_sale_id = any(${[...scope.saleIds]}::text[]) and ${needsLines}
    `;
    const order = new Map(scope.saleIds.map((id, index) => [id, index]));
    return rows.sort((a, b) => order.get(a.saleId)! - order.get(b.saleId)!);
  }
  const { locationIds, limit, after } = scope.sweep;
  if (locationIds.length === 0) return [];
  return sql<InvoiceNeedingLines[]>`
    select ${columns} from invoices i
    join branches b on b.id = i.branch_id
    where ${needsLines} and b.kreloses_location_id = any(${[...locationIds]}::text[])
      ${after ? sql`and (i.sale_at, i.id) < (${after.saleAt}, ${after.invoiceId}::bigint)` : sql``}
    order by i.sale_at desc, i.id desc
    limit ${limit}
  `;
}

/**
 * How many invoices (any date) of these Kreloses locations' branches still need their line items
 * read, by the rule above (what a sweep that ran out of time leaves for the next one).
 */
export async function countInvoicesNeedingLines(sql: Sql, scope: { locationIds: readonly string[] }): Promise<number> {
  if (scope.locationIds.length === 0) return 0;
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from invoices i
    join branches b on b.id = i.branch_id
    where i.status = 'active' and not i.lines_current and i.detail_missing_count < ${MAX_PAGE_MISSING_ATTEMPTS}
      and b.kreloses_location_id = any(${[...scope.locationIds]}::text[])
  `;
  return row!.count;
}

/** Active invoices the sync has stopped trying to read (`MAX_PAGE_MISSING_ATTEMPTS`), newest first. */
export interface PermanentlyMissingInvoice {
  saleNumber: string | null;
  saleDate: string;
  branchName: string;
  attempts: number;
}

export async function listPermanentlyMissingInvoices(sql: Sql, options: { limit?: number } = {}): Promise<{ total: number; invoices: PermanentlyMissingInvoice[] }> {
  const rows = await sql<(PermanentlyMissingInvoice & { total: number })[]>`
    select i.sale_number, i.sale_date, b.name as branch_name, i.detail_missing_count as attempts, count(*) over ()::int as total
    from invoices i join branches b on b.id = i.branch_id
    where i.status = 'active' and not i.lines_current and i.detail_missing_count >= ${MAX_PAGE_MISSING_ATTEMPTS}
    order by i.sale_at desc, i.id desc
    limit ${options.limit ?? 20}
  `;
  return {
    total: rows[0]?.total ?? 0,
    invoices: rows.map((row) => ({ saleNumber: row.saleNumber, saleDate: row.saleDate, branchName: row.branchName, attempts: row.attempts })),
  };
}

/**
 * Records that an invoice's page was missing (not there) for `headerVersion` (a no-op if the header
 * moved on meanwhile). Call it inside the run's fenced transaction. Not for unreadable pages.
 */
export async function recordMissingPage(sql: Queryable, invoiceId: string, headerVersion: number): Promise<void> {
  await sql`
    update invoices set detail_missing_count = detail_missing_count + 1
    where id = ${invoiceId} and header_version = ${headerVersion}
  `;
}

export type SaveLinesResult =
  /** Stored and current. `gapSen` = net amount − Σ all line amounts (0 when the lines add up). */
  | { status: "stored"; gapSen: number }
  /** The header changed (another sync) since the page was chosen: nothing written; still pending. */
  | { status: "header_changed" };

/**
 * Stores an invoice's line items and derives its credited lines, in one transaction:
 *
 * 0. `options.fence(tx)` first, if given (the Sync Engine renews its connection lease there and
 *    throws if it lost it, so nothing is written after another run took over);
 * 1. locks the invoice row; if its `header_version` is no longer `headerVersion` (the version the
 *    page was opened for) nothing is written — the lines might belong to another state of the
 *    invoice; it stays "not synced yet" and the next sync reads it again;
 * 2. upserts `invoice_lines` by (invoice, line_no), deleting lines beyond the new count;
 * 3. makes sure every staff name on the lines has an alias (matching new names);
 * 4. `creditInvoice` (pure) → upserts `credited_lines` (credited amount before refunds, refund
 *    share; `revenue_amount` is generated from them), deleting rows no longer produced;
 * 5. sets `lines_header_version` (so the lines are current for exactly this header),
 *    `detail_fetched_at`, `raw_detail`, `line_gap_amount`, and clears `detail_missing_count`.
 *
 * Idempotent: reading the same page again leaves the same rows (ids included).
 */
export async function saveInvoiceLines(
  sql: Sql,
  values: { invoiceId: string; headerVersion: number; detail: KrelosesInvoiceDetail; fetchedAt: Date },
  options: { fence?: (tx: Queryable) => Promise<void> } = {},
): Promise<SaveLinesResult> {
  const { invoiceId, headerVersion, detail, fetchedAt } = values;
  return sql.begin(async (tx): Promise<SaveLinesResult> => {
    await options.fence?.(tx);
    const [header] = await tx<
      { status: "active" | "cancelled"; netAmount: string; totalAmount: string; totalRefunds: string; revenueBase: string; headerVersion: number }[]
    >`
      select status, net_amount, total_amount, total_refunds, revenue_base, header_version from invoices where id = ${invoiceId} for update
    `;
    if (!header) throw new Error(`invoice ${invoiceId} does not exist`);
    if (header.headerVersion !== headerVersion) return { status: "header_changed" };

    const lines = detail.lines.map((line) => ({
      line_no: line.lineNo,
      item_name: line.name,
      item_type: line.itemType,
      quantity: line.quantity,
      unit_price: line.unitPriceSen === null ? null : senToMoney(line.unitPriceSen),
      amount: line.amountSen === null ? null : senToMoney(line.amountSen),
      raw_staff_name: line.staffName,
      discount_name: line.discountName,
      discount_amount: senToMoney(line.discountAmountSen),
    }));
    const lineIds = new Map<number, string>();
    if (lines.length > 0) {
      const written = await tx<{ id: string; lineNo: number }[]>`
        insert into invoice_lines as l (
          invoice_id, line_no, item_name, item_type, quantity, unit_price, amount, raw_staff_name, discount_name, discount_amount
        )
        select ${invoiceId}::bigint, r.line_no, r.item_name, r.item_type, r.quantity, r.unit_price, r.amount,
          r.raw_staff_name, r.discount_name, r.discount_amount
        from jsonb_to_recordset(${tx.json(lines as unknown as JsonValue)}) as r(
          line_no integer, item_name text, item_type integer, quantity numeric, unit_price numeric, amount numeric,
          raw_staff_name text, discount_name text, discount_amount numeric
        )
        on conflict (invoice_id, line_no) do update set
          item_name = excluded.item_name,
          item_type = excluded.item_type,
          quantity = excluded.quantity,
          unit_price = excluded.unit_price,
          amount = excluded.amount,
          raw_staff_name = excluded.raw_staff_name,
          discount_name = excluded.discount_name,
          discount_amount = excluded.discount_amount
        returning id::text as id, line_no
      `;
      for (const row of written) lineIds.set(row.lineNo, row.id);
    }
    await tx`delete from invoice_lines where invoice_id = ${invoiceId} and line_no > ${lines.length}`;

    const attributionLines: AttributionLine[] = detail.lines.map((line) => ({
      lineNo: line.lineNo,
      itemType: line.itemType,
      quantity: line.quantity,
      unitPriceSen: line.unitPriceSen,
      amountSen: line.amountSen,
      staffName: line.staffName,
    }));
    const invoice = {
      status: header.status,
      netSen: moneyToSen(header.netAmount),
      totalSen: moneyToSen(header.totalAmount),
      totalRefundsSen: moneyToSen(header.totalRefunds),
    };
    // The revenue base has a TypeScript and an SQL definition (invoices.revenue_base); they must agree.
    if (invoiceRevenueBaseSen(invoice) !== moneyToSen(header.revenueBase)) {
      throw new Error(`invoice ${invoiceId}: invoiceRevenueBaseSen and invoices.revenue_base disagree; change both together`);
    }
    const credited = creditInvoice(invoice, attributionLines);
    const gapSen = invoice.netSen - detail.lines.reduce((total, line) => total + (line.amountSen ?? 0), 0);
    const aliases = await ensureAliases(tx, credited.flatMap((row) => (row.staffName ? [row.staffName] : [])));
    const rows = credited.map((row) => ({
      invoice_line_id: row.lineNo === null ? null : lineIds.get(row.lineNo)!,
      staff_alias_id: row.staffName ? aliases.get(aliasKey(row.staffName))! : null,
      gross_amount: senToMoney(row.grossSen),
      line_amount: senToMoney(row.lineAmountSen),
      spread_amount: senToMoney(row.spreadSen),
      credited_amount: senToMoney(row.creditedSen),
      refund_amount: senToMoney(row.refundSen),
    }));
    const itemized = rows.filter((row) => row.invoice_line_id !== null);
    const remainder = rows.find((row) => row.invoice_line_id === null);

    await tx`
      delete from credited_lines
      where invoice_id = ${invoiceId}
        and (invoice_line_id is null or invoice_line_id <> all(${itemized.map((row) => row.invoice_line_id!)}::bigint[]))
        ${remainder ? tx`and invoice_line_id is not null` : tx``}
    `;
    if (itemized.length > 0) {
      await tx`
        insert into credited_lines as c (invoice_id, invoice_line_id, staff_alias_id, gross_amount, line_amount, spread_amount, credited_amount, refund_amount)
        select ${invoiceId}::bigint, r.invoice_line_id, r.staff_alias_id, r.gross_amount, r.line_amount, r.spread_amount, r.credited_amount, r.refund_amount
        from jsonb_to_recordset(${tx.json(itemized as unknown as JsonValue)}) as r(
          invoice_line_id bigint, staff_alias_id bigint, gross_amount numeric, line_amount numeric, spread_amount numeric,
          credited_amount numeric, refund_amount numeric
        )
        on conflict (invoice_line_id) do update set
          staff_alias_id = excluded.staff_alias_id,
          gross_amount = excluded.gross_amount,
          line_amount = excluded.line_amount,
          spread_amount = excluded.spread_amount,
          credited_amount = excluded.credited_amount,
          refund_amount = excluded.refund_amount
        where (c.staff_alias_id, c.gross_amount, c.line_amount, c.spread_amount, c.credited_amount, c.refund_amount)
          is distinct from (excluded.staff_alias_id, excluded.gross_amount, excluded.line_amount, excluded.spread_amount, excluded.credited_amount, excluded.refund_amount)
      `;
    }
    if (remainder) {
      await tx`
        insert into credited_lines as c (invoice_id, invoice_line_id, staff_alias_id, gross_amount, line_amount, spread_amount, credited_amount, refund_amount)
        values (${invoiceId}, null, null, ${remainder.gross_amount}, ${remainder.line_amount}, ${remainder.spread_amount}, ${remainder.credited_amount}, ${remainder.refund_amount})
        on conflict (invoice_id) where invoice_line_id is null do update set
          spread_amount = excluded.spread_amount,
          credited_amount = excluded.credited_amount,
          refund_amount = excluded.refund_amount
        where (c.spread_amount, c.credited_amount, c.refund_amount) is distinct from (excluded.spread_amount, excluded.credited_amount, excluded.refund_amount)
      `;
    }

    await tx`
      update invoices set
        lines_header_version = ${headerVersion},
        detail_fetched_at = ${fetchedAt},
        raw_detail = ${tx.json(detail.raw as JsonValue)},
        line_gap_amount = ${senToMoney(gapSen)},
        detail_missing_count = 0
      where id = ${invoiceId}
    `;
    return { status: "stored", gapSen };
  });
}
