import { describe, expect, it } from "vitest";

import {
  filterSearchParamsOnly,
  mergeFilterIntoSearchParams,
  parseFilter,
  serializeFilter,
  type FilterState,
} from "@/filters";

// 28 Sep 2026, 10:00 in Kuala Lumpur.
const now = new Date("2026-09-28T02:00:00Z");

describe("parseFilter", () => {
  it("defaults to month to date with no branch or doctor filter", () => {
    expect(parseFilter(new URLSearchParams(), now)).toEqual({
      range: "month-to-date",
      filter: { dateFrom: "2026-09-01", dateTo: "2026-09-28" },
    });
  });

  it("resolves a preset from ?range=", () => {
    expect(parseFilter(new URLSearchParams("range=last-month"), now)).toEqual({
      range: "last-month",
      filter: { dateFrom: "2026-08-01", dateTo: "2026-08-31" },
    });
  });

  it("reads a custom range from ?from=&to=", () => {
    expect(parseFilter(new URLSearchParams("from=2025-01-05&to=2025-02-20"), now)).toEqual({
      range: "custom",
      filter: { dateFrom: "2025-01-05", dateTo: "2025-02-20" },
    });
  });

  it("swaps a custom range given back to front", () => {
    expect(parseFilter(new URLSearchParams("from=2025-02-20&to=2025-01-05"), now).filter).toEqual({
      dateFrom: "2025-01-05",
      dateTo: "2025-02-20",
    });
  });

  it.each([
    ["an unknown range", "range=fortnight"],
    ["an impossible date", "from=2026-02-30&to=2026-03-01"],
    ["a malformed date", "from=1/2/2026&to=2026-03-01"],
    ["a custom range with one end missing", "from=2026-03-01"],
  ])("falls back to the default for %s", (_label, query) => {
    expect(parseFilter(new URLSearchParams(query), now)).toEqual({
      range: "month-to-date",
      filter: { dateFrom: "2026-09-01", dateTo: "2026-09-28" },
    });
  });

  it("lets an explicit preset win over stale custom dates", () => {
    expect(parseFilter(new URLSearchParams("range=today&from=2025-01-01&to=2025-01-31"), now)).toEqual({
      range: "today",
      filter: { dateFrom: "2026-09-28", dateTo: "2026-09-28" },
    });
  });

  it("reads branch and doctor ids, comma-separated or repeated, without duplicates", () => {
    const state = parseFilter(new URLSearchParams("branch=12,15&branch=12&doctor=d-1&doctor=d-2,"), now);
    expect(state.filter.branchIds).toEqual(["12", "15"]);
    expect(state.filter.doctorIds).toEqual(["d-1", "d-2"]);
  });

  it("ignores ids that are not plain identifiers", () => {
    expect(parseFilter(new URLSearchParams("branch=<script>,7"), now).filter.branchIds).toEqual(["7"]);
  });

  it("accepts the plain object Next.js passes as page searchParams", () => {
    expect(parseFilter({ range: "year-to-date", branch: ["1", "2"], doctor: undefined }, now)).toEqual({
      range: "year-to-date",
      filter: { dateFrom: "2026-01-01", dateTo: "2026-09-28", branchIds: ["1", "2"] },
    });
  });
});

describe("serializeFilter", () => {
  it("writes nothing for the default view", () => {
    expect(serializeFilter(parseFilter(new URLSearchParams(), now)).toString()).toBe("");
  });

  it("writes a preset by name, not its dates, so a bookmark stays relative", () => {
    const state: FilterState = { range: "last-month", filter: { dateFrom: "2026-08-01", dateTo: "2026-08-31" } };
    expect(serializeFilter(state).toString()).toBe("range=last-month");
  });

  it("writes a custom range as from/to", () => {
    const state: FilterState = { range: "custom", filter: { dateFrom: "2025-01-05", dateTo: "2025-02-20" } };
    expect(serializeFilter(state).toString()).toBe("from=2025-01-05&to=2025-02-20");
  });

  it("writes branch and doctor ids comma-separated", () => {
    const state: FilterState = {
      range: "today",
      filter: { dateFrom: "2026-09-28", dateTo: "2026-09-28", branchIds: ["12", "15"], doctorIds: ["d-1"] },
    };
    expect(decodeURIComponent(serializeFilter(state).toString())).toBe("range=today&branch=12,15&doctor=d-1");
  });

  it("round-trips through parseFilter", () => {
    const state: FilterState = {
      range: "custom",
      filter: { dateFrom: "2024-01-01", dateTo: "2024-12-31", branchIds: ["3"] },
    };
    expect(parseFilter(serializeFilter(state), now)).toEqual(state);
  });
});

describe("mergeFilterIntoSearchParams", () => {
  it("replaces the filter but keeps page-specific params", () => {
    const current = new URLSearchParams("measure=aov&from=2025-01-01&to=2025-01-31&branch=1");
    const next: FilterState = { range: "year-to-date", filter: { dateFrom: "2026-01-01", dateTo: "2026-09-28" } };
    expect(mergeFilterIntoSearchParams(current, next).toString()).toBe("measure=aov&range=year-to-date");
  });
});

describe("filterSearchParamsOnly", () => {
  it("keeps only the global filter params (for links to other pages)", () => {
    const params = new URLSearchParams("measure=aov&range=today&branch=1&page=2");
    expect(filterSearchParamsOnly(params).toString()).toBe("range=today&branch=1");
  });
});
