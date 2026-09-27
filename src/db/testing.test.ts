import { describe, expect, it } from "vitest";

import { databaseExists } from "./admin";
import { listMigrations } from "./migrate";
import { createTestDatabase, useTestDatabase } from "./testing";

describe("test database harness", () => {
  const db = useTestDatabase();

  it("gives each test file a fresh database with every migration applied", async () => {
    const applied = await db.sql<{ version: string }[]>`
      select version from supabase_migrations.schema_migrations order by version
    `;
    const expected = (await listMigrations()).map((m) => m.version);
    expect(expected.length).toBeGreaterThan(0);
    expect(applied.map((row) => row.version)).toEqual(expected);
  });

  it("returns date columns as plain calendar-date strings and columns camelCased", async () => {
    const [row] = await db.sql<{ saleDate: string }[]>`select date '2026-09-28' as sale_date`;
    expect(row).toEqual({ saleDate: "2026-09-28" });
  });

  it("isolates databases from each other and drops them on close", async () => {
    const other = await createTestDatabase();
    try {
      expect(other.name).not.toBe(db.url);
      await other.sql`create table only_here (id int)`;
      const [{ exists }] = await db.sql<{ exists: boolean }[]>`
        select to_regclass('public.only_here') is not null as exists
      `;
      expect(exists).toBe(false);
    } finally {
      await other.close();
    }
    expect(await databaseExists(other.name)).toBe(false);
  });
});
