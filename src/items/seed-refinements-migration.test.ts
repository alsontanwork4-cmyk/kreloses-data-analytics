import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, databaseUrl, dropDatabase, timestampedDatabaseName } from "@/db/admin";
import { applyMigrations, listMigrations } from "@/db/migrate";
import { createSql, type Sql } from "@/db/sql";

import { assignItem, reclassifyAllItems } from "./store";

/**
 * The seed-rule refinements migration (follow-up to #9) on a database that already has the #9 seed
 * rules, an owner's rules and assignments, and classified items: it changes only SEED rules (found by
 * their text), keeps the owner's rules and assignments, can run twice, and the next per-run
 * recompute (`reclassifyAllItems`, what every sync run starts with) brings the items in line.
 */
const REFINEMENTS = "20260928091620";

describe("migration: item-group seed rule refinements (existing data)", () => {
  const name = timestampedDatabaseName("kx_test_");
  let sql: Sql;
  let before: string;
  let migrationSql: string;

  beforeAll(async () => {
    await createDatabase(name);
    sql = createSql(databaseUrl(name), { max: 1 });
    before = await mkdtemp(path.join(tmpdir(), "kx-migrations-"));
    const migrations = await listMigrations();
    for (const migration of migrations) {
      if (migration.version < REFINEMENTS) await copyFile(migration.file, path.join(before, path.basename(migration.file)));
    }
    await applyMigrations(sql, before);
    migrationSql = await readFile(migrations.find((migration) => migration.version === REFINEMENTS)!.file, "utf8");
  }, 60_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await dropDatabase(name);
    if (before) await rm(before, { recursive: true, force: true });
  }, 60_000);

  const groupOf = async (itemName: string) =>
    (await sql<{ mixGroup: string; isProcedure: boolean }[]>`select mix_group, is_procedure from item_classifications where item_name = ${itemName}`)[0];

  it("changes only seed rules, keeps the owner's rules and assignments, and the next recompute follows", async () => {
    const [branch] = await sql<{ id: string }[]>`insert into branches (kreloses_location_id, name) values ('1101', 'Branch North') returning id::text as id`;
    const [invoice] = await sql<{ id: string }[]>`
      insert into invoices (kreloses_sale_id, branch_id, sale_at, status, status_name, gross_amount, discount_amount, net_amount,
        tax_amount, total_amount, total_payments, total_refunds, raw_header, fetched_at)
      values ('900001', ${branch!.id}, now(), 'active', 'Active', 0, 0, 0, 0, 0, 0, 0, '{}', now()) returning id::text as id
    `;
    const names = ["Spay + pre-op check", "Surgery package", "Castration - cryptorchid (testicle removal)", "Eye foreign body flush", "Neuter check"];
    for (const [index, itemName] of names.entries()) {
      await sql`insert into invoice_lines (invoice_id, line_no, item_name, item_type, quantity, unit_price, amount) values (${invoice!.id}, ${index + 1}, ${itemName}, 4, 1, 0, 0)`;
    }
    // The owner re-created one of the broad patterns as their own rule, and assigned an item.
    await sql`delete from item_group_rules where source = 'seed' and match_type = 'pattern' and pattern = '%neuter%check%'`;
    await sql`insert into item_group_rules (match_type, pattern, priority, mix_group, is_consult, source) values ('pattern', '%neuter%check%', 96, 'consult', true, 'owner')`;
    await assignItem(sql, { itemKey: "eye foreign body flush", classification: { group: "diagnostics", surgery: false, consult: false, vaccine: false, dentalScaling: false, procedure: false } });
    await reclassifyAllItems(sql);
    expect(await groupOf("Spay + pre-op check")).toEqual({ mixGroup: "consult", isProcedure: false }); // the old, too broad rule
    expect(await groupOf("Castration - cryptorchid (testicle removal)")).toEqual({ mixGroup: "unmapped", isProcedure: false });

    await sql.unsafe(migrationSql);
    await sql.unsafe(migrationSql); // twice: nothing more happens

    const rule = (matchType: string, pattern: string) =>
      sql<{ source: string }[]>`select source from item_group_rules where match_type = ${matchType} and pattern = ${pattern}`;
    expect(await rule("pattern", "%spay%check%")).toEqual([]);
    expect(await rule("pattern", "%cast%remov%")).toEqual([]);
    expect(await rule("pattern", "%neuter%check%")).toEqual([{ source: "owner" }]); // the owner's own rule stays
    expect(await rule("pattern", "spay check%")).toEqual([{ source: "seed" }]);
    expect(await rule("exact", "surgery pack")).toEqual([{ source: "seed" }]);
    expect(await sql`select item_key from item_assignments`).toEqual([{ itemKey: "eye foreign body flush" }]);

    // The migration cannot run the matcher: the next sync run's recompute brings the items in line.
    expect(await reclassifyAllItems(sql)).toBe(3);
    expect(await groupOf("Spay + pre-op check")).toEqual({ mixGroup: "surgery", isProcedure: true });
    expect(await groupOf("Surgery package")).toEqual({ mixGroup: "surgery", isProcedure: true });
    expect(await groupOf("Castration - cryptorchid (testicle removal)")).toEqual({ mixGroup: "surgery", isProcedure: true });
    expect(await groupOf("Eye foreign body flush")).toEqual({ mixGroup: "diagnostics", isProcedure: false }); // the owner's assignment
    expect(await groupOf("Neuter check")).toEqual({ mixGroup: "consult", isProcedure: false });
  });
});
