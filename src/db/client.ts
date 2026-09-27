import "server-only";

import { createSql, type Sql } from "./sql";

/**
 * The app's database connection (server only). All app data (allow-list, sync, analytics) goes
 * through this; Supabase JS is used only for Auth.
 *
 * Env:
 * - `DATABASE_URL` (required) — e.g. the Supabase pooler URL in production, or your own dev
 *   database on the local cluster (`npm run db:create-dev -- kx_dev_issue5`).
 * - `DATABASE_PREPARE=false` — required behind Supabase's transaction pooler (port 6543).
 * - `DATABASE_POOL_MAX` — pool size per server instance (default 3).
 */
export function getDb(): Sql {
  const cache = globalThis as typeof globalThis & { __kxSql?: Sql };
  if (!cache.__kxSql) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "DATABASE_URL is not set. Copy .env.example to .env.local (see README) and point it at a database.",
      );
    }
    cache.__kxSql = createSql(url, {
      prepare: process.env.DATABASE_PREPARE?.toLowerCase() !== "false",
      max: positiveInt(process.env.DATABASE_POOL_MAX) ?? 3,
    });
  }
  return cache.__kxSql;
}

function positiveInt(value: string | undefined): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
