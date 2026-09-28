/**
 * Analytics Service — the single source of every metric. Dashboard pages and (later) MCP tools are
 * thin wrappers over these functions; never compute a metric anywhere else.
 *
 * Every query takes a `Sql` connection (`getDb()` in the app, a throwaway database in tests) and the
 * shared `GlobalFilter` (`@/filters`). Money comes back as exact decimal strings (`"1234.50"`, see
 * `@/lib/money`), dates as clinic-local `'YYYY-MM-DD'`, instants as `Date`. What each metric means
 * is in `METRIC_DEFINITIONS` (and CONTEXT.md); what counts as revenue is decided in one place,
 * `revenueFacts` (./facts.ts).
 */
export { getOverviewKpis, type BranchKpis, type Kpi, type KpiChange, type KpiSet, type OverviewKpis } from "./overview";
export { getDataFreshness, type BranchFreshness } from "./freshness";
export { comparisonPeriods, type DateRange } from "./periods";
export { METRIC_DEFINITIONS, type MetricName } from "./definitions";
export { branchScope, revenueFacts, type BranchScope } from "./facts";
