import { DEFAULT_TIME_BUDGET_MS, NIGHTLY_WINDOW_DAYS, runSync, type SyncDeps, type SyncResult } from "./engine";

/**
 * The Scheduler's nightly job (#6): one `nightly` sync per connection — every connection, failed
 * ones included, so a password the owner fixed recovers on its own (a login that still fails stays
 * failed, with the new error) — one after another, each under its own lease and time budget, all
 * within one function invocation (Vercel Cron → `GET /api/cron/nightly`, `./cron.ts`).
 *
 * Each run re-reads the Sale List for the last `windowDays` days (cancelled sales included), reads
 * the invoice pages of new and changed invoices only, sweeps older invoices left without current
 * line items, and carries on from a run that stopped part-way a few hours ago at most (`resume`).
 *
 * The invocation's budget (`totalBudgetMs`, default 250 s: Vercel Hobby allows 300 s) is shared:
 * each connection gets the time left divided by the connections still to go (capped at the
 * per-run budget, `SYNC_TIME_BUDGET_SECONDS`), so an early one finishing quickly leaves more for
 * the rest and none is starved.
 */
export const NIGHTLY_TOTAL_BUDGET_MS = 250_000;
/** A connection is skipped (not started) with less time than this left for it. */
export const MIN_NIGHTLY_RUN_BUDGET_MS = 20_000;

export interface NightlyOptions {
  /** Days back from today the window starts. Default 45 (`SYNC_NIGHTLY_WINDOW_DAYS`). */
  windowDays?: number;
  /** The whole invocation's budget. Default 250 s. */
  totalBudgetMs?: number;
  /** One connection's budget at most. Default 200 s (`SYNC_TIME_BUDGET_SECONDS`). */
  maxRunBudgetMs?: number;
  /** Sale List page size (tests). */
  pageSize?: number;
}

export type NightlyOutcome =
  | SyncResult
  /** Not started: too little of the invocation's budget was left for it. */
  | { status: "skipped" }
  /** The engine itself threw (e.g. the database was unreachable); the other connections still ran. */
  | { status: "error"; message: string };

export interface NightlyConnectionResult {
  connectionId: string;
  connectionLabel: string;
  timeBudgetMs: number;
  outcome: NightlyOutcome;
}

export async function runNightlySync(deps: SyncDeps, options: NightlyOptions = {}): Promise<NightlyConnectionResult[]> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now().getTime();
  const totalBudgetMs = options.totalBudgetMs ?? NIGHTLY_TOTAL_BUDGET_MS;
  const maxRunBudgetMs = options.maxRunBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const connections = await deps.sql<{ id: string; label: string }[]>`select id::text as id, label from connections order by id`;

  const results: NightlyConnectionResult[] = [];
  for (const [index, connection] of connections.entries()) {
    const left = totalBudgetMs - (now().getTime() - startedAt);
    // An equal share of what is left (so an early connection finishing fast leaves more for the
    // rest), but never less than a useful minimum while that much is left.
    const share = Math.max(MIN_NIGHTLY_RUN_BUDGET_MS, Math.floor(left / (connections.length - index)));
    const timeBudgetMs = Math.min(maxRunBudgetMs, share, left);
    let outcome: NightlyOutcome;
    if (timeBudgetMs < MIN_NIGHTLY_RUN_BUDGET_MS) {
      outcome = { status: "skipped" };
    } else {
      try {
        outcome = await runSync(deps, connection.id, "nightly", {
          windowDays: options.windowDays,
          timeBudgetMs,
          resume: true,
          ...(options.pageSize ? { pageSize: options.pageSize } : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? `${error.name}: ${error.message}` : typeof error;
        console.error(`[nightly] sync of connection ${connection.id} threw: ${message}`);
        outcome = { status: "error", message };
      }
    }
    results.push({ connectionId: connection.id, connectionLabel: connection.label, timeBudgetMs, outcome });
  }
  return results;
}

/**
 * `SYNC_NIGHTLY_WINDOW_DAYS` (1–366), default 45: how far back the nightly sync re-reads the Sale
 * List to notice edits, cancellations and refunds of older sales.
 */
export function nightlyWindowDays(env: Record<string, string | undefined> = process.env): number {
  const days = Number(env.SYNC_NIGHTLY_WINDOW_DAYS);
  if (!env.SYNC_NIGHTLY_WINDOW_DAYS || !Number.isFinite(days)) return NIGHTLY_WINDOW_DAYS;
  return Math.min(366, Math.max(1, Math.round(days)));
}
