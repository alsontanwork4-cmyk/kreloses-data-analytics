/**
 * Attribution & Rules — PURE functions (no database, no I/O): how an invoice's revenue is credited
 * to the staff named on its lines (`./credit.ts`), and how short line names are matched to full
 * staff names and given a default kind (`./staff-names.ts`). The Sync Engine stores their results;
 * the Analytics Service reads them. Safe to import anywhere.
 *
 * Item groups (#9, `./item-groups.ts`): an item name → its service-mix group and surgery /
 * consult / vaccine / dental-scaling / procedure flags, from the owner's rules and assignments.
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
export {
  checkItemFlags,
  checkItemRule,
  classifyItem,
  createItemClassifier,
  isMixGroup,
  itemKey,
  MAX_PATTERN_LENGTH,
  MAX_RULE_PRIORITY,
  MIX_GROUP_LABELS,
  MIX_GROUPS,
  patternMatches,
  type ItemClassification,
  type ItemFlags,
  type ItemMatch,
  type ItemMatchType,
  type ItemRule,
  type ItemRuleCheck,
  type ItemRuleInput,
  type MixGroup,
} from "./item-groups";
