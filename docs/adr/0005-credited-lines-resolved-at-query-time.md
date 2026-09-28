# Credited amounts are stored; who they are credited to is resolved at query time

Revenue is credited per invoice line (spec: Attribution & Rules). Two things decide a figure: the
amount each line earns (its own amount plus its share of discount lines and of any gap to the
invoice net, spread by gross) and who the line belongs to (the short staff name on it → a staff
member → that member's kind). The owner can remap a name or change a kind at any time, and every
figure — past periods included — must follow at once without re-syncing (spec stories 19, 26).

We store the amounts and resolve the people at query time. `credited_lines` holds, per line, the
credited amount and the staff *name* it came from (`staff_alias_id`), derived once per invoice read
by the pure `creditInvoice` in the same transaction as the lines. The Analytics Service's one fact
source (`revenueFacts`) joins `credited_lines → staff_aliases.staff_id → staff.kind` on every query,
so a remap or a kind change is a single-row update that every figure reflects immediately. This
works because the amounts do not depend on who the staff is (the spread is by gross, per invoice).
The alternative — writing `staff_id`/`kind` onto credited lines and re-deriving them on every remap
— would duplicate the mapping, need a bulk rewrite inside the remap transaction and risk drift;
the join over a few hundred thousand lines is cheap for this app's size. Item groups and service
flags (#9) follow the same rule: rules are resolved at query time, never copied onto the lines.

An active invoice whose lines are missing or older than its header (`invoices.lines_current`
false) counts its net amount as one "line items not synced yet" row in `revenueFacts`, so revenue
never drops between a header sync and its line-item sync, and credited lines always reconcile with
the invoice nets they were computed from.
