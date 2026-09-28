/**
 * Turning a branch or doctor typed by a person (or Claude) — an id, a full name, part of it, or
 * the short name on invoice lines — into exactly one id. Pure. Ambiguity is never guessed away:
 * the answer lists the candidates so the caller can ask again precisely.
 */

export interface NamedEntry {
  id: string;
  /** The name shown everywhere (full staff name, branch name). */
  name: string;
  /** Other names it is known by (e.g. the short staff names on invoice lines). */
  otherNames?: string[];
}

export type NameMatch = { ok: true; entry: NamedEntry } | { ok: false; problem: string };

const TITLES: Record<"branch" | "doctor", ReadonlySet<string>> = {
  branch: new Set(),
  doctor: new Set(["dr", "doctor"]),
};

/**
 * In order: an entry whose id is `term`; else the one entry with a name equal to `term` (any case,
 * spacing or punctuation, titles such as "Dr" ignored); else the one entry with a name in which
 * every word of `term` starts a word ("Bravo", "Brav", "south branch"). Otherwise a problem
 * listing the candidates (several) or every entry (none).
 */
export function matchName(term: string, entries: NamedEntry[], kind: "branch" | "doctor"): NameMatch {
  const trimmed = term.trim();
  const byId = entries.find((entry) => entry.id === trimmed);
  if (byId) return { ok: true, entry: byId };

  const titles = TITLES[kind];
  const withoutTitles = (tokens: string[]) => tokens.filter((token) => !titles.has(token));
  const rawTerm = words(trimmed);
  // A title alone ("Dr") is compared as typed, so it fits everyone rather than nobody.
  const keepTitles = withoutTitles(rawTerm).length === 0;
  const termWords = keepTitles ? rawTerm : withoutTitles(rawTerm);
  const nameWords = (entry: NamedEntry) =>
    [entry.name, ...(entry.otherNames ?? [])].map((name) => (keepTitles ? words(name) : withoutTitles(words(name))));

  const label = kind === "branch" ? "Branch" : "Doctor";
  if (termWords.length === 0) return { ok: false, problem: `${label} "${trimmed}" is not a name or an id.` };

  const exact = entries.filter((entry) => nameWords(entry).some((name) => name.join(" ") === termWords.join(" ")));
  if (exact.length === 1) return { ok: true, entry: exact[0]! };
  const partial =
    exact.length > 1
      ? exact
      : entries.filter((entry) => nameWords(entry).some((name) => termWords.every((word) => name.some((candidate) => candidate.startsWith(word)))));
  if (partial.length === 1) return { ok: true, entry: partial[0]! };

  if (partial.length > 1) {
    return { ok: false, problem: `${label} "${trimmed}" matches more than one ${kind}: ${describe(partial)}. Use the full name or the id.` };
  }
  if (entries.length === 0) {
    return { ok: false, problem: `No ${kind} matches "${trimmed}": no ${kind === "branch" ? "branches have been synced" : "doctors are known"} yet.` };
  }
  return { ok: false, problem: `No ${kind} matches "${trimmed}". ${label === "Branch" ? "Branches" : "Doctors"}: ${describe(entries)}.` };
}

/** Lower-case words of a name: letters and digits only, accents dropped ("Dr. Álpha" → ["dr", "alpha"]). */
function words(value: string): string[] {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function describe(entries: NamedEntry[]): string {
  return [...entries]
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id))
    .map((entry) => `${entry.name} (id ${entry.id})`)
    .join(", ");
}
