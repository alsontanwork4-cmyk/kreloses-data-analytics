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

/** A possible sentence end: a full stop, then whitespace, then a capital letter ("RM 0.05" and "e.g. a" are not candidates). */
const CANDIDATE_END = /\.(?=\s+[A-Z])/g;

/** Words written with a full stop that never end a sentence here (compared as written, without the stop). */
const ABBREVIATIONS = new Set(["e.g", "i.e", "etc", "vs", "cf", "approx", "incl", "Dr", "Mr", "Mrs", "Ms", "Prof", "No", "Nos", "St", "Fig"]);

/**
 * Whether the full stop ending `text` ends a sentence: not when the word before it is a known
 * abbreviation ("e.g.", "Dr.", "No."), has a full stop of its own ("U.S."), or is a single capital
 * letter (an initial, "J. Smith" — also "year Y." at the end of a sentence, so such a sentence runs on
 * to the next real end: an excerpt may come out longer, never cut mid-sentence).
 */
function endsSentence(text: string): boolean {
  const word = (text.slice(0, -1).split(/\s+/).at(-1) ?? "").replace(/^[("“'‘[]+|[)"”'’\]]+$/g, "");
  return word !== "" && !word.includes(".") && !ABBREVIATIONS.has(word) && !/^[A-Z]$/.test(word);
}

/** Where each sentence of `text` ends (the index after its full stop), except the last. */
function sentenceEnds(text: string): number[] {
  return [...text.matchAll(CANDIDATE_END)].map((match) => match.index + 1).filter((end) => endsSentence(text.slice(0, end)));
}

/** `text` in sentences, each as written (trimmed). */
export function splitSentences(text: string): string[] {
  const bounds = [0, ...sentenceEnds(text), text.length];
  return bounds.slice(1).map((end, index) => text.slice(bounds[index], end).trim());
}

/**
 * The first `sentences` sentences of a metric's definition, VERBATIM (cut from `METRIC_DEFINITIONS`,
 * never retyped), followed by " …" when there is more. For tool descriptions: Claude Code cuts them
 * after 2,048 characters, so a long definition is quoted by its opening sentences there, and every
 * result carries it in full (`definitions`).
 */
export function definitionExcerpt(name: MetricName, sentences: number): string {
  const definition: string = METRIC_DEFINITIONS[name];
  const end = sentenceEnds(definition)[sentences - 1];
  return end === undefined ? definition : `${definition.slice(0, end)} …`;
}
