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
A line item (not a discount line) with the amount it earns: its own amount plus its share of the
invoice's discount lines and of any difference between the lines and the invoice's net amount,
shared in proportion to what each line charged (its amount after any item-level discount; lines
that charged nothing or less take no share; if none charged anything, by quantity × unit price) in
whole sen. An invoice's credited lines add up exactly to its **revenue base** (the net amount of an
active invoice; refunds not deducted). Credited to the staff member its staff name is matched to, or to
**No staff on line** when it names nobody.
_Avoid_: Attributed line, allocation

**Line items not synced yet**:
An active invoice whose line items have not been read since it was last changed (or whose invoice
page could not be opened). Until a sync reads them, its whole revenue base is counted in this group,
so revenue never drops. A doctor filter cannot include it (it is credited to nobody yet); pages say
how many there are.
_Avoid_: Pending (in the UI), unallocated

**Revenue**:
The net amount (after discounts) of active invoices on clinic days in the period, credited line by
line (sum of credited lines, plus invoices whose line items are not synced yet). Refunds are not
deducted; a negative (return) invoice reduces it. For a doctor: the credited lines credited to them.
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

**Change**:
A KPI minus its value in a comparison period; as a percentage, the change ÷ the comparison value,
to one decimal place, and none when the comparison value is zero.

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
are all missing).
_Avoid_: Job, import, refresh

**Data as of**:
For a branch and the period being looked at, when the latest sync run finished that read that
branch's whole sale list (succeeded, or only some invoice pages missing) up to the period's last day (or, if the period ends after the run started, up to the
day the run started). Syncing an older month does not make the current month look fresh. Changes
made in Kreloses after that time are not in the numbers yet.
_Avoid_: Last updated, last refreshed
