import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { revenueFacts } from "@/analytics";
import { createDatabase, databaseUrl, dropDatabase, timestampedDatabaseName } from "@/db/admin";
import { applyMigrations, listMigrations } from "@/db/migrate";
import { createSql, type Sql } from "@/db/sql";

/**
 * The #6 migration on a database that already holds credited lines computed before refunds counted:
 * refunded invoices get the new revenue base at once, and their stale credited lines stop counting
 * (they turn "line items not synced yet" at the new base until the nightly sweep reads them again),
 * so history reflects the new definition without double counting.
 */
const REFUNDS_MIGRATION = "20260928064341";

describe("migration: refunds come off the revenue base (existing data)", () => {
  const name = timestampedDatabaseName("kx_test_");
  let sql: Sql;
  let before: string;

  beforeAll(async () => {
    await createDatabase(name);
    sql = createSql(databaseUrl(name), { max: 1 });
    // Every migration before #6's, from a directory of their own.
    before = await mkdtemp(path.join(tmpdir(), "kx-migrations-"));
    for (const migration of await listMigrations()) {
      if (migration.version < REFUNDS_MIGRATION) await copyFile(migration.file, path.join(before, path.basename(migration.file)));
    }
    await applyMigrations(sql, before);
  }, 60_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await dropDatabase(name);
    if (before) await rm(before, { recursive: true, force: true });
  }, 60_000);

  it("re-bases refunded invoices and makes their old credited lines pending; everything else is untouched", async () => {
    const [branch] = await sql<{ id: string }[]>`
      insert into branches (kreloses_location_id, name) values ('1102', 'Branch South') returning id::text as id
    `;
    const invoice = async (saleId: string, status: string, net: string, total: string, refunds: string) => {
      const [row] = await sql<{ id: string }[]>`
        insert into invoices (kreloses_sale_id, branch_id, sale_at, status, status_name, gross_amount, discount_amount, net_amount,
          tax_amount, total_amount, total_payments, total_refunds, raw_header, fetched_at, lines_header_version)
        values (${saleId}, ${branch!.id}, '2026-09-15T08:20:00Z', ${status}, ${status}, ${net}, 0, ${net}, 0, ${total}, ${total}, ${refunds},
          '{}', now(), 1)
        returning id::text as id
      `;
      const [line] = await sql<{ id: string }[]>`
        insert into invoice_lines (invoice_id, line_no, item_name, item_type, quantity, unit_price, amount)
        values (${row!.id}, 1, 'Surgery', 4, 1, ${net}, ${net}) returning id::text as id
      `;
      await sql`
        insert into credited_lines (invoice_id, invoice_line_id, gross_amount, line_amount, spread_amount, credited_amount)
        values (${row!.id}, ${line!.id}, ${net}, ${net}, ${status === "active" ? "0" : `-${net}`}, ${status === "active" ? net : "0"})
      `;
    };
    await invoice("refunded", "active", "1100.00", "1100.00", "100.00");
    await invoice("plain", "active", "600.00", "600.00", "0.00");
    await invoice("return", "active", "-120.00", "-120.00", "120.00");
    await invoice("cancelled", "cancelled", "75.00", "75.00", "75.00");

    await applyMigrations(sql); // the #6 migration (and anything later)

    expect(
      await sql`select kreloses_sale_id, revenue_base, header_version, lines_current from invoices order by kreloses_sale_id`,
    ).toEqual([
      { krelosesSaleId: "cancelled", revenueBase: "0.00", headerVersion: 1, linesCurrent: true },
      { krelosesSaleId: "plain", revenueBase: "600.00", headerVersion: 1, linesCurrent: true },
      { krelosesSaleId: "refunded", revenueBase: "1000.00", headerVersion: 2, linesCurrent: false },
      { krelosesSaleId: "return", revenueBase: "-120.00", headerVersion: 1, linesCurrent: true },
    ]);
    // Existing credited lines: no refund share yet, revenue = credited amount.
    expect(await sql`select credited_amount, refund_amount, revenue_amount from credited_lines order by credited_amount`).toEqual([
      { creditedAmount: "-120.00", refundAmount: "0.00", revenueAmount: "-120.00" },
      { creditedAmount: "0.00", refundAmount: "0.00", revenueAmount: "0.00" },
      { creditedAmount: "600.00", refundAmount: "0.00", revenueAmount: "600.00" },
      { creditedAmount: "1100.00", refundAmount: "0.00", revenueAmount: "1100.00" },
    ]);
    // Revenue: the refunded sale counts once, at its new base, as not synced yet.
    const facts = await sql<{ creditGroup: string; revenue: string }[]>`
      with facts as (${revenueFacts(sql, { branches: { all: true }, staff: { all: true } })})
      select credit_group, sum(revenue)::text as revenue from facts group by 1 order by 1
    `;
    expect(facts).toEqual([
      { creditGroup: "no_staff", revenue: "480.00" },
      { creditGroup: "pending", revenue: "1000.00" },
    ]);
  });
});
