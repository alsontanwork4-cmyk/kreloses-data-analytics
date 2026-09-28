import { z } from "zod";

import {
  CLINIC_MIX_BUCKETS,
  DEFAULT_TOP_ITEMS,
  getPendingLineItems,
  getServiceLinesByDoctor,
  getServiceMix,
  getTopItemsByDoctor,
  METRIC_DEFINITIONS,
  MIX_BUCKET_LABELS,
  MIX_COMPARISON_THRESHOLD_POINTS,
  MIX_BUCKETS,
  type ClinicMixBucket,
  type DateRange,
  type DoctorMix,
  type DoctorServiceLines,
  type DoctorTopItems,
  type MixBucket,
  type MixComparison,
  type MixShare,
  type PendingLineItems,
  type ServiceLineFigures,
  type ServiceMix,
} from "@/analytics";
import { formatRinggit, moneyToSen, type Money } from "@/lib/money";

import { defineTool } from "./define";
import { filterInput, filterOutput, resolveFilter, type FilterEcho } from "./filter";
import { money, pendingLineItemsOutput } from "./schemas";
import { definitionExcerpt, describeCoverage, joinAnd, percent, plural } from "./text";

/** At most this many top items per doctor (keeps answers small; the page offers 3, 5 or 10). */
const MAX_TOP_ITEMS = 20;

const period = z.object({ dateFrom: z.string(), dateTo: z.string() });
const source = z.enum(["kreloses", "alias_only"]).describe("alias_only: known only from invoice lines (e.g. a doctor no longer in Kreloses's staff list)");
const share = z.object({
  revenue: money.describe("Revenue in the group (a return can make it negative)"),
  sharePercent: z.number().nullable().describe("Group revenue ÷ the row's revenue × 100, one decimal; null when that revenue is zero or less"),
});
const comparison = share.extend({
  averageSharePercent: z.number().nullable().describe("The same group's share for all doctors together (the clinic average)"),
  differencePoints: z.number().nullable().describe("sharePercent − averageSharePercent, percentage points, one decimal"),
  comparison: z.enum(["above", "below", "in_line"]).nullable().describe("above / below when the difference is at least thresholdPoints either way"),
});
const doctorBuckets = z.enum(MIX_BUCKETS);
const clinicBuckets = z.enum(CLINIC_MIX_BUCKETS);

/** `getServiceMix`, with each row's groups narrowed to the ones asked for (all of them by default). */
type MixAnswer = Omit<ServiceMix, "doctors" | "allDoctors" | "clinic"> & {
  doctors: (Omit<DoctorMix, "groups"> & { groups: Partial<Record<MixBucket, MixComparison>> })[];
  allDoctors: { revenue: Money; groups: Partial<Record<MixBucket, MixShare>> };
  clinic: { revenue: Money; groups: Partial<Record<ClinicMixBucket, MixShare>> };
};

const mixOutput = z.object({
  period,
  thresholdPoints: z.number().describe("Above / below the clinic average from this many percentage points"),
  doctors: z
    .array(z.object({ staffId: z.string(), name: z.string(), source, revenue: money, groups: z.partialRecord(doctorBuckets, comparison) }))
    .describe("Doctors with credited lines (within the doctor filter), highest revenue first; revenue per group (key → figures) compared with all doctors"),
  allDoctors: z
    .object({ revenue: money, groups: z.partialRecord(doctorBuckets, share) })
    .describe("The clinic average: every doctor together in the dates and branches (the doctor filter does not change it)"),
  clinic: z
    .object({ revenue: money, groups: z.partialRecord(clinicBuckets, share) })
    .describe("All revenue in the dates and branches: doctors, other staff, no staff, and no_item / pending buckets (the doctor filter does not change it)"),
}) satisfies z.ZodType<MixAnswer>;

const topItemsOutput = z.object({
  period,
  limit: z.number().int(),
  doctors: z
    .array(
      z.object({
        staffId: z.string(),
        name: z.string(),
        revenue: money.describe("The doctor's whole revenue (what item shares are a share of)"),
        items: z.array(
          z.object({
            itemKey: z.string(),
            name: z.string().describe("As most often written"),
            group: doctorBuckets,
            revenue: money,
            sharePercent: z.number().nullable().describe("Item revenue ÷ the doctor's whole revenue × 100, one decimal"),
            lines: z.number().int(),
            invoices: z.number().int(),
          }),
        ),
      }),
    )
    .describe("Each doctor's top items by revenue (positive only), within the groups asked for"),
}) satisfies z.ZodType<{ period: DateRange; limit: number; doctors: DoctorTopItems[] }>;

const serviceLineFigures = {
  revenue: money,
  surgeryRevenue: money,
  consultRevenue: money,
  surgerySharePercent: z.number().nullable(),
  consultSharePercent: z.number().nullable(),
};
const serviceLinesOutput = z.object({
  period,
  total: z.object(serviceLineFigures).describe("Everything in the filter (with a doctor filter: the selected doctors')"),
  doctors: z.array(z.object({ staffId: z.string(), name: z.string(), source, ...serviceLineFigures })),
}) satisfies z.ZodType<{ period: DateRange; total: ServiceLineFigures; doctors: DoctorServiceLines[] }>;

/**
 * `item_mix`: the Mix page (`getServiceMix`, `getTopItemsByDoctor`, `getServiceLinesByDoctor` — the
 * same calls with the same filter) as data, optionally narrowed to some service-mix groups.
 */
export const itemMixTool = defineTool({
  name: "item_mix",
  title: "Service mix",
  description: [
    `Service mix per doctor: the dashboard's Mix page as data. For a period (clinic days, Asia/Kuala_Lumpur; default month to date) and optionally some branches and doctors (by id or name): each doctor's revenue per service-mix group (${joinAnd(MIX_BUCKETS.map((bucket) => MIX_BUCKET_LABELS[bucket]))}) and its share compared with all doctors together (above / below at ±${MIX_COMPARISON_THRESHOLD_POINTS} points), each doctor's top items, and surgery and consult revenue per doctor. groups narrows the answer to some groups and ranks top items within them. Read-only. Every result states data as of per branch, and carries every definition in full.`,
    "Definitions (the dashboard's own; in full in every result):",
    `- ${definitionExcerpt("revenue", 2)}`,
    `- ${METRIC_DEFINITIONS.serviceMix}`,
    `- ${METRIC_DEFINITIONS.mixComparison}`,
  ].join("\n"),
  input: {
    ...filterInput,
    groups: z
      .array(doctorBuckets)
      .min(1)
      .max(MIX_BUCKETS.length)
      .optional()
      .describe(
        `Only these service-mix groups, by key: ${MIX_BUCKETS.map((bucket) => `${bucket} (${MIX_BUCKET_LABELS[bucket]})`).join(", ")}. Narrows every mix row to them and ranks top items within them. Omit for all.`,
      ),
    topItems: z
      .number()
      .int()
      .min(1)
      .max(MAX_TOP_ITEMS)
      .optional()
      .describe(`Top items per doctor (default ${DEFAULT_TOP_ITEMS}, at most ${MAX_TOP_ITEMS}).`),
  },
  output: {
    covers: filterOutput,
    groupLabels: z.partialRecord(clinicBuckets, z.string()).describe("The groups in this answer: key → name as on the Mix page"),
    mix: mixOutput,
    topItems: topItemsOutput,
    serviceLines: serviceLinesOutput.describe("Surgery and consult revenue per doctor (the item's surgery / consult flags, whatever its group)"),
    pendingLineItems: pendingLineItemsOutput,
  },
  definitions: ["serviceMix", "mixGroup", "mixShare", "mixComparison", "topItems", "surgeryRevenue", "consultRevenue", "revenue", "creditedLine", "doctor", "pendingLineItems"],
  async run(context, input) {
    const { filter, covers } = await resolveFilter(context, input);
    // In the groups' own order, each once.
    const groups = input.groups ? MIX_BUCKETS.filter((bucket) => input.groups!.includes(bucket)) : null;
    const [mix, topItems, serviceLines, pendingLineItems] = await Promise.all([
      getServiceMix(context.sql, filter),
      getTopItemsByDoctor(context.sql, filter, { limit: input.topItems ?? DEFAULT_TOP_ITEMS, groups: groups ?? undefined }),
      getServiceLinesByDoctor(context.sql, filter),
      getPendingLineItems(context.sql, filter),
    ]);
    const answer: MixAnswer = groups
      ? {
          ...mix,
          doctors: mix.doctors.map((doctor) => ({ ...doctor, groups: only(doctor.groups, groups) })),
          allDoctors: { ...mix.allDoctors, groups: only(mix.allDoctors.groups, groups) },
          clinic: { ...mix.clinic, groups: only(mix.clinic.groups, groups) },
        }
      : mix;
    const shown: readonly ClinicMixBucket[] = groups ?? CLINIC_MIX_BUCKETS;
    return {
      data: { covers, groupLabels: only(MIX_BUCKET_LABELS, shown), mix: answer, topItems, serviceLines, pendingLineItems },
      summary: summarise(mix, covers, groups, pendingLineItems),
      freshness: { dateFrom: filter.dateFrom, dateTo: filter.dateTo, branchIds: filter.branchIds },
    };
  },
});

/** The record's entries for `keys` only (a projection: no figure is changed). */
function only<Key extends string, Value>(record: Record<Key, Value>, keys: readonly Key[]): Partial<Record<Key, Value>> {
  return Object.fromEntries(keys.filter((key) => key in record).map((key) => [key, record[key]])) as Partial<Record<Key, Value>>;
}

function summarise(mix: ServiceMix, covers: FilterEcho, groups: MixBucket[] | null, pending: PendingLineItems): string {
  const clinic = mix.clinic.groups;
  const describe = (bucket: ClinicMixBucket) => `${MIX_BUCKET_LABELS[bucket]} ${formatRinggit(clinic[bucket].revenue)} (${percent(clinic[bucket].sharePercent)})`;
  // Which of the clinic's groups to name: the ones asked for, else the three largest.
  const named = groups
    ? groups.map(describe)
    : CLINIC_MIX_BUCKETS.filter((bucket) => moneyToSen(clinic[bucket].revenue) > 0)
        .sort((a, b) => moneyToSen(clinic[b].revenue) - moneyToSen(clinic[a].revenue))
        .slice(0, 3)
        .map(describe);
  const unmapped = clinic.unmapped.revenue;
  return [
    `Service mix for ${describeCoverage(covers)}${groups ? `, groups ${joinAnd(groups.map((bucket) => MIX_BUCKET_LABELS[bucket]))}` : ""}: ${plural(mix.doctors.length, "doctor")} with revenue.`,
    `Whole clinic ${formatRinggit(mix.clinic.revenue)}${named.length === 0 ? "" : `; ${groups ? "" : "largest groups "}${named.join(", ")}`}.`,
    (!groups || groups.includes("unmapped")) && moneyToSen(unmapped) !== 0
      ? `${formatRinggit(unmapped)} is on items no rule recognises (Unmapped); the owner can assign them to groups in Settings → Items.`
      : "",
    pending.invoices > 0
      ? `${plural(pending.invoices, "sale")} (${formatRinggit(pending.revenue)}) ${pending.invoices === 1 ? "has" : "have"} line items not synced yet: ${pending.invoices === 1 ? "its" : "their"} revenue is ` +
        // With groups, the "not synced yet" bucket is not in the answer: say what it means rather than point at it.
        (groups
          ? `counted in the whole clinic's ${formatRinggit(mix.clinic.revenue)} but not yet in any service group or doctor's mix, so the group figures leave ${pending.invoices === 1 ? "it" : "them"} out.`
          : `in the whole clinic's "${MIX_BUCKET_LABELS.pending}" bucket and in no doctor's mix yet.`)
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}
