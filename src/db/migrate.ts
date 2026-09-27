import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { Sql } from "./sql";

/**
 * Applies `supabase/migrations/*.sql` to a database, in filename order, each in its own
 * transaction. Applied versions are recorded in `supabase_migrations.schema_migrations` (the same
 * table the Supabase CLI uses), so re-running only applies new files.
 *
 * Used by the test harness and `npm run db:create-dev`. Production and the shared local
 * `postgres` database are migrated by the Supabase CLI (`supabase db push` / `supabase start`).
 *
 * The directory is resolved from the repo root: tests, scripts and e2e all run from there.
 */
export const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");

const MIGRATION_FILE = /^(\d{14})_([A-Za-z0-9_-]+)\.sql$/;

export interface Migration {
  version: string;
  name: string;
  file: string;
}

export async function listMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((file) => file.endsWith(".sql")).sort();
  const seen = new Set<string>();
  return files.map((file) => {
    const match = MIGRATION_FILE.exec(file);
    if (!match) {
      throw new Error(
        `Bad migration filename "${file}": expected <YYYYMMDDHHMMSS>_<name>.sql (use \`supabase migration new <name>\`)`,
      );
    }
    const [, version, name] = match as unknown as [string, string, string];
    if (seen.has(version)) throw new Error(`Duplicate migration version ${version} (${file})`);
    seen.add(version);
    return { version, name, file: path.join(dir, file) };
  });
}

/** Applies pending migrations and returns the versions it applied. */
export async function applyMigrations(sql: Sql, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  await sql`create schema if not exists supabase_migrations`;
  await sql`
    create table if not exists supabase_migrations.schema_migrations (
      version text primary key,
      statements text[],
      name text
    )
  `;
  const appliedRows = await sql<{ version: string }[]>`
    select version from supabase_migrations.schema_migrations
  `;
  const applied = new Set(appliedRows.map((row) => row.version));

  const newlyApplied: string[] = [];
  for (const migration of await listMigrations(dir)) {
    if (applied.has(migration.version)) continue;
    const body = await readFile(migration.file, "utf8");
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`
          insert into supabase_migrations.schema_migrations (version, name, statements)
          values (${migration.version}, ${migration.name}, ${[body]})
        `;
      });
    } catch (error) {
      throw new Error(
        `Migration ${path.basename(migration.file)} failed: ${(error as Error).message}`,
        { cause: error },
      );
    }
    newlyApplied.push(migration.version);
  }
  return newlyApplied;
}
