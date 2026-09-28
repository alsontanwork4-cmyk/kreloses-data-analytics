import { describe, expect, it } from "vitest";

import {
  checkItemRule,
  classifyItem,
  createItemClassifier,
  itemKey,
  MIX_GROUP_LABELS,
  MIX_GROUPS,
  patternMatches,
  type ItemClassification,
  type ItemRule,
} from "./item-groups";

/**
 * Attribution & Rules (pure): an item name on an invoice line → its service-mix group and its
 * surgery / consult / vaccine / dental-scaling / procedure flags. Order of precedence: the owner's
 * assignment for the item, then exact-name rules, then pattern rules (each by priority, highest
 * first; ties to the older rule), else "unmapped".
 */
const NO_FLAGS = { surgery: false, consult: false, vaccine: false, dentalScaling: false, procedure: false };
const as = (group: ItemClassification["group"], flags: Partial<ItemClassification> = {}): ItemClassification => ({ group, ...NO_FLAGS, ...flags });

let nextId = 1;
function rule(matchType: ItemRule["matchType"], pattern: string, priority: number, classification: ItemClassification | null, id = String(nextId++)): ItemRule {
  return { id, matchType, pattern, priority, classification };
}

describe("item groups", () => {
  it("has the eight service-mix groups, in display order, with their labels", () => {
    expect(MIX_GROUPS.map((group) => MIX_GROUP_LABELS[group])).toEqual([
      "Consult",
      "Surgery",
      "Diagnostics",
      "Hospital & treatment",
      "Rehab & TCVM",
      "Medicines & supplements",
      "Preventive",
      "Retail & other",
    ]);
  });

  it("identifies an item by its name trimmed, with inner whitespace collapsed, in lower case (Unicode NFKC)", () => {
    expect(itemKey("  Dental   SCALING\t")).toBe("dental scaling");
    expect(itemKey("Ｘ-ray")).toBe("x-ray"); // full-width letters
    expect(itemKey("Consultation fee")).toBe("consultation fee"); // no-break space
  });
});

describe("pattern matching (SQL ILIKE semantics on the normalised name)", () => {
  it("% matches any run of characters (none included), _ exactly one; the whole name must match", () => {
    expect(patternMatches("%spay%", "surgery - spay")).toBe(true);
    expect(patternMatches("%spay%", "spay")).toBe(true);
    expect(patternMatches("spay", "surgery - spay")).toBe(false);
    expect(patternMatches("surgery%", "surgery - fho")).toBe(true);
    expect(patternMatches("surgery%", "post-surgery check")).toBe(false);
    expect(patternMatches("x_ray", "x-ray")).toBe(true);
    expect(patternMatches("x_ray", "xray")).toBe(false);
    expect(patternMatches("%", "")).toBe(true);
    expect(patternMatches("%a%b%", "xaxxbx")).toBe(true);
    expect(patternMatches("%a%b%", "xbxxax")).toBe(false);
  });

  it("is case-insensitive and whitespace-tolerant (both sides are normalised)", () => {
    expect(patternMatches("%Blood  TEST%", "Blood test panel")).toBe(true);
    expect(patternMatches("%blood test%", "  BLOOD   Test panel ")).toBe(true);
  });

  it("\\ escapes a literal %, _ or \\", () => {
    expect(patternMatches("10\\% off%", "10% off consult")).toBe(true);
    expect(patternMatches("10\\% off%", "100 off consult")).toBe(false);
    expect(patternMatches("a\\_b", "a_b")).toBe(true);
    expect(patternMatches("a\\_b", "axb")).toBe(false);
    expect(patternMatches("a\\\\b", "a\\b")).toBe(true);
  });

  it("stays fast on a pattern with many wildcards that does not match (no backtracking blow-up)", () => {
    const started = performance.now();
    expect(patternMatches("%a%a%a%a%a%a%a%a%a%a%b", "a".repeat(200))).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe("classifying an item", () => {
  const surgery = as("surgery", { surgery: true, procedure: true });
  const sedation = as("surgery", { surgery: true, procedure: false });
  const consult = as("consult", { consult: true });
  const diagnostics = as("diagnostics");
  const preventive = as("preventive");

  it("is unmapped when no rule matches", () => {
    expect(classifyItem("Microchip", [rule("pattern", "%spay%", 10, surgery)])).toEqual({ source: "unmapped" });
    expect(classifyItem("Microchip", [])).toEqual({ source: "unmapped" });
  });

  it("an exact rule matches the whole name, ignoring case and whitespace", () => {
    const exact = rule("exact", "Consultation", 0, consult, "7");
    expect(classifyItem("  CONSULTATION ", [exact])).toEqual({ source: "rule", ruleId: "7", classification: consult });
    expect(classifyItem("Consultation fee", [exact])).toEqual({ source: "unmapped" });
  });

  it("an exact rule beats every pattern rule, whatever their priorities", () => {
    const rules = [rule("pattern", "%heartworm%", 1000, preventive, "1"), rule("exact", "heartworm test", -5, diagnostics, "2")];
    expect(classifyItem("Heartworm test", rules)).toEqual({ source: "rule", ruleId: "2", classification: diagnostics });
    expect(classifyItem("Heartworm chewables", rules)).toEqual({ source: "rule", ruleId: "1", classification: preventive });
  });

  it("among patterns (and among exact rules) the highest priority wins; a tie goes to the older rule (lower id)", () => {
    const rules = [
      rule("pattern", "%tablet%", 40, as("medicines_supplements"), "10"),
      rule("pattern", "%deworm%", 80, preventive, "11"),
      rule("pattern", "%worm%", 80, as("retail_other"), "9"),
    ];
    // Priority 80 beats 40; between the two 80s, rule 9 is older than rule 11.
    expect(classifyItem("Deworming tablets", rules)).toMatchObject({ source: "rule", ruleId: "9" });
    expect(classifyItem("Antibiotic tablets", rules)).toMatchObject({ source: "rule", ruleId: "10" });
    // Ids compare as numbers, not text ("9" < "10").
    const exacts = [rule("exact", "x-ray", 0, diagnostics, "10"), rule("exact", "X-Ray", 0, as("hospital_treatment"), "9")];
    expect(classifyItem("x-ray", exacts)).toMatchObject({ ruleId: "9" });
    // Order of the list does not matter.
    expect(classifyItem("Deworming tablets", [...rules].reverse())).toMatchObject({ ruleId: "9" });
  });

  it("the owner's assignment for an item beats every rule; it is keyed by the normalised name", () => {
    const rules = [rule("exact", "skin scraping test", 100, as("retail_other")), rule("pattern", "%test%", 100, as("retail_other"))];
    const assignments = new Map([[itemKey("Skin Scraping  Test"), diagnostics]]);
    expect(classifyItem("skin scraping test", rules, assignments)).toEqual({ source: "assignment", classification: diagnostics });
    expect(classifyItem("Blood test", rules, assignments)).toMatchObject({ source: "rule" });
  });

  it("a “leave unmapped” rule (no classification) stops lower rules: the item stays unmapped, naming the rule", () => {
    const rules = [rule("pattern", "surgery %", 91, surgery, "1"), rule("pattern", "%cancel%", 99, null, "2")];
    expect(classifyItem("Surgery cancellation fee", rules)).toEqual({ source: "unmapped", ruleId: "2" });
    expect(classifyItem("Surgery - Spay", rules)).toEqual({ source: "rule", ruleId: "1", classification: surgery });
    // An exact rule or the owner's assignment still beats it.
    expect(classifyItem("Surgery cancellation fee", [...rules, rule("exact", "surgery cancellation fee", 0, consult, "3")])).toMatchObject({ ruleId: "3" });
    expect(classifyItem("Surgery cancellation fee", rules, new Map([["surgery cancellation fee", diagnostics]]))).toMatchObject({ source: "assignment" });
  });

  it("carries the rule's flags: a sedation-only charge is surgery but not a procedure", () => {
    const classify = createItemClassifier(
      [rule("pattern", "%sedation%", 90, sedation), rule("pattern", "%spay%", 91, surgery), rule("pattern", "%consult%", 70, consult)],
      new Map(),
    );
    expect(classify("Sedation (IV)")).toMatchObject({ classification: { group: "surgery", surgery: true, procedure: false } });
    expect(classify("Spay under sedation")).toMatchObject({ classification: { group: "surgery", surgery: true, procedure: true } });
    expect(classify("Consultation")).toMatchObject({ classification: { group: "consult", consult: true, surgery: false } });
  });
});

describe("checking a rule before it is stored", () => {
  it("normalises the pattern and accepts a sensible rule", () => {
    expect(checkItemRule({ matchType: "pattern", pattern: "  %Spay% ", priority: 90, classification: as("surgery", { surgery: true, procedure: true }) })).toEqual({
      ok: true,
      rule: { matchType: "pattern", pattern: "%spay%", priority: 90, classification: as("surgery", { surgery: true, procedure: true }) },
    });
    expect(checkItemRule({ matchType: "exact", pattern: "Heartworm  Test", priority: 0, classification: diagnostics() })).toMatchObject({
      ok: true,
      rule: { pattern: "heartworm test" },
    });
  });

  it("accepts a “leave unmapped” rule (no classification)", () => {
    expect(checkItemRule({ matchType: "pattern", pattern: "%Cancel%", priority: 99, classification: null })).toEqual({
      ok: true,
      rule: { matchType: "pattern", pattern: "%cancel%", priority: 99, classification: null },
    });
  });

  it("refuses an empty or over-long pattern, a pattern ending in a lone escape, a bad priority, an unknown group, and a procedure that is not surgery", () => {
    const valid = { matchType: "pattern" as const, pattern: "%x%", priority: 0, classification: diagnostics() };
    expect(checkItemRule({ ...valid, pattern: "   " })).toMatchObject({ ok: false, field: "pattern" });
    expect(checkItemRule({ ...valid, pattern: "a".repeat(201) })).toMatchObject({ ok: false, field: "pattern" });
    expect(checkItemRule({ ...valid, pattern: "%spay\\" })).toMatchObject({ ok: false, field: "pattern" });
    expect(checkItemRule({ ...valid, priority: 1.5 })).toMatchObject({ ok: false, field: "priority" });
    expect(checkItemRule({ ...valid, priority: 100_001 })).toMatchObject({ ok: false, field: "priority" });
    expect(checkItemRule({ ...valid, matchType: "regex" as never })).toMatchObject({ ok: false, field: "matchType" });
    expect(checkItemRule({ ...valid, classification: { ...diagnostics(), group: "unmapped" as never } })).toMatchObject({ ok: false, field: "group" });
    expect(checkItemRule({ ...valid, classification: as("surgery", { procedure: true }) })).toMatchObject({ ok: false, field: "flags" });
  });

  function diagnostics(): ItemClassification {
    return as("diagnostics");
  }
});
