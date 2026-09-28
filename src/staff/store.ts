import { aliasKey, defaultStaffKind, matchStaffName, nameKey, suggestStaff, type StaffCandidate, type StaffKind } from "@/attribution";
import type { Queryable, Sql } from "@/db/sql";
import type { KrelosesStaffMember } from "@/kreloses";

/**
 * The staff directory and the staff names seen on invoice lines (`staff`, `staff_aliases`).
 *
 * - Every distinct staff name on a line gets ONE alias row, pointing at exactly one staff member:
 *   the Kreloses staff member it matches (`auto`), the one the owner chose (`manual`), or — when no
 *   single staff member matches — an "alias only" staff row made from the name itself
 *   (`unmatched`), so its revenue is still attributed (e.g. a deleted doctor keeps their history).
 * - A new name is matched once, when first seen. Afterwards a sync never moves a name that already
 *   has revenue (credited lines): a deleted doctor's history must not jump to a new hire with a
 *   similar name. Unmatched names get SUGGESTIONS instead (`listStaffAliases`); the owner applies
 *   them. Only an unmatched name with no credited lines left is matched again automatically.
 * - Staff rows are never deleted (alias-only ones included, so "its own entry" can always be chosen
 *   again). A kind the owner set (`kind_source = 'manual'`) is never changed; otherwise it follows
 *   `defaultStaffKind(full name, names on lines)` (a generic word only counts on the full name).
 * - Rows are always locked in id / key order, so concurrent syncs cannot deadlock.
 *
 * Revenue follows these rows at query time (docs/adr/0005): remapping an alias or changing a kind
 * changes every figure immediately, with no re-sync.
 */

export type AliasMatch = "auto" | "manual" | "unmatched";
export type StaffSource = "kreloses" | "alias_only";

export const STAFF_KINDS: readonly StaffKind[] = ["doctor", "other", "generic"];

export function isStaffKind(value: unknown): value is StaffKind {
  return typeof value === "string" && (STAFF_KINDS as readonly string[]).includes(value);
}

/**
 * Stores the staff a connection's login lists (full names from Kreloses): new ones are added with a
 * default kind, renamed ones updated, and this connection's staff that are no longer listed are
 * marked inactive (never deleted; an empty list marks nobody). Then unmatched names without revenue
 * are matched again and automatic kinds refreshed. One transaction.
 */
export async function upsertStaffDirectory(
  sql: Sql,
  connectionId: string,
  members: KrelosesStaffMember[],
  options: { fence?: (tx: Queryable) => Promise<void> } = {},
): Promise<void> {
  await sql.begin(async (tx) => {
    // The Sync Engine renews its connection lease here (and stops if it lost it).
    await options.fence?.(tx);
    if (members.length > 0) {
      const rows = [...members]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((member) => ({ staff_id: member.id, name: member.name, name_key: nameKey(member.name), kind: defaultStaffKind(member.name) }));
      await tx`
        insert into staff as s (full_name, name_key, kind, source, kreloses_staff_id, active, connection_id)
        select r.name, r.name_key, r.kind, 'kreloses', r.staff_id, true, ${connectionId}::bigint
        from jsonb_to_recordset(${tx.json(rows)}) as r(staff_id text, name text, name_key text, kind text)
        order by r.staff_id
        on conflict (kreloses_staff_id) do update set
          full_name = excluded.full_name,
          name_key = excluded.name_key,
          active = true,
          connection_id = excluded.connection_id
        where (s.full_name, s.name_key, s.active, s.connection_id)
          is distinct from (excluded.full_name, excluded.name_key, true, excluded.connection_id)
      `;
      await tx`
        update staff set active = false
        where source = 'kreloses' and active and connection_id = ${connectionId}
          and kreloses_staff_id <> all(${members.map((member) => member.id)}::text[])
      `;
    }
    await rematchUnmatchedAliases(tx);
    await refreshAutoKinds(tx);
  });
}

/** Kreloses staff (active or not): the names line names are matched against. */
async function staffDirectory(sql: Queryable): Promise<StaffCandidate[]> {
  return sql<StaffCandidate[]>`select id::text as id, full_name as name from staff where source = 'kreloses' order by id`;
}

/**
 * Matches unmatched names that have NO credited lines (e.g. every line that named them was re-read
 * away). A name with revenue is never moved by a sync: it only gets suggestions.
 */
async function rematchUnmatchedAliases(sql: Queryable): Promise<void> {
  const unmatched = await sql<{ id: string; rawName: string }[]>`
    select a.id::text as id, a.raw_name from staff_aliases a
    where a.match = 'unmatched' and not exists (select 1 from credited_lines c where c.staff_alias_id = a.id)
    order by a.id
  `;
  if (unmatched.length === 0) return;
  const directory = await staffDirectory(sql);
  for (const alias of unmatched) {
    const result = matchStaffName(alias.rawName, directory);
    if (result.match !== "auto") continue;
    await sql`update staff_aliases set staff_id = ${result.staffId}, match = 'auto' where id = ${alias.id} and match = 'unmatched'`;
  }
}

/**
 * Sets `kind` of each staff member whose kind is automatic (all, or only `staffIds`) to
 * `defaultStaffKind(full name, names on lines pointing at them)`, writing only rows that change,
 * in id order.
 */
async function refreshAutoKinds(sql: Queryable, staffIds?: readonly string[]): Promise<void> {
  const rows = await sql<{ id: string; kind: StaffKind; fullName: string; lineNames: string[] }[]>`
    select s.id::text as id, s.kind, s.full_name,
      coalesce((select array_agg(a.raw_name order by a.raw_name) from staff_aliases a where a.staff_id = s.id), '{}') as line_names
    from staff s
    where s.kind_source = 'auto' ${staffIds ? sql`and s.id = any(${[...staffIds]}::bigint[])` : sql``}
    order by s.id
  `;
  for (const row of rows) {
    const kind = defaultStaffKind(row.fullName, row.lineNames);
    if (kind !== row.kind) await sql`update staff set kind = ${kind} where id = ${row.id} and kind_source = 'auto'`;
  }
}

/**
 * The alias ids (by `aliasKey`) for these line staff names, creating the aliases that are new:
 * matched to the Kreloses staff directory, or to alias-only staff when no single member matches.
 * Call it inside the transaction that writes the lines. Blank names are ignored.
 */
export async function ensureAliases(sql: Queryable, rawNames: readonly string[]): Promise<Map<string, string>> {
  const firstSpelling = new Map<string, string>();
  for (const raw of rawNames) {
    const key = aliasKey(raw);
    if (key !== "" && !firstSpelling.has(key)) firstSpelling.set(key, raw.replace(/\s+/g, " ").trim());
  }
  if (firstSpelling.size === 0) return new Map();
  // A fixed order, so concurrent syncs always lock alias rows in the same order.
  const keys = [...firstSpelling.keys()].sort();
  const find = () =>
    sql<{ id: string; normalisedName: string }[]>`
      select id::text as id, normalised_name from staff_aliases where normalised_name = any(${keys}::text[])
    `;

  let found = await find();
  const missing = keys.filter((key) => !found.some((row) => row.normalisedName === key));
  if (missing.length > 0) {
    const directory = await staffDirectory(sql);
    const touched = new Set<string>();
    for (const key of missing) {
      const raw = firstSpelling.get(key)!;
      const result = matchStaffName(raw, directory);
      const staffId = result.match === "auto" ? result.staffId : await aliasOnlyStaff(sql, raw);
      touched.add(staffId);
      await sql`
        insert into staff_aliases (raw_name, normalised_name, staff_id, match)
        values (${raw}, ${key}, ${staffId}, ${result.match === "auto" ? "auto" : "unmatched"})
        on conflict (normalised_name) do nothing
      `;
    }
    await refreshAutoKinds(sql, [...touched]);
    found = await find();
  }
  return new Map(found.map((row) => [row.normalisedName, row.id]));
}

/** The alias-only staff row for an unmatched name (shared by names with the same `nameKey`). */
async function aliasOnlyStaff(sql: Queryable, raw: string): Promise<string> {
  const key = nameKey(raw);
  await sql`
    insert into staff (full_name, name_key, kind, source)
    values (${raw}, ${key}, ${defaultStaffKind(raw)}, 'alias_only')
    on conflict (name_key) where source = 'alias_only' do nothing
  `;
  const [row] = await sql<{ id: string }[]>`select id::text as id from staff where source = 'alias_only' and name_key = ${key}`;
  return row!.id;
}

// ---------------------------------------------------------------------------------------------
// Settings → Doctors (owner only; callers check the role)

export interface StaffMember {
  id: string;
  name: string;
  kind: StaffKind;
  kindSource: "auto" | "manual";
  source: StaffSource;
  /** False once Kreloses stopped listing them (disabled or deleted there). Always true for alias-only staff. */
  active: boolean;
  /** How many line names (aliases) point at them. */
  aliases: number;
}

export interface StaffAlias {
  id: string;
  /** The name as written on invoice lines. */
  rawName: string;
  match: AliasMatch;
  staff: Pick<StaffMember, "id" | "name" | "kind" | "source" | "active">;
  /** Kreloses staff the matcher would offer for this name (for unmatched names), best first. */
  suggestions: Pick<StaffMember, "id" | "name">[];
}

/**
 * Every staff member, by name — alias-only ones too, even with no line name pointing at them any
 * more, so a name credited elsewhere can always be pointed back at its own entry.
 */
export async function listStaffMembers(sql: Sql): Promise<StaffMember[]> {
  return sql<StaffMember[]>`
    select s.id::text as id, s.full_name as name, s.kind, s.kind_source, s.source, s.active,
      (select count(*)::int from staff_aliases a where a.staff_id = s.id) as aliases
    from staff s
    order by lower(s.full_name), s.id
  `;
}

/** One staff member, or null (also for an id that cannot be a staff id). */
export async function getStaffMember(sql: Sql, id: string): Promise<StaffMember | null> {
  if (!isId(id)) return null;
  const [member] = await sql<StaffMember[]>`
    select s.id::text as id, s.full_name as name, s.kind, s.kind_source, s.source, s.active,
      (select count(*)::int from staff_aliases a where a.staff_id = s.id) as aliases
    from staff s where s.id = ${id}
  `;
  return member ?? null;
}

/** Every line name, unmatched first, then by name. */
export async function listStaffAliases(sql: Sql): Promise<StaffAlias[]> {
  const [rows, directory] = await Promise.all([
    sql<(Omit<StaffAlias, "staff" | "suggestions"> & { staffId: string; staffName: string; staffKind: StaffKind; staffSource: StaffSource; staffActive: boolean })[]>`
      select a.id::text as id, a.raw_name, a.match, s.id::text as staff_id, s.full_name as staff_name, s.kind as staff_kind,
        s.source as staff_source, s.active as staff_active
      from staff_aliases a join staff s on s.id = a.staff_id
      order by (a.match = 'unmatched') desc, lower(a.raw_name), a.id
    `,
    staffDirectory(sql),
  ]);
  const names = new Map(directory.map((member) => [member.id, member.name]));
  return rows.map((row) => ({
    id: row.id,
    rawName: row.rawName,
    match: row.match,
    staff: { id: row.staffId, name: row.staffName, kind: row.staffKind, source: row.staffSource, active: row.staffActive },
    suggestions: row.match === "unmatched" ? suggestStaff(row.rawName, directory).map((id) => ({ id, name: names.get(id)! })) : [],
  }));
}

export type StaffChange = { status: "saved" } | { status: "not_found" } | { status: "invalid" };

/**
 * Points a line name at another staff member (the owner's correction): `match` becomes `manual`
 * and no sync changes it again. Every figure follows at once.
 */
export async function remapAlias(sql: Sql, aliasId: string, staffId: string): Promise<StaffChange> {
  if (!isId(aliasId) || !isId(staffId)) return { status: "invalid" };
  return sql.begin(async (tx): Promise<StaffChange> => {
    const [staff] = await tx`select 1 from staff where id = ${staffId}`;
    if (!staff) return { status: "not_found" };
    const [previous] = await tx<{ staffId: string }[]>`select staff_id::text as staff_id from staff_aliases where id = ${aliasId} for update`;
    if (!previous) return { status: "not_found" };
    await tx`update staff_aliases set staff_id = ${staffId}, match = 'manual' where id = ${aliasId}`;
    // Only the two staff members involved can change kind (and never one the owner set).
    await refreshAutoKinds(tx, [previous.staffId, staffId]);
    return { status: "saved" };
  });
}

/** Sets a staff member's kind (the owner's choice: `kind_source` becomes `manual`). */
export async function setStaffKind(sql: Sql, staffId: string, kind: unknown): Promise<StaffChange> {
  if (!isId(staffId) || !isStaffKind(kind)) return { status: "invalid" };
  const updated = await sql`update staff set kind = ${kind}, kind_source = 'manual' where id = ${staffId} returning 1`;
  return updated.length === 0 ? { status: "not_found" } : { status: "saved" };
}

function isId(value: string): boolean {
  return /^[1-9][0-9]{0,17}$/.test(value);
}
