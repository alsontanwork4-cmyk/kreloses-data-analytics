import type { JsonValue, Queryable, Sql } from "@/db/sql";
import type { KrelosesInvoice, KrelosesLocation } from "@/kreloses";
import { senToMoney } from "@/lib/money";

/**
 * The Sync Engine's writes. Every upsert is idempotent: a row is only written when a value
 * actually changed (`on conflict … do update … where (…) is distinct from (…)`), so reading the
 * same Kreloses data twice changes nothing — not even timestamps.
 */

/** Stores the branches a connection can see (name, and which connection saw it last). */
export async function upsertBranches(sql: Sql, connectionId: string, locations: KrelosesLocation[]): Promise<void> {
  if (locations.length === 0) return;
  const rows = locations.map((location) => ({ location_id: location.id, name: location.name.trim() }));
  await sql`
    insert into branches as b (kreloses_location_id, name, connection_id)
    select r.location_id, r.name, ${connectionId}::bigint
    from jsonb_to_recordset(${sql.json(rows)}) as r(location_id text, name text)
    on conflict (kreloses_location_id) do update set name = excluded.name, connection_id = excluded.connection_id
    where (b.name, b.connection_id) is distinct from (excluded.name, excluded.connection_id)
  `;
}

export interface PageWrite {
  inserted: number;
  updated: number;
  unchanged: number;
}

/**
 * Stores one page of invoices (and any branch or customer they introduce) in one statement set;
 * call it inside the transaction that also records the run's progress. `fetchedAt` is written only
 * on rows that are new or changed.
 */
export async function saveInvoicePage(
  sql: Queryable,
  values: { runId: string; connectionId: string; invoices: KrelosesInvoice[]; fetchedAt: Date },
): Promise<PageWrite> {
  // A sale can appear twice when rows shift between pages; keep the first (newest) reading.
  const invoices = [...new Map(values.invoices.map((invoice) => [invoice.saleId, invoice])).values()];
  if (invoices.length === 0) return { inserted: 0, updated: 0, unchanged: values.invoices.length };

  // Branches first seen on an invoice (normally already stored from the location list).
  const locations = [...new Map(invoices.map((invoice) => [invoice.locationId, invoice.locationName])).entries()];
  await sql`
    insert into branches (kreloses_location_id, name, connection_id)
    select r.location_id, r.name, ${values.connectionId}::bigint
    from jsonb_to_recordset(${sql.json(locations.map(([id, name]) => ({ location_id: id, name })))}) as r(location_id text, name text)
    on conflict (kreloses_location_id) do nothing
  `;

  await upsertCustomers(sql, invoices);

  const rows = invoices.map((invoice) => ({
    sale_id: invoice.saleId,
    sale_number: invoice.saleNumber,
    location_id: invoice.locationId,
    customer_id: invoice.customerId,
    sale_at: invoice.saleAt.toISOString(),
    status: invoice.status,
    status_name: invoice.statusName,
    gross_amount: senToMoney(invoice.grossSen),
    discount_amount: senToMoney(invoice.discountsSen),
    net_amount: senToMoney(invoice.netSen),
    tax_amount: senToMoney(invoice.taxSen),
    total_amount: senToMoney(invoice.totalSen),
    payment_status: invoice.paymentStatus,
    total_payments: senToMoney(invoice.totalPaymentsSen),
    total_refunds: senToMoney(invoice.totalRefundsSen),
    raw_header: invoice.raw,
  }));
  const written = await sql<{ inserted: boolean }[]>`
    insert into invoices as i (
      kreloses_sale_id, sale_number, branch_id, customer_id, sale_at, status, status_name,
      gross_amount, discount_amount, net_amount, tax_amount, total_amount,
      payment_status, total_payments, total_refunds, raw_header, sync_run_id, fetched_at
    )
    select
      r.sale_id, r.sale_number, b.id, c.id, r.sale_at, r.status, r.status_name,
      r.gross_amount, r.discount_amount, r.net_amount, r.tax_amount, r.total_amount,
      r.payment_status, r.total_payments, r.total_refunds, r.raw_header, ${values.runId}::bigint, ${values.fetchedAt}
    from jsonb_to_recordset(${sql.json(rows as unknown as JsonValue)}) as r(
      sale_id text, sale_number text, location_id text, customer_id text, sale_at timestamptz, status text, status_name text,
      gross_amount numeric, discount_amount numeric, net_amount numeric, tax_amount numeric, total_amount numeric,
      payment_status text, total_payments numeric, total_refunds numeric, raw_header jsonb
    )
    join branches b on b.kreloses_location_id = r.location_id
    left join customers c on c.kreloses_customer_id = r.customer_id
    on conflict (kreloses_sale_id) do update set
      sale_number = excluded.sale_number,
      branch_id = excluded.branch_id,
      customer_id = excluded.customer_id,
      sale_at = excluded.sale_at,
      status = excluded.status,
      status_name = excluded.status_name,
      gross_amount = excluded.gross_amount,
      discount_amount = excluded.discount_amount,
      net_amount = excluded.net_amount,
      tax_amount = excluded.tax_amount,
      total_amount = excluded.total_amount,
      payment_status = excluded.payment_status,
      total_payments = excluded.total_payments,
      total_refunds = excluded.total_refunds,
      raw_header = excluded.raw_header,
      sync_run_id = excluded.sync_run_id,
      fetched_at = excluded.fetched_at
    where (
      i.sale_number, i.branch_id, i.customer_id, i.sale_at, i.status, i.status_name,
      i.gross_amount, i.discount_amount, i.net_amount, i.tax_amount, i.total_amount,
      i.payment_status, i.total_payments, i.total_refunds
    ) is distinct from (
      excluded.sale_number, excluded.branch_id, excluded.customer_id, excluded.sale_at, excluded.status, excluded.status_name,
      excluded.gross_amount, excluded.discount_amount, excluded.net_amount, excluded.tax_amount, excluded.total_amount,
      excluded.payment_status, excluded.total_payments, excluded.total_refunds
    )
    returning (xmax = 0) as inserted
  `;
  const inserted = written.filter((row) => row.inserted).length;
  const updated = written.length - inserted;
  return { inserted, updated, unchanged: values.invoices.length - inserted - updated };
}

/**
 * Customers on the page. The name comes from the customer's latest sale seen (a name read from an
 * older sale never overwrites a newer one); `first_seen_date` is the earliest clinic day seen.
 */
async function upsertCustomers(sql: Queryable, invoices: KrelosesInvoice[]): Promise<void> {
  const byCustomer = new Map<string, { customer_id: string; name: string | null; name_seen_at: string; first_seen_date: string }>();
  for (const invoice of invoices) {
    if (!invoice.customerId) continue;
    const seen = byCustomer.get(invoice.customerId);
    if (!seen) {
      byCustomer.set(invoice.customerId, {
        customer_id: invoice.customerId,
        name: invoice.customerName,
        name_seen_at: invoice.saleAt.toISOString(),
        first_seen_date: invoice.saleDate,
      });
      continue;
    }
    if (invoice.saleAt.toISOString() > seen.name_seen_at) {
      seen.name = invoice.customerName;
      seen.name_seen_at = invoice.saleAt.toISOString();
    }
    if (invoice.saleDate < seen.first_seen_date) seen.first_seen_date = invoice.saleDate;
  }
  if (byCustomer.size === 0) return;
  await sql`
    insert into customers as c (kreloses_customer_id, name, name_seen_at, first_seen_date)
    select r.customer_id, r.name, r.name_seen_at, r.first_seen_date
    from jsonb_to_recordset(${sql.json([...byCustomer.values()])}) as r(
      customer_id text, name text, name_seen_at timestamptz, first_seen_date date
    )
    on conflict (kreloses_customer_id) do update set
      name = case when c.name_seen_at is null or excluded.name_seen_at >= c.name_seen_at then excluded.name else c.name end,
      name_seen_at = greatest(c.name_seen_at, excluded.name_seen_at),
      first_seen_date = least(c.first_seen_date, excluded.first_seen_date)
    where excluded.first_seen_date < c.first_seen_date
      or c.name_seen_at is null
      or excluded.name_seen_at > c.name_seen_at
      or (excluded.name_seen_at = c.name_seen_at and excluded.name is distinct from c.name)
  `;
}
