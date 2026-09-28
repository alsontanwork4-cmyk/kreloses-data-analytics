/**
 * Sync Engine: Kreloses Sale List → invoices, branches, customers, with a `sync_runs` row per run.
 * See `./engine.ts` for how a run works and where #5/#6/#8 plug in. Server code only
 * (`./context.ts`, `syncDeps()`, is the app's wiring).
 */
export { runSync, currentClinicMonth, DEFAULT_TIME_BUDGET_MS, type SyncDeps, type SyncOptions, type SyncReader, type SyncResult } from "./engine";
export {
  listSyncRuns,
  type SyncCheckpoint,
  type SyncCounts,
  type SyncErrorCode,
  type SyncMode,
  type SyncRun,
  type SyncRunStatus,
} from "./runs";
export { describeSyncFailure, type SyncFailure } from "./messages";
