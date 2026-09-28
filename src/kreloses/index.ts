/**
 * Kreloses Reader — the ONLY code that knows Kreloses exists. Everything else in the app talks
 * to Kreloses through these functions and gets clean domain types or one of the typed errors.
 *
 *   const session = await login({ email, password }, readerOptionsFromEnv(process.env));
 *   const locations = await listLocations(session);
 *   const { invoices, hasMore } = await listInvoices(session, { page: 1, dateRange, includeCancelled: true });
 *
 * See `README.md` ("Kreloses Reader") for the login flow, the fixtures and the live smoke test.
 */
export { login, type KrelosesCredentials } from "./login";
export { listLocations, fetchFilterTemplate, SALE_LIST_REPORT, type KrelosesLocation } from "./locations";
export {
  listInvoices,
  SALE_LIST_PAGE_SIZE,
  type InvoiceDateRange,
  type InvoiceListQuery,
  type InvoicePage,
  type KrelosesInvoice,
  type PageSpan,
  type SaleStatus,
} from "./sale-list";
export type { KrelosesSession, HopEvent } from "./session";
export {
  readerOptionsFromEnv,
  KRELOSES_SEA_URL,
  KRELOSES_WWW_URL,
  DEFAULT_REQUEST_DELAY_MS,
  type ReaderOptions,
} from "./config";
export type { Transport, TransportRequest } from "./transport";
export {
  AuthFailed,
  KrelosesError,
  LayoutChanged,
  RateLimited,
  Transient,
  isKrelosesError,
  type AuthFailedReason,
  type KrelosesErrorCode,
  type UnexpectedLoginStep,
} from "./errors";
