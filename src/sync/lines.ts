import { aliasKey, creditInvoice, invoiceRevenueBaseSen, type AttributionLine } from "@/attribution";
import type { JsonValue, Sql } from "@/db/sql";
import type { KrelosesInvoiceDetail } from "@/kreloses";
import { moneyToSen, senToMoney } from "@/lib/money";
import { ensureAliases } from "@/staff/store";

/**
 * Line items: which invoices need their Sale Overview page read, and storing what it says —
 * `invoice_lines`, the staff aliases on them, and the `credited_lines` derived by Attribution &
 * Rules — in ONE transaction per invoice, so an invoice's credited lines always add up to the
 * header they were computed from.
 */

/** An invoice whose line items must be (re)read. */
export interface InvoiceNeedingLines {
  invoiceId: string;
  saleId: string;
  /** The header version the lines will be computed for (see `saveInvoiceLines`). */
  headerVersion: number;
}

/**
 * THE rule for which invoices need their line items (re)read (#6 refines change detection here):
 * active invoices whose lines are not current — never read, or the header changed since they were
 * (`invoices.lines_current`: `lines_header_version = header_version`, and the version moves only
 * when a parsed header column changes). Cancelled invoices are never read (they credit nothing).
 * Only among `saleIds` (the Sale List page just stored), in the page's order.
 */
export async function invoicesNeedingLines(sql: Sql, saleIds: readonly string[]): Promise<InvoiceNeedingLines[]> {
  if (saleIds.length === 0) return [];
  const rows = await sql<InvoiceNeedingLines[]>`
    select i.id::text as invoice_id, i.kreloses_sale_id as sale_id, i.header_version
    from invoices i
    where i.kreloses_sale_id = any(${[...saleIds]}::text[]) and i.status = 'active' and not i.lines_current
  `;
  const order = new Map(saleIds.map((id, index) => [id, index]));
  return rows.sort((a, b) => order.get(a.saleId)! - order.get(b.saleId)!);
}

export type SaveLinesResult =
  /** Stored and current. `gapSen` = net amount − Σ all line amounts (0 when the lines add up). */
  | { status: "stored"; gapSen: number }
  /** The header changed (another sync) since the page was chosen: nothing written; still pending. */
  | { status: "header_changed" };

/**
 * Stores an invoice's line items and derives its credited lines, in one transaction:
 *
 * 1. locks the invoice row; if its `header_version` is no longer `headerVersion` (the version the
 *    page was opened for) nothing is written — the lines might belong to another state of the
 *    invoice; it stays "not synced yet" and the next sync reads it again;
 * 2. upserts `invoice_lines` by (invoice, line_no), deleting lines beyond the new count;
 * 3. makes sure every staff name on the lines has an alias (matching new names);
 * 4. `creditInvoice` (pure) → upserts `credited_lines`, deleting rows no longer produced;
 * 5. sets `lines_header_version` (so the lines are current for exactly this header),
 *    `detail_fetched_at`, `raw_detail` and `line_gap_amount`.
 *
 * Idempotent: reading the same page again leaves the same rows (ids included).
 */
export async function saveInvoiceLines(
  sql: Sql,
  values: { invoiceId: string; headerVersion: number; detail: KrelosesInvoiceDetail; fetchedAt: Date },
): Promise<SaveLinesResult> {
  const { invoiceId, headerVersion, detail, fetchedAt } = values;
  return sql.begin(async (tx): Promise<SaveLinesResult> => {
    const [header] = await tx<{ status: "active" | "cancelled"; netAmount: string; totalRefunds: string; revenueBase: string; headerVersion: number }[]>`
      select status, net_amount, total_refunds, revenue_base, header_version from invoices where id = ${invoiceId} for update
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
    const invoice = { status: header.status, netSen: moneyToSen(header.netAmount), totalRefundsSen: moneyToSen(header.totalRefunds) };
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
        insert into credited_lines as c (invoice_id, invoice_line_id, staff_alias_id, gross_amount, line_amount, spread_amount, credited_amount)
        select ${invoiceId}::bigint, r.invoice_line_id, r.staff_alias_id, r.gross_amount, r.line_amount, r.spread_amount, r.credited_amount
        from jsonb_to_recordset(${tx.json(itemized as unknown as JsonValue)}) as r(
          invoice_line_id bigint, staff_alias_id bigint, gross_amount numeric, line_amount numeric, spread_amount numeric, credited_amount numeric
        )
        on conflict (invoice_line_id) do update set
          staff_alias_id = excluded.staff_alias_id,
          gross_amount = excluded.gross_amount,
          line_amount = excluded.line_amount,
          spread_amount = excluded.spread_amount,
          credited_amount = excluded.credited_amount
        where (c.staff_alias_id, c.gross_amount, c.line_amount, c.spread_amount, c.credited_amount)
          is distinct from (excluded.staff_alias_id, excluded.gross_amount, excluded.line_amount, excluded.spread_amount, excluded.credited_amount)
      `;
    }
    if (remainder) {
      await tx`
        insert into credited_lines as c (invoice_id, invoice_line_id, staff_alias_id, gross_amount, line_amount, spread_amount, credited_amount)
        values (${invoiceId}, null, null, ${remainder.gross_amount}, ${remainder.line_amount}, ${remainder.spread_amount}, ${remainder.credited_amount})
        on conflict (invoice_id) where invoice_line_id is null do update set
          spread_amount = excluded.spread_amount,
          credited_amount = excluded.credited_amount
        where (c.spread_amount, c.credited_amount) is distinct from (excluded.spread_amount, excluded.credited_amount)
      `;
    }

    await tx`
      update invoices set
        lines_header_version = ${headerVersion},
        detail_fetched_at = ${fetchedAt},
        raw_detail = ${tx.json(detail.raw as JsonValue)},
        line_gap_amount = ${senToMoney(gapSen)}
      where id = ${invoiceId}
    `;
    return { status: "stored", gapSen };
  });
}
