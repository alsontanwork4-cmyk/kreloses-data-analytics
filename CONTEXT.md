# Kreloses Data Analytics

Sales analytics for a two-branch veterinary clinic whose point of sale is Kreloses: who earned what,
per doctor and branch, over any period.

## People and access

**Owner**:
The clinic owner; can see everything and manage connections, settings and who may sign in.
_Avoid_: Admin, superuser

**Manager**:
Someone the owner invited to view the dashboard. Cannot manage connections, settings or users.
_Avoid_: Staff, viewer, user (ambiguous with Kreloses staff)

**Allow-list**:
The emails allowed to sign in, each with a role (Owner or Manager). Proving you own an email is not
enough; it must be on the allow-list.
_Avoid_: Whitelist, invite list, users table

**Invite**:
The owner putting an email on the allow-list as a Manager (never as an Owner) and emailing them a
sign-in link. The invite stands even if that email fails to send. Inviting an email already on the
allow-list changes nothing.

**Remove (a manager)**:
Taking a Manager off the allow-list; they are refused from their next request. Owners cannot be
removed this way.
_Avoid_: Revoke, delete user

## Clinic structure

**Branch**:
One physical clinic location; corresponds to a Kreloses location.
_Avoid_: Location, site, outlet, store

**Connection**:
One Kreloses login (email + password) that the app reads sales with. Each branch that has its own
Kreloses login gets one connection; one login may see several branches. The password is stored
encrypted and never shown again.
_Avoid_: Account, integration, credential (the password alone)

**Login test**:
Logging in to Kreloses with a connection and listing the branches it can see. Runs whenever a
connection is saved and on "Test again"; its result is the connection's status (Connected / Login
failed / Not tested).

**Visible branches**:
The Kreloses locations a connection's login could see at its latest login test (none known after a
failed test). "Location" is Kreloses's word; in the product they are branches.

**Staff member**:
Someone (or a shared login) Kreloses can name on an invoice line. Each has a **kind**: *doctor*,
*other staff* (nurses, groomers…) or *generic account* (a shared login such as a branch "general"
account). The app guesses the kind: a "Dr" title on the full name → doctor; else "general",
"branch", "admin", "reception"… in the FULL name → generic; else a "Dr" title on any name on lines
→ doctor; else other. A line name credited to someone never makes them generic. The owner can
change the kind, and a kind the owner set is never changed by the app. Staff members are never
deleted: one Kreloses no longer lists is *inactive* but keeps their history.
_Avoid_: Employee, user

**Doctor**:
A staff member of kind doctor: ranked on the Doctors page and selectable in the global filter.
_Avoid_: Vet, staff (staff also includes non-doctors)

**Staff name (on a line)**:
The short name Kreloses prints on an invoice line ("Dr Ong"). Each distinct name is matched once
to a full staff name: automatically when exactly one staff member fits, or by the owner (Settings
→ Doctors). A name that matches nobody (e.g. a doctor who has left) becomes its own **alias-only**
staff member, so its revenue still counts; the owner can point it at the right person later (and
back to its own entry). Once a name has revenue, a sync never moves it to someone else — a new hire
with a similar name is only *suggested*. Changing a match changes every figure at once, past
periods included.
_Avoid_: Alias (in the UI), doctor name

## Time and filtering

**Clinic day**:
A calendar date in the clinic's time zone (Asia/Kuala_Lumpur). Every date in the product is a clinic
day, never a UTC date.
_Avoid_: UTC date, server date

**Week**:
Monday to Sunday, in clinic days.

**Global filter**:
The selection every dashboard page and Claude question is answered for: a date range (from and to,
inclusive clinic days), optionally narrowed to some branches and some doctors. Absent branches or
doctors means all of them.
_Avoid_: Query params, slicer

**Date preset**:
A named, relative date range: Today, This week, Month to date, Last month (the whole previous
calendar month), Year to date. All except Last month end today. A custom range has explicit dates.
_Avoid_: Period (reserved for comparisons such as "previous period")

**Previous period**:
The same number of clinic days immediately before the selected period (1–30 Sep is compared with
2–31 Aug). Every KPI is compared with it and with the same period last year.

**Same period last year**:
The same calendar dates one year earlier (29 Feb becomes 28 Feb).

**Same weekday last week**:
The clinic day seven days before a day (Sunday 27 Sep 2026 → Sunday 20 Sep 2026). The Daily page
compares each day with it and with the same date last year.

**Same date last year**:
For one day, the same calendar date one year earlier (27 Sep 2026 → 27 Sep 2025, usually another
weekday; 29 Feb → 28 Feb).

## Sales and metrics

Every metric is defined once, in the Analytics Service (`src/analytics`); `METRIC_DEFINITIONS`
there holds the wording the dashboard and Claude show.

**Invoice**:
One Kreloses sale (Kreloses calls it a *sale*; people see its number, e.g. INV-000123). It belongs to
one branch, usually one customer, and has a status.
_Avoid_: Order, transaction, bill

**Active / cancelled**:
An invoice's status. Only active invoices count in any metric; cancelled (or voided) ones are kept
but never counted. Kreloses hides cancelled sales by default, so the sync asks for them explicitly
to notice cancellations.

**Customer**:
The Kreloses customer (the pet owner) on an invoice. A walk-in invoice has no customer.
_Avoid_: Client, patient (the patient is the pet)

**Line item**:
One line of an invoice as Kreloses shows it: item, quantity (may be fractional), unit price, amount
charged (after any item-level discount), the staff name on it, and a discount name/amount. A
**discount line** (Kreloses ItemType 55) is a line that only takes money off the whole invoice.
_Avoid_: Row, item (an item is what is sold; a line is one occurrence of it on an invoice)

**Credited line**:
A line item (not a discount line) with what it was charged and what it earns. Its **credited
amount** is its own amount plus its share of the invoice's discount lines and of any difference
between the lines and the invoice's net amount, shared in proportion to what each line charged (its
amount after any item-level discount; lines that charged nothing or less take no share; if none
charged anything, by quantity × unit price) in whole sen: an invoice's credited amounts add up
exactly to its net amount. Its **refund share** is its part of the invoice's refund, shared the
same way. Its **revenue** = credited amount − refund share: an invoice's revenue adds up exactly to
its **revenue base**. Credited to the staff member its staff name is matched to, or to **No staff on
line** when it names nobody. (Columns: `credited_lines.credited_amount`, `refund_amount`,
`revenue_amount`.)
_Avoid_: Attributed line, allocation

**Refund**:
Money Kreloses records as given back on an invoice (its TotalRefunds). ASSUMED (pending a check
against live Kreloses data, docs/adr/0008) to include tax like the invoice total, so the part of it
that was revenue is refunds × net ÷ total, to the sen, never more than the net. A return sale (a
negative net) already reduces revenue by itself; its refund is not deducted again. A refund is never
a discount: discounts compare gross with the credited amount (before refunds).
_Avoid_: Credit note (Kreloses's own term for one kind of refund document), return (a negative sale)

**Revenue base**:
What an invoice contributes to revenue: its net amount less the refunded part of it (see Refund)
for an active invoice, zero for a cancelled one. An invoice's credited lines' revenue adds up
exactly to it; an invoice whose line items are not synced yet counts it whole.

**Line items not synced yet**:
An active invoice whose line items have not been read since it last changed in a way that can change
them or its revenue (status, gross, discounts, net, tax, total or refunds — not a payment alone), or
whose invoice page could not be opened. Until a sync reads them, its whole revenue base is counted in
this group, so revenue never drops. A doctor filter cannot include it (it is credited to nobody yet);
pages say how many there are.
_Avoid_: Pending (in the UI), unallocated

**Permanently missing invoice page**:
An invoice whose page Kreloses would not open (not found, or sent elsewhere) three syncs in a row.
The sync stops trying (so it neither wastes requests nor fails later syncs) until the invoice is
edited in Kreloses; it stays "line items not synced yet" and is listed on Sync status. A page that
opens but the app cannot read never becomes permanently missing: that is the app's problem (it needs
an update), so the nightly sync keeps trying and reads it once the app can.

**Revenue**:
The revenue base of active invoices on clinic days in the period — their net amount (after
discounts) less the refunded part — credited line by line (sum of credited lines' revenue, plus
invoices whose line items are not synced yet). A negative (return) invoice reduces it. For a doctor:
the revenue of the lines credited to them.
_Avoid_: Sales (ambiguous with invoices), turnover, takings

**Invoices (count)**:
The number of active invoices in the period. For a doctor: invoices with at least one line credited
to them (an invoice shared by two doctors counts for each).

**Customers (count)**:
Distinct customers with at least one active invoice in the period: once overall, and once per branch
in a branch breakdown (a customer who visited both branches counts in each). Walk-ins are not
customers. For a doctor: distinct customers with at least one line credited to them.

**AOV per customer**:
Revenue divided by customers, rounded to the sen. Per branch, the branch's revenue ÷ the branch's
customers; per doctor, the doctor's revenue ÷ the distinct customers with at least one line
credited to them (per branch when split by branch).
_Avoid_: Average order value per invoice (that is revenue ÷ invoices, a different number)

**Items per invoice**:
A doctor's credited lines (sold lines; discount lines excluded, returns included) ÷ their invoices.

**Share of revenue**:
Revenue ÷ ALL revenue in the period and branches (doctors, other staff, generic accounts, no staff
and line items not synced yet together). The doctor filter never changes what it is a share of.

**Doctor ranking**:
Doctors by revenue for the global filter, with AOV per customer, invoices, items per invoice and
share of revenue, optionally split by branch. Other staff, generic accounts, No staff on line and
line items not synced yet are shown as separate groups, never ranked with doctors.

**Discount**:
What a credited line was charged below its price: gross (quantity × unit price, to the sen) minus
what it was credited with (after its own item discount and its share of the invoice's discount
lines and of any gap to the invoice's net). A doctor's discount is the sum over the lines credited to
them, so an invoice discount on a sale with two doctors is shared between them exactly as its
revenue is. Only sold lines count: **return** lines (negative quantity × unit price) are left out of
every discount figure — they already reduce revenue — so an invoice with only returns (or with no
sold line at all, e.g. only a discount line) is left out entirely. Refunds are not discounts. Sales
whose line items are not synced yet have no known gross and are left out (pages say how many).
_Avoid_: Markdown, rebate

**Discount rate**:
Discount ÷ gross (sold lines only), as a percentage; none when gross is zero.

**Discounted invoice**:
For a doctor (or group), an invoice with a line credited to them on which their share of the
discount is over RM 0.05 (exactly 5 sen is not). **Share of invoices discounted** = their discounted
invoices ÷ their invoices.

**Discount type**:
A discount name as used on sales: an **item discount** (on one line, e.g. "10% DISCOUNT") or a
**discount line** (on the whole invoice, e.g. "RM50 LOYALTY"); names that differ only in case or
whitespace are one type ("5%DISCOUNT" = "5% discount"). Whatever else the lines differ from the
invoice's net by, with no discount line saying why, shows as the **other difference to the invoice
net** (it can be negative), so the types add up to the total discount.
_Avoid_: Promo, coupon (Kreloses may call them vouchers; the name is shown as written)

**Monthly trend**:
A doctor's figure (revenue or AOV per customer; surgery and consult revenue once items are grouped)
for each clinic calendar month the date range overlaps, up to the current month. AOV per customer in
a month counts that month's customers only.

**Partial month**:
A month whose figures do not cover all of it: the current month (so far), or a month the date range
starts or ends inside.

**Year on year**:
A doctor's revenue and AOV per customer per calendar year, per branch, from the first year with
sales to the current one, whatever the date range. Each whole year is compared with the previous
year; the current year (1 January to today) with the same dates last year, never with a whole year.

**Doctor detail**:
One doctor's page: their ranking figures for the global filter, their monthly trend and their
branch split. Only doctors have one; other staff and generic accounts do not.

**Daily sales**:
One clinic day's revenue, invoices, customers and AOV per customer — in total, per branch and per
doctor (other staff, generic accounts, no staff on line and line items not synced yet as separate
groups) — each compared with the same weekday last week and the same date last year. The Daily page
shows yesterday by default (the clinic's yesterday); the global filter's branches and doctors apply,
its date range does not.
_Avoid_: Daily report, day summary

**Change**:
A KPI minus its value in a comparison period; as a percentage, the change ÷ the comparison value,
to one decimal place, and none when the comparison value is zero.

**Sales search**:
Finding individual active invoices in the global filter's period, branches and doctors by customer
name, item name and amount. Each one shows its revenue (net amount) and its credits: that revenue
split by who each line is credited to. With a doctor filter an invoice is found when at least one
of its lines is credited to one of those doctors, and it is still shown whole.
_Avoid_: Transaction search, order lookup

## Items and service mix

**Item**:
What is sold on a line (a service or a product), identified by its name ignoring case, extra spaces
and Unicode width ("Consultation" and "CONSULTATION " are one item). Discount lines are not items.
_Avoid_: Product (only ItemType 1 is a product), SKU

**Service-mix group**:
One of eight groups every item belongs to: Consult, Surgery, Diagnostics, Hospital & treatment,
Rehab & TCVM, Medicines & supplements, Preventive, Retail & other. An item may also carry flags:
*surgery*, *consult*, *vaccine*, *dental scaling* and *operation* (procedure).
_Avoid_: Category (Kreloses's invoice category is something else), department

**Item rule**:
An exact item name or a pattern (SQL ILIKE style: `%` any characters, `_` one character) with a
group, flags and a priority. Exact rules are tried first, then patterns, each highest priority
first (ties: the older rule); the first rule that matches decides. A rule can also *leave
matching items unmapped* (e.g. cancellation fees), so no broader rule guesses them. The app ships
starting rules built from the spec's surgery and consult definitions and common veterinary item
names — NOT the owner's original hand-built rules, which were not available; the owner reconciles
them in Settings → Items.

**Item assignment**:
The owner's group and flags for one item (Settings → Items). It beats every rule.
_Avoid_: Override, mapping

**Unmapped**:
An item no assignment or rule recognises; its revenue shows in its own "Unmapped" bucket and the
item is listed in Settings → Items (by revenue) until the owner assigns it. The starting rules are
deliberately conservative: an unknown item stays unmapped rather than being guessed into a group.

**Surgery line / consult line**:
A credited line whose item has the surgery / consult flag. Surgery: the SURGERY service, neutering
and spay, cryoablation, cystotomy, tooth extraction, pyometra, C-section, FHO, hernia repair, closed
reduction, wound stitching, anaesthesia / sedation and related surgical charges. Consult:
CONSULTATION services and the TCVM examination (grouped under Consult).

**Operation (procedure)**:
A surgery line that is an actual operation. A sedation or anaesthesia charge is a surgery line but
not an operation (also when it is for something else, e.g. "Sedation for X-ray"), so a surgery case
with only such lines is "sedation only". Post-op visits (follow-up, recheck, wound check) are
consult lines, not surgery. A dental scaling done under anaesthesia, sold as one item, is dental
scaling (Preventive), not a surgery line; a separate anaesthesia line on the same invoice is.

**Surgery revenue / consult revenue**:
Revenue of surgery lines / consult lines. Line items not synced yet are in neither.

**Surgery case**:
An active sale (line items synced) with at least one sold surgery line; a returned surgery line
never makes one. It belongs to the sale's branch and counts for every doctor with a sold surgery
line on it (a case shared by two doctors counts once for each, and once in the totals). It is an
*operation* when any of its sold lines is an operation (procedure), whoever it is credited to;
otherwise it is **sedation only**. Sales whose line items are not synced yet are not cases until a
sync reads them.
_Avoid_: Surgery, procedure (for the whole case), operation (for a sedation-only case)

**Surgery fee / whole-visit value**:
A case's surgery fee is the revenue of its surgery lines (for a doctor: their own surgery lines on
it); its whole-visit value is the revenue of the whole sale, every line and whoever it is credited
to. Averages are per case. Surgery fees are not surgery revenue: a surgery item returned on a later
sale lowers surgery revenue but never the fee of the case it was sold on.
_Avoid_: Surgery revenue (for the fees of cases)

**Top procedures**:
Operation items by the fees of their lines on the cases they were sold on, with those cases and the
average fee per case — overall and per doctor.

**Post-op follow-up (within 14 days)**:
A surgery case whose customer had another service visit (any doctor, any branch) 1–14 days after the
case's day; a second visit the same day is not one. A case is *not yet mature* — left out of the rate
and counted separately — until its 14 days have passed in the synced sales; walk-in cases cannot be
followed up and are left out too.
_Avoid_: Recheck rate, post-op visit (a post-op visit item is a consult line)

**Vaccine revenue / dental-scaling revenue**:
Revenue of lines whose item is a vaccination / dental scaling, per doctor, and as a share of the
doctor's revenue.

**Service mix**:
Revenue split by the service-mix group of each credited line's item. Every credited sen is in
exactly one bucket: a group, Unmapped, "No item on invoice" (an invoice amount with no sold line) or
Line items not synced yet — so the groups add up to revenue.

**Clinic average (mix)**:
The service mix of all doctors together (revenue-weighted) in the period and branches; the doctor
filter never changes it. A doctor's group share is *above* / *below* it when it differs by 5.0
percentage points or more, otherwise *in line*.

**Working day**:
A clinic day with at least one consult or surgery line credited to the doctor, at either branch (a
consult at one branch and a surgery at the other the same day is one working day). The branch
filter never removes working days.

**Revenue per working day**:
A doctor's revenue in the period (and selected branches) divided by their working days at any
branch, rounded to the sen. With one branch selected: that branch's revenue per day worked
anywhere, so the branches' figures add up to the total.

## Upsell

**Consult invoice**:
For a doctor, an active invoice in the period with at least one consult line credited to them (sold:
quantity above zero, so a free consult counts and a returned one does not). An invoice with consult
lines of two doctors is a consult invoice of each. An unmapped item is never a consult line, whatever
its name, so it never makes a consult invoice until the owner maps it as a consult (Settings → Items;
past periods follow at once). Sales whose line items are not synced yet cannot be classified and are
left out (pages say how many).
_Avoid_: Consultation (that is the item), visit (see Service visit)

**Add-on**:
A line on a consult invoice that is not a consult line and charged more than zero (its own amount,
after any item discount): a free add-on, a returned item or a discount line never counts, while one
whose credited amount an invoice discount took to zero still does. Kinds: *diagnostics* (an item in
the Diagnostics group), *product* (Kreloses item type product) and *second service* (a service other
than a consult). The kinds overlap: an X-ray service is diagnostics and a second service. An unmapped
item counts as a product or second service by its item type but never as diagnostics, so the rates
move when the owner maps items in Settings → Items.
_Avoid_: Upsell item, extra

**Attach rate**:
The share of a doctor's consult invoices with at least one add-on of a kind (or of any kind), to one
decimal. Counted on the **whole invoice** by default — add-ons credited to anyone, the visit's
basket — or on the **doctor's own lines** only. **All doctors** pools every doctor's consult invoices
(an invoice with two consulting doctors counts for each); the doctor filter never changes it.
_Avoid_: Conversion rate, upsell rate

**Items per invoice over time**:
A doctor's items per invoice (see Items per invoice) per calendar month of clinic days, partial months
flagged as in a Monthly trend.

## Syncing

**Sync run**:
One pass of the sync for one connection over a range of clinic days: reads the Kreloses sale list
and stores its invoices, branches and customers, then reads the line items of every new or changed
active invoice (and the staff list). Every run is logged, with its counts (invoices
read / new / changed / unchanged, line items read, invoice pages missing, invoices whose lines do
not add up to their net) and, if it failed, why; warnings (e.g. an unreadable staff list) are
recorded too. Kinds: *Sync now* (manual, one month chosen by the owner), *nightly* and *history
backfill* (later). Outcomes: succeeded; stopped early (hit its time limit; it records where it got
to); *some invoice pages missing* (read everything else; those sales stay "line items not synced
yet" and the next sync tries again); or failed (including when the first few invoice pages it tries
for the first time are all missing — pages already missing in earlier syncs do not count).
_Avoid_: Job, import, refresh

**Nightly sync**:
The sync the app runs by itself once a night (about 03:00 Kuala Lumpur time) for every connection,
failing ones included (a fixed login recovers by itself). It re-reads the sale list for the
**nightly window** — the last 45 days up to today, cancelled sales included — and opens the invoice
pages only of new sales and of sales that changed in a way that can change their line items or
revenue (so edits, cancellations and refunds are picked up; a sale that was merely paid costs no
extra request). Then it **sweeps**: reads, newest first and while its time lasts, the line items of
any older active sales still "not synced yet" — only of the branches that connection's own login
can see. An older sale whose page cannot be opened or read is skipped with a warning (it never fails
the night; the two are counted apart); only a new or changed sale in the window that cannot be read
fails it (Kreloses changed).
_Avoid_: Cron job, scheduled import

**Carrying on (a stopped sync)**:
A sync that stopped part-way — at its time limit, on an error, or because the server died — leaves
a checkpoint; the next sync of the same kind (nightly; or Sync now of the same month) within a few
hours carries on from it instead of starting over, and nothing is counted twice. Nightly syncs
remember "every sale newer than this moment is done" rather than a page number, because pages of a
newest-first list shift as sales are added or removed. A chain of such runs is only as fresh as its
first run's start. With one nightly sync a day, a stopped nightly is never carried on by the next
night's (more than a few hours later): that one starts afresh, and change detection means it only
opens what the stopped one did not get to.

**Sync alert**:
The banner on every page of the dashboard, for everyone signed in, while a connection's login fails,
or its latest nightly sync failed and no sync since (nightly or Sync now) has worked, with the last
error in plain words. A Sync now that fails too does not hide it. The owner gets a link to
Connections. It goes away by itself once a login or a later sync works.
_Avoid_: Notification, toast

**Data as of**:
For a branch and the period being looked at, when the latest sync run finished that read that
branch's whole sale list (succeeded, or only some invoice pages missing) up to the period's last day (or, if the period ends after the run started, up to the
day the run started). A sync that carried on from an earlier one counts from when the first of them
started. Syncing an older month does not make the current month look fresh. Changes made in
Kreloses after that time are not in the numbers yet.
_Avoid_: Last updated, last refreshed

## Claude (MCP)

**MCP server**:
The read-only connection Claude uses to answer questions about the clinic's sales: a URL on the same
deployment plus the MCP token. Its tools return exactly the dashboard's numbers, with the same
definitions, and every answer states the data as of per branch. It never changes data and never
contacts Kreloses.
_Avoid_: API, bot, integration

**MCP token**:
The one secret (`MCP_BEARER_TOKEN`) that opens the MCP server. Whoever holds it can read all clinic
data the dashboard shows, so it is handled like a password. Replacing it (and redeploying) locks the
old one out of the new deployment; older deployments still hold the old token, so they must stay
unreachable (Vercel Deployment Protection on, or deleted).
_Avoid_: API key, password (the Kreloses password is a different thing)

## Retention

**Service visit**:
A customer on a clinic day with at least one sold service line (Kreloses item type "service",
quantity above zero) on an active sale whose line items are synced. Several service lines or
sales on one day are one visit. Products, discount lines, returned lines, cancelled sales, walk-ins
and sales whose line items are not synced yet never make a visit. A visit counts for every doctor
credited with one of its service lines; a visit whose service lines are credited only to other
staff, a generic account or no staff still counts for the whole clinic and as a return.
_Avoid_: Appointment, consultation (a visit need not include a consult), encounter

**Retention and the filters**:
The branch filter decides which visits put a customer in a period or cohort; whether they are new,
came back, or returned within 90 days is judged across all branches (a customer who moves branch
is neither new nor lost). The doctor filter only chooses which doctors are listed; whole-clinic
figures and "any doctor" never depend on it.

**New / returning customer**:
Among the customers a doctor saw for a service visit in a period: *new* if their first service
visit in the synced history (any doctor, any branch) falls in the period, otherwise *returning*.
The synced history starts at the earliest synced sale, so "new" is approximate for periods starting
less than 90 days after it.

**Yearly cohort**:
A doctor's cohort for year Y: the customers with a service visit attributed to that doctor in
calendar year Y. *Retained (any doctor)*: any service visit in Y+1; *retained (same doctor)*: a
service visit attributed to the same doctor in Y+1. A cohort is *still accruing* until the synced
sales (any branch) reach 31 December of Y+1, and a *partial year* when the synced sales at the
selected branches start after 7 January of Y (a start in the first week of January counts as a
full year).
_Avoid_: Retention rate (without saying any/same doctor)

**90-day return rate**:
Of a doctor's service visits in a period, the share followed by another service visit of the same
customer (any doctor, any branch) 1–90 days later. A visit is *not yet mature* — left out and
counted separately — until its 90 days have passed in the synced sales.

**Synced through**:
The latest clinic day with a synced sale at any branch (whatever the branch filter); returns and
cohorts are only seen up to it.
_Avoid_: Data as of (that is when a sync ran, per branch)
