/**
 * Plain-language definitions of the surgery-department, vaccine and dental metrics (#15:
 * `getSurgeryDepartment`, `getTopProcedures`, ./surgery.ts; `getVaccineDentalRevenue`,
 * ./vaccines-dental.ts), part of `METRIC_DEFINITIONS` (./definitions.ts). Keep them in step with the
 * SQL and with CONTEXT.md.
 */
export const SURGERY_DEFINITIONS = {
  surgeryCase:
    "Surgery case: an active sale (invoice) whose line items are synced, on a clinic day in the period, with at least one sold surgery line (an item with the surgery flag, quantity above zero). A returned surgery line never makes a case; cancelled sales and sales whose line items are not synced yet are not cases (pages say how many sales are not synced yet). A case belongs to the sale's branch and counts for EVERY doctor with a sold surgery line on it, so a case shared by two doctors counts once for each of them and once in the totals. With a doctor filter, the totals count only the cases of the selected doctors.",
  surgeryOperation:
    "Operation: a surgery case with at least one sold line of an actual operation (an item with the procedure flag, e.g. a spay or a mass removal) — whoever it is credited to, so a case where one doctor operates and another gives the anaesthetic is an operation for both.",
  sedationOnlyCase:
    "Sedation only: a surgery case whose surgery lines are all sedation / anaesthesia or other surgical charges without an operation (surgery flag, no procedure flag). Cases = operations + sedation only.",
  surgeryFee:
    "Surgery fee: the revenue (see Revenue: after discounts and refunds) of a case's surgery lines — operations, sedation / anaesthesia and related surgical charges. For a doctor, only the surgery lines credited to them; in the totals with a doctor filter, only the selected doctors' lines. The average fee is the fees divided by the cases, rounded to the sen; the fee share is the fees divided by the whole-visit value, as a percentage to one decimal. Surgery fees are not the same as surgery revenue (Mix, Overview, Trends): surgery revenue counts every surgery line in the period, so a surgery item returned on a later sale lowers surgery revenue, but never the fee of the case it was sold on (that return is not on the case).",
  wholeVisitValue:
    "Whole-visit value: the revenue of the WHOLE sale a surgery case is on — every line, whoever it is credited to (the surgery plus medicines, diagnostics, hospitalisation and the rest). For a doctor, the whole-visit value of each of their cases (a case shared by two doctors counts in full for each). The average is divided by the cases, rounded to the sen.",
  topProcedures:
    "Top procedures: operation items (procedure flag; spelling variants of a name count as one item) on surgery cases, by fees (the revenue of that item's lines on those cases), with the number of cases it was sold on and the average fee per case (fees ÷ cases, rounded to the sen). Returned lines that are not on a case, cancelled sales and sales whose line items are not synced yet are left out. Overall = every operation line in the filter (with a doctor filter, the selected doctors' lines); per doctor = the lines credited to that doctor. Sedation / anaesthesia lines are not procedures.",
  postOpFollowUp:
    "Post-op follow-up within 14 days: of the surgery cases in the period, the share whose customer had another service visit (see Service visit: any doctor, any branch — also when a branch filter is set) 1 to 14 days after the case's day. A second visit on the same day is not a follow-up, and neither is a cancelled sale or a sale whose line items are not synced yet. A case only counts once its 14 days have passed in the synced data (case day + 14 on or before the latest synced day at any branch); more recent cases are \"not yet mature\", left out of the rate and counted separately. Cases without a customer (walk-ins) cannot be followed up: they are left out of the rate and counted separately too. The rate is followed up ÷ mature cases, as a percentage to one decimal.",
  vaccineRevenue:
    "Vaccine revenue: the revenue of credited lines whose item is a vaccination (the vaccine flag of the item's group rules or assignment), per doctor and in total for the filter; its share is vaccine revenue ÷ the doctor's (or the total) revenue, as a percentage to one decimal. Sales whose line items are not synced yet are in the total revenue but not in vaccine revenue.",
  dentalScalingRevenue:
    "Dental-scaling revenue: the revenue of credited lines whose item is dental scaling (the dental-scaling flag of the item's group rules or assignment; a scaling done under anaesthesia and sold as one item is dental scaling, not surgery), per doctor and in total for the filter; its share is dental-scaling revenue ÷ the doctor's (or the total) revenue, as a percentage to one decimal. Sales whose line items are not synced yet are in the total revenue but not in dental-scaling revenue.",
} as const;
