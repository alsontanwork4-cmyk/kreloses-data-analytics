import "server-only";

import { sqlOptionsFromEnv } from "./env";
import { createSql, type Sql } from "./sql";

/**
 * The app's database connection (server only). All app data (allow-list, sync, analytics) goes
 * through this; Supabase JS is used only for Auth.
 *
 * Env (see `sqlOptionsFromEnv`): `DATABASE_URL` (required); `DATABASE_PREPARE` (defaults to false
 * on Supabase's transaction pooler, port 6543); `DATABASE_POOL_MAX` (default 3).
 *
 * Not wrapped in `attachDatabasePool` (@vercel/functions): it does not support postgres.js. Idle
 * connections are closed by postgres.js's own `idle_timeout` instead.
 */
export function getDb(): Sql {
  const cache = globalThis as typeof globalThis & { __kxSql?: Sql };
  if (!cache.__kxSql) {
    const { url, prepare, max } = sqlOptionsFromEnv(process.env);
    cache.__kxSql = createSql(url, { prepare, max });
  }
  return cache.__kxSql;
}
