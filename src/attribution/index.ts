/**
 * Attribution & Rules — PURE functions (no database, no I/O): how an invoice's revenue is credited
 * to the staff named on its lines (`./credit.ts`), and how short line names are matched to full
 * staff names and given a default kind (`./staff-names.ts`). The Sync Engine stores their results;
 * the Analytics Service reads them. Safe to import anywhere.
 *
 * #9 (item groups) adds the item → service-mix group / surgery / consult / vaccine / dental rules
 * here as another pure module; see README "Credited lines".
 */
export {
  allocateLargestRemainder,
  creditInvoice,
  DISCOUNT_ITEM_TYPE,
  grossSen,
  invoiceRefundSen,
  invoiceRevenueBaseSen,
  type AttributionInvoice,
  type AttributionLine,
  type CreditedLine,
} from "./credit";
export {
  aliasKey,
  defaultStaffKind,
  matchStaffName,
  nameKey,
  suggestStaff,
  type StaffCandidate,
  type StaffKind,
  type StaffMatch,
} from "./staff-names";
