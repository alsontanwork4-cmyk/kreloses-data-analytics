import { METRIC_DEFINITIONS, type MetricName } from "@/analytics";
import { formatDateRange } from "@/filters";

import type { FilterEcho } from "./filter";

/** Wording shared by the tools' descriptions and one-line summaries. */

/** "1 Sep 2026 – 30 Sep 2026, all branches" / "…, Branch North, doctor Dr Alpha Anderson". */
export function describeCoverage(covers: FilterEcho): string {
  return `${formatDateRange(covers.dateFrom, covers.dateTo)}, ${describeScope(covers)}`;
}

/** The branches and doctors part of `describeCoverage`: "all branches" / "Branch North, doctor Dr Alpha Anderson". */
export function describeScope(covers: Pick<FilterEcho, "branches" | "doctors">): string {
  const branches = covers.branches === "all" ? "all branches" : covers.branches.map((branch) => branch.name).join(", ");
  const doctors =
    covers.doctors === "all" ? "" : `, ${covers.doctors.length === 1 ? "doctor" : "doctors"} ${covers.doctors.map((doctor) => doctor.name).join(", ")}`;
  return `${branches}${doctors}`;
}

/** "1 sale", "3 sales". */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** "A", "A and B", "A, B and C". */
export function joinAnd(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** A percentage the Analytics Service worked out (one decimal) for a sentence: "26.1%"; null → "n/a". */
export function percent(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(1)}%`;
}

/** A sentence ends at a full stop followed by a capital letter ("e.g. a", "RM 0.05" and "(e.g. \"Dr Ong\")" do not end one). */
const SENTENCE_END = /(?<=\.)\s+(?=[A-Z])/;

/**
 * The first `sentences` sentences of a metric's definition, VERBATIM (generated from
 * `METRIC_DEFINITIONS`, never retyped), followed by " …" when there is more. For tool descriptions:
 * Claude Code cuts them after 2,048 characters, so a long definition is quoted by its opening
 * sentences there, and every result carries it in full (`definitions`).
 */
export function definitionExcerpt(name: MetricName, sentences: number): string {
  const definition: string = METRIC_DEFINITIONS[name];
  const parts = definition.split(SENTENCE_END);
  return parts.length <= sentences ? definition : `${parts.slice(0, sentences).join(" ")} …`;
}
