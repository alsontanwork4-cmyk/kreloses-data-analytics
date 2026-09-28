import { describe, expect, it } from "vitest";

import { METRIC_DEFINITIONS, type MetricName } from "@/analytics";

import { definitionExcerpt } from "./text";

describe("definitionExcerpt", () => {
  it("quotes the first sentences of a definition verbatim (for tool descriptions that cannot hold it all)", () => {
    const revenue = definitionExcerpt("revenue", 2);
    expect(METRIC_DEFINITIONS.revenue.startsWith(revenue.replace(/ …$/, ""))).toBe(true);
    expect(revenue).toMatch(/^Revenue: .*credited line by line to the staff named on each line\. An invoice's discount lines.* in proportion to what each line charged \(its amount after any item-level discount\)\. …$/);
    // "e.g." and decimals such as "RM 0.05" are not sentence ends.
    expect(definitionExcerpt("doctor", 1)).toBe('Doctor: a staff member of kind "doctor". …');
    expect(definitionExcerpt("doctor", 2)).toMatch(/^Doctor: .*Short names on invoice lines \(e\.g\. "Dr Ong"\) are matched to full staff names; .*\. …$/);
  });

  it("gives the whole definition, without an ellipsis, when it has no more sentences than asked for", () => {
    for (const name of ["discountRate", "lastYear", "discountedInvoices"] as MetricName[]) {
      expect(definitionExcerpt(name, 10)).toBe(METRIC_DEFINITIONS[name]);
    }
  });
});
