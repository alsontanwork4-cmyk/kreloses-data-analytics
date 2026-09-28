import {
  checkItemFlags,
  checkItemRule,
  createItemClassifier,
  DISCOUNT_ITEM_TYPE,
  isMixGroup,
  itemKey,
  type ItemClassification,
  type ItemMatch,
  type ItemMatchType,
  type ItemRule,
  type ItemRuleInput,
} from "@/attribution";
import type { JsonValue, Queryable, Sql } from "@/db/sql";

/**
 * Item groups in the database (#9): the rules (`item_group_rules`), the owner's per-item
 * assignments (`item_assignments`) and the DERIVED `item_classifications` — for every item name on
 * a sold invoice line, what the pure matcher (`createItemClassifier`, src/attribution/item-groups.ts)
 * says it is under the CURRENT rules and assignments. The Analytics Service joins it at query time
 * (`revenueFacts`: credited line → invoice line's item name → classification), so nothing about
 * groups is ever copied onto credited lines.
 *
 * `item_classifications` is kept complete and current by:
 *
 * - every rule / assignment change: the change and a recompute of EVERY known name happen in one
 *   transaction, so all history follows the change the moment it commits (spec story 26);
 * - the Sync Engine: `classifyItemNames` inside the transaction that stores an invoice's lines
 *   (new names only), and `classifyUnclassifiedItems` once per run (a catch-up for names stored
 *   any other way, e.g. before this table existed).
 *
 * Writers take one advisory transaction lock (`LOCK_KEY`) before reading the rules, so a sync that
 * classifies a new name can never commit a classification computed from rules that a concurrent
 * change has just replaced. A name that somehow has no row counts as `unmapped` in the Analytics
 * Service (its revenue is never lost).
 */

/** Serialises every writer of `item_classifications` (see the module comment). */
const LOCK_KEY = "item_classifications";

type RuleSource = "seed" | "owner";
type ClassificationSource = ItemMatch["source"];

interface ClassificationRow {
  /** 'unmapped' only on a "leave unmapped" rule and on unmapped classifications. */
  mixGroup: ItemClassification["group"] | "unmapped";
  isSurgery: boolean;
  isConsult: boolean;
  isVaccine: boolean;
  isDentalScaling: boolean;
  isProcedure: boolean;
}

function toClassification(row: ClassificationRow & { mixGroup: ItemClassification["group"] }): ItemClassification {
  return {
    group: row.mixGroup,
    surgery: row.isSurgery,
    consult: row.isConsult,
    vaccine: row.isVaccine,
    dentalScaling: row.isDentalScaling,
    procedure: row.isProcedure,
  };
}

async function loadRules(sql: Queryable): Promise<(ItemRule & { source: RuleSource; createdBy: string | null; createdAt: Date })[]> {
  const rows = await sql<(ClassificationRow & { id: string; matchType: ItemMatchType; pattern: string; priority: number; source: RuleSource; createdBy: string | null; createdAt: Date })[]>`
    select id::text as id, match_type, pattern, priority, mix_group, is_surgery, is_consult, is_vaccine, is_dental_scaling, is_procedure,
      source, created_by, created_at
    from item_group_rules
    order by (match_type = 'exact') desc, priority desc, id
  `;
  return rows.map((row) => ({
    id: row.id,
    matchType: row.matchType,
    pattern: row.pattern,
    priority: row.priority,
    // A rule whose group is 'unmapped' says "leave unmapped" (no classification).
    classification: row.mixGroup === "unmapped" ? null : toClassification({ ...row, mixGroup: row.mixGroup }),
    source: row.source,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  }));
}

async function loadAssignments(sql: Queryable): Promise<Map<string, ItemClassification>> {
  const rows = await sql<(ClassificationRow & { itemKey: string; mixGroup: ItemClassification["group"] })[]>`
    select item_key, mix_group, is_surgery, is_consult, is_vaccine, is_dental_scaling, is_procedure from item_assignments
  `;
  return new Map(rows.map((row) => [row.itemKey, toClassification(row)]));
}

/** The classifier for the rules and assignments stored now. */
export async function loadItemClassifier(sql: Queryable): Promise<(name: string) => ItemMatch> {
  const [rules, assignments] = await Promise.all([loadRules(sql), loadAssignments(sql)]);
  return createItemClassifier(rules, assignments);
}

/** Writes classifications for `names`: `replace` = recompute existing rows; otherwise new names only. */
async function writeClassifications(sql: Queryable, names: readonly string[], mode: "replace" | "insert_missing"): Promise<void> {
  if (names.length === 0) return;
  const classify = await loadItemClassifier(sql);
  const rows = names.map((name) => {
    const match = classify(name);
    const flags = match.source === "unmapped" ? null : match.classification;
    return {
      item_name: name,
      item_key: itemKey(name),
      mix_group: flags ? flags.group : "unmapped",
      is_surgery: flags?.surgery ?? false,
      is_consult: flags?.consult ?? false,
      is_vaccine: flags?.vaccine ?? false,
      is_dental_scaling: flags?.dentalScaling ?? false,
      is_procedure: flags?.procedure ?? false,
      source: match.source,
      rule_id: match.source === "assignment" ? null : (match.ruleId ?? null),
    };
  });
  const insert = sql`
    insert into item_classifications as k (
      item_name, item_key, mix_group, is_surgery, is_consult, is_vaccine, is_dental_scaling, is_procedure, source, rule_id
    )
    select r.item_name, r.item_key, r.mix_group, r.is_surgery, r.is_consult, r.is_vaccine, r.is_dental_scaling, r.is_procedure, r.source, r.rule_id
    from jsonb_to_recordset(${sql.json(rows as unknown as JsonValue)}) as r(
      item_name text, item_key text, mix_group text, is_surgery boolean, is_consult boolean, is_vaccine boolean,
      is_dental_scaling boolean, is_procedure boolean, source text, rule_id bigint
    )
    order by r.item_name
  `;
  if (mode === "insert_missing") {
    await sql`${insert} on conflict (item_name) do nothing`;
  } else {
    await sql`
      ${insert}
      on conflict (item_name) do update set
        item_key = excluded.item_key,
        mix_group = excluded.mix_group,
        is_surgery = excluded.is_surgery,
        is_consult = excluded.is_consult,
        is_vaccine = excluded.is_vaccine,
        is_dental_scaling = excluded.is_dental_scaling,
        is_procedure = excluded.is_procedure,
        source = excluded.source,
        rule_id = excluded.rule_id
      where (k.item_key, k.mix_group, k.is_surgery, k.is_consult, k.is_vaccine, k.is_dental_scaling, k.is_procedure, k.source, k.rule_id)
        is distinct from (excluded.item_key, excluded.mix_group, excluded.is_surgery, excluded.is_consult, excluded.is_vaccine,
          excluded.is_dental_scaling, excluded.is_procedure, excluded.source, excluded.rule_id)
    `;
  }
}

async function lock(sql: Queryable): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtext(${LOCK_KEY}))`;
}

/**
 * The Sync Engine's hook: gives each of these item names (from sold lines) a classification if it
 * has none yet. Call it INSIDE the transaction that stores the lines; it takes the lock only when
 * a name is new.
 */
export async function classifyItemNames(tx: Queryable, names: readonly string[]): Promise<void> {
  const unique = [...new Set(names)].sort();
  if (unique.length === 0) return;
  const missing = async () => {
    const known = await tx<{ itemName: string }[]>`select item_name from item_classifications where item_name = any(${unique}::text[])`;
    const have = new Set(known.map((row) => row.itemName));
    return unique.filter((name) => !have.has(name));
  };
  if ((await missing()).length === 0) return;
  await lock(tx);
  await writeClassifications(tx, await missing(), "insert_missing");
}

/**
 * Classifies every sold-line item name that has no classification yet (one transaction); returns
 * how many it added. The Sync Engine runs it once per run.
 */
export async function classifyUnclassifiedItems(sql: Sql): Promise<number> {
  return sql.begin(async (tx) => {
    await lock(tx);
    const names = await tx<{ itemName: string }[]>`
      select distinct l.item_name from invoice_lines l
      where l.item_type <> ${DISCOUNT_ITEM_TYPE}
        and not exists (select 1 from item_classifications k where k.item_name = l.item_name)
    `;
    await writeClassifications(
      tx,
      names.map((row) => row.itemName),
      "insert_missing",
    );
    return names.length;
  });
}

/** Recomputes every known name under the current rules and assignments. Call inside the change's transaction. */
async function reclassifyAll(tx: Queryable): Promise<void> {
  const names = await tx<{ itemName: string }[]>`
    select item_name from item_classifications
    union
    select distinct item_name from invoice_lines where item_type <> ${DISCOUNT_ITEM_TYPE}
  `;
  await writeClassifications(
    tx,
    names.map((row) => row.itemName),
    "replace",
  );
}

// ---------------------------------------------------------------------------------------------
// Settings → Items (owner only; callers check the role)

export type ItemSettingsChange =
  | { status: "saved" }
  | { status: "not_found" }
  | { status: "duplicate" }
  | { status: "invalid"; field: "item" | "matchType" | "pattern" | "priority" | "group" | "flags"; message: string };

/**
 * Sets the owner's group + flags for one item (all spellings of it: `itemKey`), replacing any
 * earlier assignment. Beats every rule; every figure follows at once.
 */
export async function assignItem(
  sql: Sql,
  input: { itemKey: string; classification: ItemClassification; assignedBy?: string },
): Promise<ItemSettingsChange> {
  const key = itemKey(input.itemKey);
  if (key === "" || key.length > 500) return { status: "invalid", field: "item", message: "Choose an item from the list." };
  const { classification } = input;
  if (!isMixGroup(classification.group)) return { status: "invalid", field: "group", message: "Choose one of the eight groups." };
  const flags = checkItemFlags(classification);
  if (!flags.ok) return { status: "invalid", field: "flags", message: flags.message };
  return sql.begin(async (tx): Promise<ItemSettingsChange> => {
    await lock(tx);
    await tx`
      insert into item_assignments as a (item_key, mix_group, is_surgery, is_consult, is_vaccine, is_dental_scaling, is_procedure, assigned_by)
      values (${key}, ${classification.group}, ${classification.surgery}, ${classification.consult}, ${classification.vaccine},
        ${classification.dentalScaling}, ${classification.procedure}, ${input.assignedBy ?? null})
      on conflict (item_key) do update set
        mix_group = excluded.mix_group,
        is_surgery = excluded.is_surgery,
        is_consult = excluded.is_consult,
        is_vaccine = excluded.is_vaccine,
        is_dental_scaling = excluded.is_dental_scaling,
        is_procedure = excluded.is_procedure,
        assigned_by = excluded.assigned_by
    `;
    await reclassifyAll(tx);
    return { status: "saved" };
  });
}

/** Removes the owner's assignment for an item: the rules decide again. */
export async function clearItemAssignment(sql: Sql, key: string): Promise<ItemSettingsChange> {
  return sql.begin(async (tx): Promise<ItemSettingsChange> => {
    await lock(tx);
    const deleted = await tx`delete from item_assignments where item_key = ${itemKey(key)} returning 1`;
    if (deleted.length === 0) return { status: "not_found" };
    await reclassifyAll(tx);
    return { status: "saved" };
  });
}

/**
 * Adds a rule (pattern normalised); every name is reclassified in the same transaction. A null
 * classification is a "leave unmapped" rule (stored with group 'unmapped' and no flags).
 */
export async function addItemRule(
  sql: Sql,
  input: ItemRuleInput & { createdBy?: string },
): Promise<{ status: "saved"; ruleId: string } | Exclude<ItemSettingsChange, { status: "saved" }>> {
  const checked = checkItemRule(input);
  if (!checked.ok) return { status: "invalid", field: checked.field, message: checked.message };
  const { rule } = checked;
  const classification = rule.classification ?? { group: "unmapped", surgery: false, consult: false, vaccine: false, dentalScaling: false, procedure: false };
  return sql.begin(async (tx) => {
    await lock(tx);
    const [row] = await tx<{ id: string }[]>`
      insert into item_group_rules (match_type, pattern, priority, mix_group, is_surgery, is_consult, is_vaccine, is_dental_scaling, is_procedure, source, created_by)
      values (${rule.matchType}, ${rule.pattern}, ${rule.priority}, ${classification.group}, ${classification.surgery}, ${classification.consult},
        ${classification.vaccine}, ${classification.dentalScaling}, ${classification.procedure}, 'owner', ${input.createdBy ?? null})
      on conflict (match_type, pattern) do nothing
      returning id::text as id
    `;
    if (!row) return { status: "duplicate" as const };
    await reclassifyAll(tx);
    return { status: "saved" as const, ruleId: row.id };
  });
}

/** Deletes a rule (seeded ones too); every name is reclassified in the same transaction. */
export async function deleteItemRule(sql: Sql, ruleId: string): Promise<ItemSettingsChange> {
  if (!/^[1-9][0-9]{0,17}$/.test(ruleId)) return { status: "not_found" };
  return sql.begin(async (tx): Promise<ItemSettingsChange> => {
    await lock(tx);
    const deleted = await tx`delete from item_group_rules where id = ${ruleId} returning 1`;
    if (deleted.length === 0) return { status: "not_found" };
    await reclassifyAll(tx);
    return { status: "saved" };
  });
}

/** A stored rule, as Settings → Items lists it. */
export interface StoredItemRule extends ItemRule {
  source: RuleSource;
  createdBy: string | null;
  createdAt: Date;
  /** How many items (by `itemKey`) this rule decides now (for a "leave unmapped" rule: keeps unmapped). */
  items: number;
}

/** Every rule in the order the matcher tries them: exact rules first, then by priority (highest first), then oldest first. */
export async function listItemRules(sql: Sql): Promise<StoredItemRule[]> {
  const [rules, counts] = await Promise.all([
    loadRules(sql),
    sql<{ ruleId: string; items: number }[]>`
      select rule_id::text as rule_id, count(distinct item_key)::int as items
      from item_classifications where source <> 'assignment' and rule_id is not null group by rule_id
    `,
  ]);
  const itemsByRule = new Map(counts.map((row) => [row.ruleId, row.items]));
  return rules.map((rule) => ({ ...rule, items: itemsByRule.get(rule.id) ?? 0 }));
}

/** One item (all spellings of a name, by `itemKey`) and what decides its group. */
export interface ItemEntry {
  itemKey: string;
  /** The spelling on the most lines (ties: alphabetical). */
  name: string;
  /** Every spelling seen, alphabetical. */
  spellings: string[];
  /** Kreloses ItemTypes seen (1 product, 4 service…), ascending. */
  itemTypes: number[];
  /** Sold lines with this item (all time). */
  lines: number;
  source: ClassificationSource;
  /** Null = unmapped. */
  classification: ItemClassification | null;
  /** The rule that decides it: `source` rule, or `source` unmapped by a "leave unmapped" rule. */
  rule: Pick<ItemRule, "id" | "matchType" | "pattern" | "priority"> | null;
}

/** Every item sold (discount lines excluded), by name. */
export async function listItems(sql: Sql): Promise<ItemEntry[]> {
  const rows = await sql<
    (ClassificationRow & {
      itemName: string;
      itemKey: string | null;
      itemTypes: number[];
      lines: number;
      source: ClassificationSource | null;
      ruleId: string | null;
      matchType: ItemMatchType | null;
      pattern: string | null;
      priority: number | null;
    })[]
  >`
    select l.item_name, k.item_key, array_agg(distinct l.item_type order by l.item_type) as item_types, count(*)::int as lines,
      k.mix_group, k.is_surgery, k.is_consult, k.is_vaccine, k.is_dental_scaling, k.is_procedure, k.source,
      r.id::text as rule_id, r.match_type, r.pattern, r.priority
    from invoice_lines l
    left join item_classifications k on k.item_name = l.item_name
    left join item_group_rules r on r.id = k.rule_id
    where l.item_type <> ${DISCOUNT_ITEM_TYPE}
    group by l.item_name, k.item_name, r.id
  `;
  const byKey = new Map<string, (typeof rows)[number][]>();
  for (const row of rows) {
    const key = row.itemKey ?? itemKey(row.itemName);
    byKey.set(key, [...(byKey.get(key) ?? []), row]);
  }
  const entries = [...byKey.entries()].map(([key, spellings]): ItemEntry => {
    const sorted = [...spellings].sort((a, b) => compareText(a.itemName, b.itemName));
    const top = [...sorted].sort((a, b) => b.lines - a.lines)[0]!;
    // Every spelling of a key has the same classification; one stored without a row yet counts as unmapped.
    const first = sorted.find((row) => row.source !== null) ?? sorted[0]!;
    const source = first.source ?? "unmapped";
    return {
      itemKey: key,
      name: top.itemName.replace(/\s+/g, " ").trim(),
      spellings: sorted.map((row) => row.itemName),
      itemTypes: [...new Set(sorted.flatMap((row) => row.itemTypes))].sort((a, b) => a - b),
      lines: sorted.reduce((total, row) => total + row.lines, 0),
      source,
      classification: source === "unmapped" || first.mixGroup === null || first.mixGroup === "unmapped" ? null : toClassification({ ...first, mixGroup: first.mixGroup }),
      rule:
        source !== "assignment" && first.ruleId
          ? { id: first.ruleId, matchType: first.matchType!, pattern: first.pattern!, priority: first.priority! }
          : null,
    };
  });
  return entries.sort((a, b) => compareText(a.itemKey, b.itemKey));
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
