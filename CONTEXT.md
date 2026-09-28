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

**Doctor**:
A vet whose name appears on invoice lines and who is credited with revenue.
_Avoid_: Vet, staff (staff also includes non-doctors)

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

**Revenue**:
The net amount (after discounts) of active invoices on clinic days in the period. Refunds are not
deducted; a negative (return) invoice reduces it. Until line items are synced (#5) it is the
invoice's net amount; afterwards it is the sum of credited lines, which add up to the same total.
_Avoid_: Sales (ambiguous with invoices), turnover, takings

**Invoices (count)**:
The number of active invoices in the period.

**Customers (count)**:
Distinct customers with at least one active invoice in the period: once overall, and once per branch
in a branch breakdown (a customer who visited both branches counts in each). Walk-ins are not
customers.

**AOV per customer**:
Revenue divided by customers, rounded to the sen. Per branch, the branch's revenue ÷ the branch's
customers; per doctor (later), the doctor's revenue ÷ the customers they billed.
_Avoid_: Average order value per invoice (that is revenue ÷ invoices, a different number)

**Change**:
A KPI minus its value in a comparison period; as a percentage, the change ÷ the comparison value,
to one decimal place, and none when the comparison value is zero.

## Syncing

**Sync run**:
One pass of the sync for one connection over a range of clinic days: reads the Kreloses sale list
and stores its invoices, branches and customers. Every run is logged, with its counts (invoices
read / new / changed / unchanged) and, if it failed, why. Kinds: *Sync now* (manual, one month
chosen by the owner), *nightly* and *history backfill* (later). Outcomes: succeeded, stopped early
(hit its time limit; it records where it got to) or failed.
_Avoid_: Job, import, refresh

**Data as of**:
For a branch and the period being looked at, when the latest successful sync run finished that read
that branch up to the period's last day (or, if the period ends after the run started, up to the
day the run started). Syncing an older month does not make the current month look fresh. Changes
made in Kreloses after that time are not in the numbers yet.
_Avoid_: Last updated, last refreshed
