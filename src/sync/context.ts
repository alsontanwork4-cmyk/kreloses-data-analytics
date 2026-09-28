import "server-only";

import { connectionsContext } from "@/connections/context";
import { loginAsConnection } from "@/connections/service";

import { DEFAULT_TIME_BUDGET_MS, type SyncDeps } from "./engine";

/**
 * The running app's Sync Engine dependencies: the app database, logins through the connections
 * service (decrypting the stored password), the real Kreloses Reader (or the e2e fake outside
 * production) and the real clock.
 */
export function syncDeps(): SyncDeps {
  const context = connectionsContext();
  return { sql: context.sql, login: (id) => loginAsConnection(context, id) };
}

/**
 * The time budget of one sync invocation: `SYNC_TIME_BUDGET_SECONDS` (10–280), default 200 s. Keep
 * it well under the function's `maxDuration` (300 s on the pages that start a sync).
 */
export function syncTimeBudgetMs(env: Record<string, string | undefined> = process.env): number {
  const seconds = Number(env.SYNC_TIME_BUDGET_SECONDS);
  if (!env.SYNC_TIME_BUDGET_SECONDS || !Number.isFinite(seconds)) return DEFAULT_TIME_BUDGET_MS;
  return Math.min(280, Math.max(10, Math.round(seconds))) * 1000;
}
