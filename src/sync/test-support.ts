import { randomBytes } from "node:crypto";

import { keyringFromEnv } from "@/connections/encryption";
import { loginAsConnection, saveConnection, type ConnectionsContext } from "@/connections/service";
import type { Sql } from "@/db/sql";
import { createFakeKreloses, type FakeKreloses, type FakeKrelosesOptions } from "@/kreloses/testing/fake-kreloses";

import type { SyncDeps } from "./engine";

/**
 * Test harness for the Sync Engine (Seam 1): a fake Kreloses (synthetic Sale List fixtures), a
 * connections context pointed at it, a controllable clock and a `sleep` that only advances it.
 */
export interface SyncHarness {
  fake: FakeKreloses;
  context: ConnectionsContext;
  clock: { now: Date; advance(ms: number): void };
  /** Every wait the engine asked for, in ms. */
  sleeps: number[];
  deps(overrides?: Partial<SyncDeps>): SyncDeps;
  /** Saves (and login-tests) a connection for a synthetic account; returns its id. */
  connect(account: { email: string; password: string }, label?: string): Promise<string>;
}

export function createSyncHarness(sql: Sql, options: { fake?: FakeKrelosesOptions; now?: Date; requestDelayMs?: number } = {}): SyncHarness {
  const fake = createFakeKreloses(options.fake);
  const keyring = keyringFromEnv({ CREDENTIALS_ENCRYPTION_KEY: randomBytes(32).toString("base64") });
  const context: ConnectionsContext = { sql, keyring: () => keyring, reader: { requestDelayMs: options.requestDelayMs ?? 0, transport: fake.transport } };
  const clock = {
    now: options.now ?? new Date("2026-10-01T02:00:00Z"),
    advance(ms: number) {
      clock.now = new Date(clock.now.getTime() + ms);
    },
  };
  const sleeps: number[] = [];
  return {
    fake,
    context,
    clock,
    sleeps,
    deps: (overrides = {}) => ({
      sql,
      login: (id) => loginAsConnection(context, id),
      now: () => clock.now,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock.advance(ms);
      },
      ...overrides,
    }),
    async connect(account, label = account.email) {
      const saved = await saveConnection(context, { label, email: account.email, password: account.password });
      if (!saved.ok) throw new Error(`could not save the test connection: ${JSON.stringify(saved)}`);
      return saved.connection.id;
    },
  };
}

/**
 * Every synced row, keyed by Kreloses ids and names instead of surrogate ids, without what differs
 * between runs by design (run ids, fetch/detail timestamps, created/updated times): two databases
 * holding the same synced data give equal snapshots however many runs it took.
 */
export async function snapshotSyncedData(sql: Sql) {
  return {
    branches: await sql`
      select b.kreloses_location_id, b.name, c.label as connection from branches b left join connections c on c.id = b.connection_id
      order by b.kreloses_location_id
    `,
    customers: await sql`select kreloses_customer_id, name, name_seen_at, first_seen_date from customers order by kreloses_customer_id`,
    invoices: await sql`
      select i.kreloses_sale_id, i.sale_number, b.kreloses_location_id, cu.kreloses_customer_id, i.sale_at, i.sale_date, i.status,
        i.status_name, i.gross_amount, i.discount_amount, i.net_amount, i.tax_amount, i.total_amount, i.payment_status,
        i.total_payments, i.total_refunds, i.raw_header, i.raw_detail, i.header_version, i.lines_header_version, i.lines_current,
        i.revenue_base, i.line_gap_amount, i.detail_missing_count
      from invoices i join branches b on b.id = i.branch_id left join customers cu on cu.id = i.customer_id
      order by i.kreloses_sale_id
    `,
    invoiceLines: await sql`
      select i.kreloses_sale_id, l.line_no, l.item_name, l.item_type, l.quantity, l.unit_price, l.amount, l.raw_staff_name,
        l.discount_name, l.discount_amount
      from invoice_lines l join invoices i on i.id = l.invoice_id
      order by i.kreloses_sale_id, l.line_no
    `,
    creditedLines: await sql`
      select i.kreloses_sale_id, l.line_no, a.normalised_name as alias, c.gross_amount, c.line_amount, c.spread_amount,
        c.credited_amount, c.refund_amount, c.revenue_amount
      from credited_lines c join invoices i on i.id = c.invoice_id
      left join invoice_lines l on l.id = c.invoice_line_id left join staff_aliases a on a.id = c.staff_alias_id
      order by i.kreloses_sale_id, l.line_no nulls last
    `,
    staff: await sql`select full_name, name_key, kind, kind_source, source, kreloses_staff_id, active from staff order by full_name, source`,
    staffAliases: await sql`
      select a.raw_name, a.normalised_name, a.match, s.full_name as staff from staff_aliases a join staff s on s.id = a.staff_id
      order by a.normalised_name
    `,
  };
}

/** Empties every table the sync writes (and connections), children first. */
export async function clearSyncTables(sql: Sql): Promise<void> {
  await sql`delete from invoices`; // cascades to invoice_lines and credited_lines
  await sql`delete from staff_aliases`;
  await sql`delete from staff`;
  await sql`delete from customers`;
  await sql`delete from sync_runs`;
  await sql`delete from branches`;
  await sql`delete from connections`;
}
