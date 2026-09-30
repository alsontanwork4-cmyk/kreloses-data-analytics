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
  DAILY_GROUP_LABELS,
  dailyComparisonDays,
  dailyDayProblem,
  EARLIEST_DAILY_DAY,
  defaultDailyDay,
  getDailySales,
  resolveDailyDay,
  type DailyBranchRow,
  type DailyDoctorRow,
  type DailyFigures,
  type DailyGroup,
  type DailyGroupRow,
  type DailyMetric,
  type DailySales,
} from "./daily";
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
  listTrendDoctors,
  TREND_MEASURES,
  trendMonths,
  type TrendDoctor,
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
export {
  getConsultAttachRates,
  getItemsPerInvoiceTrend,
  PRODUCT_ITEM_TYPE,
  type AttachFigures,
  type AttachRate,
  type AttachRateSet,
  type ConsultAttachRates,
  type DoctorAttachRates,
  type DoctorItemsPerInvoiceTrend,
  type ItemsPerInvoiceFigures,
  type ItemsPerInvoicePoint,
  type ItemsPerInvoiceTrend,
} from "./upsell";
export { UPSELL_METRICS } from "./upsell-definitions";
export { getRetention, type DoctorRetention, type NewVsReturning, type NinetyDayReturns, type Retention, type RetentionFigures, type YearCohort } from "./retention";
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
export {
  CLINIC_MIX_BUCKETS,
  DEFAULT_TOP_ITEMS,
  getItemRevenue,
  getServiceMix,
  getTopItemsByDoctor,
  MAX_TOP_ITEMS,
  MIX_BUCKET_LABELS,
  MIX_BUCKETS,
  MIX_COMPARISON_THRESHOLD_POINTS,
  type ClinicMixBucket,
  type DoctorMix,
  type DoctorTopItems,
  type MixBucket,
  type MixComparison,
  type MixComparisonResult,
  type MixShare,
  type ServiceMix,
  type TopItem,
} from "./mix";
export {
  getMonthlyServiceLineRevenue,
  getRevenuePerWorkingDay,
  getServiceLineKpis,
  getServiceLinesByDoctor,
  SERVICE_LINES,
  serviceLineCondition,
  type DoctorServiceLines,
  type ServiceLine,
  type ServiceLineFigures,
  type ServiceLineKpis,
  type ServiceLineKpiSet,
  type WorkingDayFigures,
} from "./service-lines";
