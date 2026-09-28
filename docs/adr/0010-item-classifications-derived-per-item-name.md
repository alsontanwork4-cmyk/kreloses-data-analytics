# Item groups are resolved per item name into a derived table, recomputed whenever a rule changes

Every item sold belongs to a service-mix group with surgery / consult / vaccine / dental-scaling /
procedure flags (spec stories 23–26), decided by the owner's rules (exact name or pattern, with a
priority) and per-item assignments. A rule change must change every figure, past periods included,
at once, and ADR 0005 says groups are never copied onto credited lines. Two ways to honour that:
match the rules in SQL inside every revenue query, or classify each distinct item name once and
join the result.

We classify per item NAME into `item_classifications` (item name → group + flags + what decided it)
with ONE implementation of the matcher, the pure `createItemClassifier` in
`src/attribution/item-groups.ts` (the first matching rule decides; a rule may also "leave
unmapped", so a broad pattern such as `surgery %` never guesses a cancellation fee), and join it at
query time in `revenueFacts` (credited line →
`invoice_lines.item_name` → classification). Matching in SQL would need a second implementation of
the precedence rules (assignment → exact → pattern by priority → unmapped) kept equal to the
TypeScript one, and would re-evaluate every pattern on every query; the join is a plain key lookup.
There are only a few thousand distinct names, so recomputing all of them is cheap. (This refines
ADR 0005's note that item rules are "resolved at query time": what each NAME is gets stored; which
lines carry that name — and so every figure — is still resolved at query time.)

The table is derived and kept current by its only writer, `src/items/store.ts`: a rule or
assignment change and the recompute of every name happen in one transaction (so history follows the
change the moment it commits); the transaction that stores an invoice's lines classifies names it
has not seen; each sync run first catches up any name stored without a row (e.g. lines synced
before this table existed). Writers take one transaction-level advisory lock before reading the
rules, so a sync cannot commit a classification computed from rules a concurrent change has just
replaced (a transaction-level lock also works through Supabase's transaction pooler, unlike the
session lock ADR 0004 rejects). A name that has no row anyway counts as `unmapped` in
`revenueFacts`, so its revenue is never lost, only unassigned until the next sync.
