import type { Sql } from "@/db/sql";
import { clinicToday, type IsoDate } from "@/filters";

import { backfillMonths, backfillNight, completedMonths, type BackfillMonth } from "./backfill";
import { BACKFILL_FROM, estimatedNights, nightWindowAt, type BackfillConfig } from "./backfill-config";
import type { BackfillStatus } from "./backfill-store";
import { MAX_PAGE_MISSING_ATTEMPTS } from "./lines";

/**
 * How far each connection's history backfill has got (#8, spec story 12: "invoices done / total, so
 * that I know when history is complete"). Shown on Sync status (and in short on Connections).
 */
export interface BackfillProgress {
  connectionId: string;
  connectionLabel: string;
  /** The connection's login: a failing login pauses the backfill until it works again. */
  loginStatus: "untested" | "ok" | "failed";
  /** `not_started`: no backfill yet (its login never worked, or it was never asked for). */
  status: BackfillStatus | "not_started";
  dateFrom: IsoDate;
  /** Its last day: fixed by its first chunk; until then, today (what it would load). */
  dateTo: IsoDate;
  /** False until its first chunk has run (it then fixes `dateTo`). */
  started: boolean;
  requestedAt: Date | null;
  completedAt: Date | null;
  pausedAt: Date | null;
  months: {
    /** Months read completely by some sync (the backfill's own, the nightly's, a Sync now). */
    done: number;
    total: number;
    /** The month the backfill is on (the newest not done), e.g. `"2025-03"`; null when all are done. */
    current: string | null;
  };
  invoices: {
    /**
     * Invoices in the backfill's dates at this login's branches that need nothing more: cancelled,
     * line items read, or invoice page permanently missing.
     */
    done: number;
    /**
     * Invoices in the backfill's dates (cancelled included): per month, what a complete read stored,
     * else Kreloses's Sale List TotalCount once the backfill has listed the month; months not listed
     * yet are estimated at the average of the months known. Null until one month is known.
     */
    total: number | null;
    /** True while some months are not listed yet (`total` is an estimate). */
    estimated: boolean;
    /** Whole percent of `total` done (100 only once complete); null while `total` is unknown. */
    percent: number | null;
  };
  /** Invoice pages (line items) the backfill's runs have read. */
  lineItemsRead: number;
  /** Kreloses requests the backfill sent in the night window now in progress, or the last one. */
  night: { start: Date; end: Date; inWindow: boolean; nextStart: Date; requestsUsed: number; requestBudget: number };
  /** Nights still needed at the per-night request budget (invoices to go ÷ budget, rounded up); null while unknown. */
  estimatedNightsLeft: number | null;
  /** When its latest chunk ran a month (a backfill run started); null if none has. */
  lastRunAt: Date | null;
  /** Its latest backfill run's error, if that run failed. */
  lastError: { message: string; at: Date } | null;
}

interface StateRow {
  connectionId: string;
  connectionLabel: string;
  loginStatus: BackfillProgress["loginStatus"];
  status: BackfillStatus | null;
  dateFrom: IsoDate | null;
  dateTo: IsoDate | null;
  requestedAt: Date | null;
  startedAt: Date | null;
  pausedAt: Date | null;
  completedAt: Date | null;
}

/** Every connection's backfill progress, by connection name. */
export async function getBackfillProgress(sql: Sql, options: { now: Date; config: BackfillConfig }): Promise<BackfillProgress[]> {
  const states = await sql<StateRow[]>`
    select c.id::text as connection_id, c.label as connection_label, c.status as login_status,
      b.status, b.date_from, b.date_to, b.requested_at, b.started_at, b.paused_at, b.completed_at
    from connections c left join connection_backfills b on b.connection_id = c.id
    order by lower(c.label), c.id
  `;
  return Promise.all(states.map((state) => progressOf(sql, state, options)));
}

async function progressOf(sql: Sql, state: StateRow, { now, config }: { now: Date; config: BackfillConfig }): Promise<BackfillProgress> {
  const dateFrom = state.dateFrom ?? BACKFILL_FROM;
  const dateTo = state.dateTo ?? clinicToday(now);
  const months = backfillMonths(dateFrom, dateTo);
  const window = nightWindowAt(now, config.nightWindow);
  const [done, perMonth, listed, runs, tonight] = await Promise.all([
    completedMonths(sql, state.connectionId, months),
    invoicesPerMonth(sql, state.connectionId, dateFrom, dateTo),
    listedTotals(sql, state.connectionId),
    backfillRuns(sql, state.connectionId),
    backfillNight(sql, state.connectionId, window),
  ]);
  const invoices = invoiceTotals(months, done, perMonth, listed);
  const complete = state.status === "complete";
  const percent = complete ? 100 : invoices.total === null ? null : invoices.total === 0 ? 0 : Math.min(99, Math.floor((invoices.done / invoices.total) * 100));
  return {
    connectionId: state.connectionId,
    connectionLabel: state.connectionLabel,
    loginStatus: state.loginStatus,
    status: state.status ?? "not_started",
    dateFrom,
    dateTo,
    started: state.startedAt !== null,
    requestedAt: state.requestedAt,
    completedAt: state.completedAt,
    pausedAt: state.pausedAt,
    months: { done: months.filter((month) => done.has(month.month)).length, total: months.length, current: complete ? null : (months.find((month) => !done.has(month.month))?.month ?? null) },
    invoices: { ...invoices, percent },
    lineItemsRead: runs.lineItemsRead,
    night: { ...window, requestsUsed: tonight.requestsUsed, requestBudget: config.maxRequestsPerNight },
    estimatedNightsLeft: complete ? 0 : invoices.total === null ? null : estimatedNights(Math.max(1, invoices.total - invoices.done), config.maxRequestsPerNight),
    lastRunAt: runs.lastRunAt,
    lastError: runs.lastError,
  };
}

/** Per month: `stored` invoices and how many of them need nothing more (`done`). */
async function invoicesPerMonth(sql: Sql, connectionId: string, from: IsoDate, to: IsoDate): Promise<Map<string, { stored: number; done: number }>> {
  const rows = await sql<{ month: string; stored: number; done: number }[]>`
    select to_char(i.sale_date, 'YYYY-MM') as month, count(*)::int as stored,
      count(*) filter (where i.status = 'cancelled' or i.lines_current or i.detail_missing_count >= ${MAX_PAGE_MISSING_ATTEMPTS})::int as done
    from invoices i
    where i.sale_date between ${from} and ${to}
      and i.branch_id in (
        -- This login's branches: those it can see (latest login), and those it synced last.
        select b.id from branches b join connections c on c.id = ${connectionId}
        where b.connection_id = c.id
          or b.kreloses_location_id in (select location ->> 'id' from jsonb_array_elements(c.visible_locations) as location)
      )
    group by 1
  `;
  return new Map(rows.map((row) => [row.month, { stored: row.stored, done: row.done }]));
}

/** Kreloses's TotalCount per month (`"YYYY-MM"`) from the latest backfill run of that month that listed a page. */
async function listedTotals(sql: Sql, connectionId: string): Promise<Map<string, number>> {
  const rows = await sql<{ month: string; total: number }[]>`
    select distinct on (r.date_from, r.date_to) to_char(r.date_from, 'YYYY-MM') as month, (r.counts ->> 'saleListTotal')::int as total
    from sync_runs r
    where r.connection_id = ${connectionId} and r.mode = 'backfill' and r.counts ? 'saleListTotal'
    order by r.date_from, r.date_to, r.started_at desc, r.id desc
  `;
  return new Map(rows.map((row) => [row.month, row.total]));
}

async function backfillRuns(sql: Sql, connectionId: string): Promise<{ lineItemsRead: number; lastRunAt: Date | null; lastError: { message: string; at: Date } | null }> {
  const [row] = await sql<{ lineItemsRead: number; lastRunAt: Date | null; lastStatus: string | null; lastErrorMessage: string | null; lastFinishedAt: Date | null }[]>`
    select
      (select coalesce(sum(coalesce((r.counts ->> 'lineItemsRead')::int, 0)), 0)::int from sync_runs r
        where r.connection_id = ${connectionId} and r.mode = 'backfill') as line_items_read,
      l.started_at as last_run_at, l.status as last_status, l.error as last_error_message, l.finished_at as last_finished_at
    from (select 1) as one
    left join lateral (
      select started_at, status, error, finished_at from sync_runs
      where connection_id = ${connectionId} and mode = 'backfill'
      order by started_at desc, id desc
      limit 1
    ) l on true
  `;
  return {
    lineItemsRead: row!.lineItemsRead,
    lastRunAt: row!.lastRunAt,
    lastError: row!.lastStatus === "failed" && row!.lastErrorMessage ? { message: row!.lastErrorMessage, at: row!.lastFinishedAt ?? row!.lastRunAt! } : null,
  };
}

/** Invoices done / total over the backfill's months (see `BackfillProgress.invoices`). */
function invoiceTotals(
  months: readonly BackfillMonth[],
  done: ReadonlySet<string>,
  perMonth: ReadonlyMap<string, { stored: number; done: number }>,
  listed: ReadonlyMap<string, number>,
): { done: number; total: number | null; estimated: boolean } {
  let doneInvoices = 0;
  let known = 0;
  let knownMonths = 0;
  let unknownMonths = 0;
  for (const month of months) {
    const stored = perMonth.get(month.month) ?? { stored: 0, done: 0 };
    doneInvoices += stored.done;
    if (done.has(month.month)) {
      known += stored.stored;
      knownMonths += 1;
    } else if (listed.has(month.month)) {
      known += Math.max(listed.get(month.month)!, stored.stored);
      knownMonths += 1;
    } else {
      unknownMonths += 1;
    }
  }
  if (knownMonths === 0) return { done: doneInvoices, total: null, estimated: true };
  const total = known + Math.round((known / knownMonths) * unknownMonths);
  return { done: doneInvoices, total: Math.max(total, doneInvoices), estimated: unknownMonths > 0 };
}
