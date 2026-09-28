/**
 * Item groups (spec stories 23–26, "Attribution & Rules"): which service-mix group an item sold on
 * an invoice line belongs to, and its surgery / consult / vaccine / dental-scaling / procedure
 * flags. PURE and deterministic: the same rules, assignments and name always give the same answer,
 * whatever order the rules come in.
 *
 * An item is identified by its name as `itemKey` normalises it (Unicode NFKC, trimmed, inner
 * whitespace collapsed, lower case), so "Consultation" and "CONSULTATION " are one item.
 * Precedence, first match wins:
 *
 *   1. the owner's **assignment** for the item (Settings → Items): group + flags for that one item;
 *   2. **exact** rules — the rule's text equals the item's key — by priority (highest first);
 *   3. **pattern** rules — SQL `ILIKE` semantics on the item's key (`%` any run of characters,
 *      `_` exactly one character, `\` escapes `%`, `_` or `\`; the whole name must match) — by
 *      priority (highest first);
 *
 * ties between rules of the same kind and priority go to the older rule (lower id). An exact rule
 * beats every pattern rule whatever the priorities. Nothing matching → **unmapped** (shown as its
 * own bucket and listed in Settings → Items until the owner assigns it). A rule may also say
 * **leave unmapped** (no classification): the first rule that matches decides, so such a rule stops
 * lower rules from guessing (e.g. "%cancel%" keeps "Surgery cancellation fee" out of Surgery).
 *
 * Flags are independent of the group, with one rule: a **procedure** (an actual operation) is
 * always a **surgery** line; a surgery line that is not a procedure is a sedation / anaesthesia
 * charge (spec: an operation is a surgery case with an actual procedure, not only sedation).
 *
 * The Sync Engine and Settings store what this returns for every item name seen
 * (`item_classifications`, src/items/store.ts); the Analytics Service reads it at query time.
 */

/** The eight service-mix groups, in display order (keys are stored in the database). */
export const MIX_GROUPS = [
  "consult",
  "surgery",
  "diagnostics",
  "hospital_treatment",
  "rehab_tcvm",
  "medicines_supplements",
  "preventive",
  "retail_other",
] as const;

export type MixGroup = (typeof MIX_GROUPS)[number];

export const MIX_GROUP_LABELS: Record<MixGroup, string> = {
  consult: "Consult",
  surgery: "Surgery",
  diagnostics: "Diagnostics",
  hospital_treatment: "Hospital & treatment",
  rehab_tcvm: "Rehab & TCVM",
  medicines_supplements: "Medicines & supplements",
  preventive: "Preventive",
  retail_other: "Retail & other",
};

export function isMixGroup(value: unknown): value is MixGroup {
  return typeof value === "string" && (MIX_GROUPS as readonly string[]).includes(value);
}

/** What an item is, besides its group. */
export interface ItemFlags {
  /** A surgery line (spec "Surgery": the SURGERY service, named operations, anaesthesia/sedation and related surgical charges). */
  surgery: boolean;
  /** A consult line (spec "Consult": CONSULTATION services and the TCVM examination). */
  consult: boolean;
  /** A vaccination. */
  vaccine: boolean;
  /** Dental scaling. */
  dentalScaling: boolean;
  /** An actual operation (implies `surgery`); false for sedation / anaesthesia-only charges. */
  procedure: boolean;
}

export interface ItemClassification extends ItemFlags {
  group: MixGroup;
}

export type ItemMatchType = "exact" | "pattern";

/** A stored rule (`item_group_rules`). */
export interface ItemRule {
  id: string;
  matchType: ItemMatchType;
  /** Exact: an item name. Pattern: an ILIKE pattern. Compared after `itemKey` normalisation. */
  pattern: string;
  /** Higher wins (within exact rules, and within pattern rules). */
  priority: number;
  /** null = "leave unmapped": a matching item gets no group (lower rules are not tried). */
  classification: ItemClassification | null;
}

export type ItemMatch =
  | { source: "assignment"; classification: ItemClassification }
  | { source: "rule"; ruleId: string; classification: ItemClassification }
  /** No group: no rule matched, or the first matching rule (`ruleId`) says "leave unmapped". */
  | { source: "unmapped"; ruleId?: string };

/**
 * The identity of an item name: Unicode NFKC, trimmed, inner whitespace collapsed, lower case
 * (the same normalisation as a staff name on a line, `aliasKey`).
 */
export function itemKey(name: string): string {
  return name.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

type Token = { kind: "any" } | { kind: "one" } | { kind: "char"; char: string };

/** A pattern's tokens (by code point, like Postgres), or null when it ends in a lone escape. */
function tokenize(pattern: string): Token[] | null {
  const chars = Array.from(itemKey(pattern));
  const tokens: Token[] = [];
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index]!;
    if (char === "\\") {
      const next = chars[++index];
      if (next === undefined) return null;
      tokens.push({ kind: "char", char: next });
    } else if (char === "%") {
      if (tokens.at(-1)?.kind !== "any") tokens.push({ kind: "any" });
    } else if (char === "_") {
      tokens.push({ kind: "one" });
    } else {
      tokens.push({ kind: "char", char });
    }
  }
  return tokens;
}

/**
 * Wildcard match in O(name × pattern) (backtracking only to the last `%`), so no pattern can
 * make matching explode — unlike a regular expression built from it.
 */
function matchTokens(tokens: readonly Token[], text: readonly string[]): boolean {
  let t = 0;
  let p = 0;
  let starP = -1;
  let starT = 0;
  while (t < text.length) {
    const token = tokens[p];
    if (token && (token.kind === "one" || (token.kind === "char" && token.char === text[t]))) {
      t++;
      p++;
    } else if (token?.kind === "any") {
      starP = p++;
      starT = t;
    } else if (starP !== -1) {
      p = starP + 1;
      t = ++starT;
    } else {
      return false;
    }
  }
  while (tokens[p]?.kind === "any") p++;
  return p === tokens.length;
}

/** Whether `name` matches the ILIKE-style `pattern` (both normalised with `itemKey`). */
export function patternMatches(pattern: string, name: string): boolean {
  const tokens = tokenize(pattern);
  return tokens !== null && matchTokens(tokens, Array.from(itemKey(name)));
}

function compareRules(a: ItemRule, b: ItemRule): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  const idA = BigInt(a.id);
  const idB = BigInt(b.id);
  return idA < idB ? -1 : idA > idB ? 1 : 0;
}

/**
 * A classifier for many names with the same rules and assignments (rules compiled once).
 * `assignments` is keyed by `itemKey`.
 */
export function createItemClassifier(
  rules: readonly ItemRule[],
  assignments: ReadonlyMap<string, ItemClassification>,
): (name: string) => ItemMatch {
  const exact = new Map<string, ItemRule>();
  for (const rule of rules.filter((candidate) => candidate.matchType === "exact").sort(compareRules)) {
    const key = itemKey(rule.pattern);
    if (!exact.has(key)) exact.set(key, rule);
  }
  const patterns = rules
    .filter((rule) => rule.matchType === "pattern")
    .sort(compareRules)
    .flatMap((rule) => {
      const tokens = tokenize(rule.pattern);
      return tokens ? [{ rule, tokens }] : [];
    });

  const decide = (rule: ItemRule): ItemMatch =>
    rule.classification ? { source: "rule", ruleId: rule.id, classification: rule.classification } : { source: "unmapped", ruleId: rule.id };

  return (name) => {
    const key = itemKey(name);
    const assigned = assignments.get(key);
    if (assigned) return { source: "assignment", classification: assigned };
    const exactRule = exact.get(key);
    if (exactRule) return decide(exactRule);
    const text = Array.from(key);
    const matched = patterns.find((candidate) => matchTokens(candidate.tokens, text));
    return matched ? decide(matched.rule) : { source: "unmapped" };
  };
}

/** One item's classification (see the module comment for the precedence). */
export function classifyItem(name: string, rules: readonly ItemRule[], assignments: ReadonlyMap<string, ItemClassification> = new Map()): ItemMatch {
  return createItemClassifier(rules, assignments)(name);
}

export const MAX_PATTERN_LENGTH = 200;
export const MAX_RULE_PRIORITY = 10_000;

export type ItemRuleInput = Omit<ItemRule, "id">;

export type ItemRuleCheck =
  | { ok: true; rule: ItemRuleInput }
  | { ok: false; field: "matchType" | "pattern" | "priority" | "group" | "flags"; message: string };

/** Validates flags: a procedure is always a surgery line. */
export function checkItemFlags(flags: ItemFlags): { ok: true } | { ok: false; message: string } {
  return flags.procedure && !flags.surgery ? { ok: false, message: "An operation (procedure) must also be marked as surgery." } : { ok: true };
}

/** Validates a rule before it is stored; returns it with its pattern normalised (`itemKey`). */
export function checkItemRule(input: ItemRuleInput): ItemRuleCheck {
  if (input.matchType !== "exact" && input.matchType !== "pattern") {
    return { ok: false, field: "matchType", message: "Choose “exact name” or “pattern”." };
  }
  const pattern = itemKey(input.pattern);
  if (pattern === "") return { ok: false, field: "pattern", message: "Enter an item name or pattern." };
  if (pattern.length > MAX_PATTERN_LENGTH) return { ok: false, field: "pattern", message: `Keep it to ${MAX_PATTERN_LENGTH} characters.` };
  if (input.matchType === "pattern" && tokenize(pattern) === null) {
    return { ok: false, field: "pattern", message: "A pattern cannot end with a single \\ (it escapes the next character)." };
  }
  if (!Number.isInteger(input.priority) || Math.abs(input.priority) > MAX_RULE_PRIORITY) {
    return { ok: false, field: "priority", message: `Priority must be a whole number from −${MAX_RULE_PRIORITY} to ${MAX_RULE_PRIORITY}.` };
  }
  if (input.classification !== null) {
    if (!isMixGroup(input.classification.group)) return { ok: false, field: "group", message: "Choose one of the eight groups (or “leave unmapped”)." };
    const flags = checkItemFlags(input.classification);
    if (!flags.ok) return { ok: false, field: "flags", message: flags.message };
  }
  return { ok: true, rule: { matchType: input.matchType, pattern, priority: input.priority, classification: input.classification } };
}
