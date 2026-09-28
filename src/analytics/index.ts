/**
 * Analytics Service — the single source of every metric. Dashboard pages and (later) MCP tools are
 * thin wrappers over these functions; never compute a metric anywhere else.
 *
 * Every query takes a `Sql` connection (`getDb()` in the app, a throwaway database in tests) and the
 * shared `GlobalFilter` (`@/filters`). Money comes back as exact decimal strings (`"1234.50"`, see
 * `@/lib/money`), dates as clinic-local `'YYYY-MM-DD'`, instants as `Date`. What each metric means
 * is in `METRIC_DEFINITIONS` (and CONTEXT.md); what counts as revenue — and who it is credited
 * to — is decided in one place, `revenueFacts` (./facts.ts).
 */
export { getOverviewKpis, type BranchKpis, type Kpi, type KpiChange, type KpiSet, type OverviewKpis } from "./overview";
export {
  getDoctorRanking,
  getStaffAliasRevenue,
  listDoctors,
  type BranchFigures,
  type DoctorRanking,
  type DoctorRow,
  type StaffFigures,
  type StaffGroup,
  type StaffRow,
} from "./doctors";
export { getPendingLineItems, type PendingLineItems } from "./pending";
export {
  DISCOUNT_TYPE_LABELS,
  DISCOUNTED_INVOICE_THRESHOLD,
  getDiscountTypes,
  getDoctorDiscounts,
  type DiscountAppliedTo,
  type DiscountFigures,
  type DiscountTypeRow,
  type DiscountTypes,
  type DoctorDiscounts,
  type StaffDiscountGroup,
  type StaffDiscountRow,
} from "./discounts";
export {
  availableTrendMeasures,
  getMonthlyTrends,
  getYearOnYear,
  ITEM_GROUP_MEASURES_AVAILABLE,
  TREND_MEASURES,
  trendMonths,
  type DoctorTrend,
  type MonthlyTrends,
  type TrendFigures,
  type TrendMeasure,
  type TrendMeasureInfo,
  type TrendMonth,
  type TrendPoint,
  type YearColumn,
  type YearFigures,
  type YearOnYear,
  type YearOnYearCell,
  type YearOnYearRow,
} from "./trends";
export { getDoctorDetail, type DoctorDetail } from "./doctor-detail";
export { getDataFreshness, type BranchFreshness } from "./freshness";
export { comparisonPeriods, type DateRange } from "./periods";
export { METRIC_DEFINITIONS, type MetricName } from "./definitions";
export {
  SALES_SEARCH_DEFAULT_PAGE_SIZE,
  SALES_SEARCH_MAX_PAGE_SIZE,
  searchSales,
  type SaleCredit,
  type SaleSearchRow,
  type SalesSearchCriteria,
  type SalesSearchResult,
  type SalesSearchSort,
} from "./sales-search";
export { getConnectionSyncStatus, type ConnectionSyncStatus, type LastSyncRun, type SyncRunOutcome } from "./sync-status";
export { listBranches, listDoctorNames } from "./lookups";
export { branchScope, factsScope, revenueFacts, staffScope, type BranchScope, type FactsScope, type StaffScope } from "./facts";
