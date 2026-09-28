/**
 * Staff names: how a short name on an invoice line ("Dr Alpha") is matched to a full Kreloses
 * staff name ("Dr Alpha Anderson"), and the default kind of a staff member. PURE and
 * deterministic (the same names always give the same answer, whatever order the staff list is in).
 *
 * Matching (spec story 18) compares names as `nameKey` tokens — lower case, accents, punctuation
 * and titles (Dr, Doctor, Mr, Ms, DVM…) removed — in three tiers, stopping at the first tier with
 * any candidate:
 *
 *   1. the whole name is equal ("Dr. Alpha Anderson" = "Dr Alpha Anderson");
 *   2. every line-name token equals a DIFFERENT token of the full name ("Brown", "North General");
 *   3. every line-name token is a prefix of a different token ("Dr A. Anderson", "Dr Alph").
 *
 * Exactly one candidate → `auto`. Several (e.g. "General" with two branch accounts) or none (e.g.
 * a deleted doctor) → `unmatched`, with suggestions for the owner (Settings → Doctors). An
 * unmatched name is still credited — to an "alias only" staff row made from the name itself.
 */

export type StaffKind = "doctor" | "other" | "generic";

export interface StaffCandidate {
  id: string;
  /** The full name as Kreloses lists it. */
  name: string;
}

export type StaffMatch = { match: "auto"; staffId: string } | { match: "unmatched"; suggestions: string[] };

/**
 * The identity of a staff name seen on lines: Unicode-normalised (NFKC), trimmed, inner whitespace
 * collapsed, lower case. "Dr  Alpha" and "DR ALPHA" are one alias; "Dr. Alpha" is another (both
 * match the same staff member).
 */
export function aliasKey(raw: string): string {
  return raw.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Titles and degrees ignored when matching names. */
const TITLES = new Set(["dr", "doctor", "drs", "prof", "mr", "mrs", "ms", "mdm", "miss", "dvm", "bvsc", "bvms", "vmd"]);
/** Any of these on a name makes it a doctor by default. */
const DOCTOR_WORDS = new Set(["dr", "doctor", "drs", "dvm", "bvsc", "bvms", "vmd", "vet"]);
/** Any of these makes it a generic (shared) account by default. */
const GENERIC_WORDS = new Set([
  "general", "admin", "administrator", "reception", "receptionist", "branch", "counter", "frontdesk", "cashier", "clinic", "system",
]);

/** Lower-case words of a name: accents stripped, anything but letters and digits is a separator. */
function words(name: string): string[] {
  return name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function nameTokens(name: string): string[] {
  return words(name).filter((word) => !TITLES.has(word));
}

/**
 * How the matcher reads a name: its words without titles, e.g. "alpha anderson" for
 * "Dr. Alpha Anderson". A name that is only a title keeps its `aliasKey`. Alias-only staff rows are
 * keyed by it, so "Dr Zulu" and "Dr. Zulu" share one.
 */
export function nameKey(name: string): string {
  const tokens = nameTokens(name);
  return tokens.length > 0 ? tokens.join(" ") : aliasKey(name);
}

type Fits = (aliasToken: string, staffToken: string) => boolean;
const equal: Fits = (a, b) => a === b;
const prefix: Fits = (a, b) => b.startsWith(a);

/** Whether every alias token fits a different staff token (a tiny bipartite matching). */
function fitsDistinct(aliasTokens: string[], staffTokens: string[], fits: Fits): boolean {
  const used = new Array<boolean>(staffTokens.length).fill(false);
  const assign = (index: number): boolean => {
    if (index === aliasTokens.length) return true;
    for (let j = 0; j < staffTokens.length; j += 1) {
      if (used[j] || !fits(aliasTokens[index]!, staffTokens[j]!)) continue;
      used[j] = true;
      if (assign(index + 1)) return true;
      used[j] = false;
    }
    return false;
  };
  return assign(0);
}

/** Staff sorted by name (case-insensitive), then id: the order suggestions come in. */
function sorted(staff: readonly StaffCandidate[]): StaffCandidate[] {
  return [...staff].sort((a, b) => {
    const x = a.name.toLowerCase();
    const y = b.name.toLowerCase();
    return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Matches one line name against the Kreloses staff list. See the module comment for the rules. */
export function matchStaffName(raw: string, staff: readonly StaffCandidate[]): StaffMatch {
  const aliasTokens = nameTokens(raw);
  if (aliasTokens.length === 0) return { match: "unmatched", suggestions: [] };
  const candidates = sorted(staff).map((member) => ({ member, tokens: nameTokens(member.name) }));
  const key = aliasTokens.join(" ");

  const tiers: ((candidate: (typeof candidates)[number]) => boolean)[] = [
    (candidate) => candidate.tokens.join(" ") === key,
    (candidate) => fitsDistinct(aliasTokens, candidate.tokens, equal),
    (candidate) => fitsDistinct(aliasTokens, candidate.tokens, prefix),
  ];
  for (const tier of tiers) {
    const found = candidates.filter(tier);
    if (found.length === 1) return { match: "auto", staffId: found[0]!.member.id };
    if (found.length > 1) return { match: "unmatched", suggestions: found.map((candidate) => candidate.member.id) };
  }
  // Nobody fits every part: suggest anyone sharing at least one part of the name.
  const partial = candidates.filter((candidate) => aliasTokens.some((a) => candidate.tokens.some((b) => prefix(a, b))));
  return { match: "unmatched", suggestions: partial.map((candidate) => candidate.member.id) };
}

/** Staff ids to offer for a line name: its match, or the unmatched suggestions. */
export function suggestStaff(raw: string, staff: readonly StaffCandidate[]): string[] {
  const result = matchStaffName(raw, staff);
  return result.match === "auto" ? [result.staffId] : result.suggestions;
}

/**
 * The kind a staff member gets until the owner says otherwise, from all the names known for them
 * (the full name and the names on lines): generic if any name has a shared-account word (general,
 * branch, admin, reception…), else doctor if any has a doctor title or degree (Dr, Doctor, DVM…),
 * else other.
 */
export function defaultStaffKind(names: readonly string[]): StaffKind {
  const all = names.flatMap(words);
  if (all.some((word) => GENERIC_WORDS.has(word))) return "generic";
  if (all.some((word) => DOCTOR_WORDS.has(word))) return "doctor";
  return "other";
}
