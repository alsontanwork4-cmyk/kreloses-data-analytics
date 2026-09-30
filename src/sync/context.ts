import "server-only";

import { connectionsContext } from "@/connections/context";
import { loginAsConnection } from "@/connections/service";
import { clinicNow } from "@/lib/clinic-clock";

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
 * The history backfill's Sync Engine dependencies (#8): like `syncDeps()`, but its Kreloses
 * sessions pause `requestDelayMs` (`BACKFILL_REQUEST_DELAY_SECONDS`, default 2 s) after each answer
 * instead of the nightly's 1 s, and the clock is `clinicNow()` (the real time in production; the e2e
 * suite freezes it with `CLINIC_NOW`, so its night window and "tonight" are deterministic).
 */
export function backfillSyncDeps(requestDelayMs: number): SyncDeps {
  const context = connectionsContext();
  const gentle = { ...context, reader: { ...context.reader, requestDelayMs } };
  return { sql: context.sql, login: (id) => loginAsConnection(gentle, id), now: () => clinicNow() };
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
