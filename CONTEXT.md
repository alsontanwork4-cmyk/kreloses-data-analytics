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
