import { describe, expect, it } from "vitest";

import { METRIC_DEFINITIONS, type MetricName } from "@/analytics";

import { MCP_TOOLS } from "./index";
import { definitionExcerpt, splitSentences } from "./text";

describe("splitSentences", () => {
  it("ends a sentence at a full stop, space and capital letter", () => {
    expect(splitSentences("One here. Two there.  Three (with brackets). Four")).toEqual(["One here.", "Two there.", "Three (with brackets).", "Four"]);
    // Decimals and a lower-case next word are no sentence end.
    expect(splitSentences("Over RM 0.05 counts. It is 1.5 times the base. and so on.")).toEqual(["Over RM 0.05 counts.", "It is 1.5 times the base. and so on."]);
  });

  it("never cuts after an abbreviation or a single initial", () => {
    expect(
      splitSentences(
        'Names such as Dr. Ong (e.g. "Dr Ong") match, i.e. Most do. See No. 5 or No. Five and Fig. 2. Then J. Smith signs, cf. Chapter one, vs. Others, etc. Done. Mr. Tan and Mrs. Lee came. It ends in year Y. Then Y+1 follows.',
      ),
    ).toEqual([
      'Names such as Dr. Ong (e.g. "Dr Ong") match, i.e. Most do.',
      "See No. 5 or No. Five and Fig. 2.",
      "Then J. Smith signs, cf. Chapter one, vs. Others, etc. Done.",
      "Mr. Tan and Mrs. Lee came.",
      // A single letter could be an initial: not cut there (an excerpt may run longer, never cut short).
      "It ends in year Y. Then Y+1 follows.",
    ]);
  });
});

describe("definitionExcerpt", () => {
  it("quotes the first sentences of a definition verbatim (for tool descriptions that cannot hold it all)", () => {
    const revenue = definitionExcerpt("revenue", 2);
    expect(METRIC_DEFINITIONS.revenue.startsWith(revenue.replace(/ …$/, ""))).toBe(true);
    expect(revenue).toMatch(/^Revenue: .*credited line by line to the staff named on each line\. An invoice's discount lines.* in proportion to what each line charged \(its amount after any item-level discount\)\. …$/);
    // "e.g." and decimals such as "RM 0.05" are not sentence ends.
    expect(definitionExcerpt("doctor", 1)).toBe('Doctor: a staff member of kind "doctor". …');
    expect(definitionExcerpt("doctor", 2)).toMatch(/^Doctor: .*Short names on invoice lines \(e\.g\. "Dr Ong"\) are matched to full staff names; .*\. …$/);
    // "year Y." might be an initial: the cohort's first sentence runs on to the next real end.
    expect(definitionExcerpt("yearlyCohort", 1)).toMatch(/^Yearly cohort retention: .* in calendar year Y\. Retained with any doctor = .* in Y\+1\. …$/);
  });

  it("gives the whole definition, without an ellipsis, when it has no more sentences than asked for", () => {
    for (const name of ["discountRate", "lastYear", "discountedInvoices"] as MetricName[]) {
      expect(definitionExcerpt(name, 10)).toBe(METRIC_DEFINITIONS[name]);
    }
  });

  it("every excerpt the tools quote is verbatim and ends on a real sentence end", () => {
    // Independent of the splitter's own list: what a sentence may not end on.
    const ABBREVIATIONS = ["e.g", "i.e", "etc", "vs", "cf", "dr", "mr", "mrs", "ms", "no", "st", "fig", "approx", "incl"];
    const excerpts = MCP_TOOLS.flatMap((tool) =>
      tool.description
        .split("\n")
        .filter((line) => line.startsWith("- ") && line.endsWith(" …"))
        .map((line) => ({ tool: tool.name, text: line.slice(2, -" …".length) })),
    );
    // item_mix quotes the start of revenue, retention the start of yearlyCohort.
    expect(excerpts.map((excerpt) => excerpt.tool).sort()).toEqual(["item_mix", "retention"]);
    for (const { tool, text } of excerpts) {
      const definition = Object.values(METRIC_DEFINITIONS).find((candidate: string) => candidate.startsWith(text) && candidate.length > text.length);
      expect(definition, `${tool}: "${text}" is not the start of a definition`).toBeDefined();
      expect(definition!.slice(text.length), tool).toMatch(/^\s+[A-Z]/);
      expect(text.endsWith("."), tool).toBe(true);
      const word = text
        .slice(0, -1)
        .split(/\s+/)
        .at(-1)!
        .replace(/^[("“'‘]+|[)"”'’]+$/g, "");
      expect(word.length, `${tool}: cut after "${word}."`).toBeGreaterThan(2);
      expect(ABBREVIATIONS, `${tool}: cut after "${word}."`).not.toContain(word.toLowerCase());
    }
  });
});
