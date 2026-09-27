/**
 * Creates (or updates) your own development database on the shared local cluster and applies
 * every migration. Idempotent: re-run it after pulling new migrations.
 *
 *   npm run db:create-dev -- kx_dev_issue5            # create + migrate + seed OWNER_EMAIL
 *   npm run db:create-dev -- kx_dev_issue5 --reset    # drop and start again
 *   npm run db:create-dev -- kx_dev_issue5 --env      # also write .env.local for this worktree
 */
import { upsertOwner } from "../src/auth/allow-list";
import {
  assertManagedDatabaseName,
  createDatabase,
  databaseExists,
  databaseUrl,
  dropDatabase,
} from "../src/db/admin";
import { applyMigrations } from "../src/db/migrate";
import { createSql } from "../src/db/sql";

import { loadLocalEnv, localSupabaseAuthEnv, upsertEnvFile } from "./env";

async function main() {
  loadLocalEnv();
  const args = process.argv.slice(2);
  const name = args.find((arg) => !arg.startsWith("--"));
  if (!name) {
    console.error("Usage: npm run db:create-dev -- <kx_dev_name> [--reset] [--env]");
    process.exit(1);
  }
  assertManagedDatabaseName(name);

  if (args.includes("--reset")) {
    await dropDatabase(name);
    console.log(`Dropped ${name}`);
  }
  if (await databaseExists(name)) {
    console.log(`Using existing database ${name}`);
  } else {
    await createDatabase(name);
    console.log(`Created database ${name}`);
  }

  const url = databaseUrl(name);
  const sql = createSql(url, { max: 1 });
  try {
    const applied = await applyMigrations(sql);
    console.log(applied.length ? `Applied migrations: ${applied.join(", ")}` : "Migrations up to date");
    const ownerEmail = process.env.OWNER_EMAIL?.trim();
    if (ownerEmail) {
      await upsertOwner(sql, ownerEmail);
      console.log(`Owner on the allow-list: ${ownerEmail.toLowerCase()}`);
    } else {
      console.log("OWNER_EMAIL is not set: no owner seeded (set it in .env.local and re-run).");
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  if (args.includes("--env")) {
    const supabase = localSupabaseAuthEnv();
    upsertEnvFile(".env.local", {
      DATABASE_URL: url,
      NEXT_PUBLIC_SUPABASE_URL: supabase.url,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: supabase.publishableKey,
    });
    console.log("Updated .env.local (DATABASE_URL, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)");
  } else {
    console.log(`\nPoint your dev server at it:\nDATABASE_URL=${url}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
