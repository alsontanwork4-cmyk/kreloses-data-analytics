-- Line items and doctor credit (#5): what each invoice's Sale Overview page lists, who is named on
-- each line, and the credited lines every revenue metric is computed from.
--
--   staff           Kreloses staff (from the Sale List filter's Staff options) plus "alias only"
--                   staff created from a line's staff name that matches nobody (e.g. a deleted
--                   doctor). Never deleted: past revenue stays attributed (spec story 22).
--   staff_aliases   Every distinct staff name seen on invoice lines ("Dr Alpha") → one staff row.
--   invoice_lines   The invoice's Items[] exactly as read (discount lines included).
--   credited_lines  Derived by the Attribution & Rules module (src/attribution): one row per
--                   non-discount line with the amount it is credited with, so that an invoice's
--                   credited lines add up EXACTLY to its net amount.
--
-- Who a line is credited to is resolved at QUERY time: credited_lines → staff_aliases.staff_id →
-- staff.kind. Remapping an alias or changing a staff kind therefore changes every figure at once,
-- without re-syncing or re-deriving anything (the credited amounts do not depend on who the staff
-- is). See docs/adr/0005-credited-lines-resolved-at-query-time.md.
--
-- Server-only like every app table: RLS on with no policies, API roles revoked.

create table public.staff (
  id bigint generated always as identity primary key,
  -- Kreloses's full name (source kreloses) or the raw line name it was created from (alias_only).
  full_name text not null constraint staff_full_name_valid check (char_length(btrim(full_name)) between 1 and 200),
  -- The name as the matcher sees it (lower case, no titles or punctuation, e.g. "alpha anderson");
  -- alias_only staff are shared by aliases with the same key ("Dr Zulu", "Dr. Zulu").
  name_key text not null constraint staff_name_key_valid check (char_length(name_key) between 1 and 200),
  -- doctor = ranked on the Doctors page; other = non-doctor staff (nurses…); generic = shared
  -- accounts such as a branch "general" login. Grouped separately, never ranked with doctors.
  kind text not null constraint staff_kind_valid check (kind in ('doctor', 'other', 'generic')),
  -- auto = the sync's guess (src/attribution/staff-names.ts), refreshed as names are seen;
  -- manual = set by the owner (Settings → Doctors), never changed by a sync.
  kind_source text not null default 'auto' constraint staff_kind_source_valid check (kind_source in ('auto', 'manual')),
  -- kreloses = in a Kreloses staff list; alias_only = only ever seen as a name on invoice lines.
  source text not null constraint staff_source_valid check (source in ('kreloses', 'alias_only')),
  kreloses_staff_id text
    constraint staff_kreloses_staff_id_unique unique
    constraint staff_kreloses_staff_id_valid check (char_length(kreloses_staff_id) between 1 and 64),
  -- False once the connection that last listed this staff member stops listing them (disabled or
  -- deleted in Kreloses). Informational: inactive staff keep their revenue and aliases.
  active boolean not null default true,
  -- The connection whose staff list last included this staff member (null once deleted).
  connection_id bigint references public.connections (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint staff_kreloses_id_matches_source check ((source = 'kreloses') = (kreloses_staff_id is not null))
);

create unique index staff_alias_only_name_key_unique on public.staff (name_key) where source = 'alias_only';
create index staff_connection_id_idx on public.staff (connection_id);

comment on table public.staff is
  'Kreloses staff and alias-only staff (names seen on invoice lines that match no staff member). Never deleted.';

create trigger set_updated_at before update on public.staff
  for each row execute function public.set_updated_at();

create table public.staff_aliases (
  id bigint generated always as identity primary key,
  -- The staff name exactly as first seen on an invoice line, e.g. "Dr Alpha".
  raw_name text not null constraint staff_aliases_raw_name_valid check (char_length(btrim(raw_name)) between 1 and 200),
  -- raw_name trimmed, inner whitespace collapsed, lower case: the alias's identity.
  normalised_name text not null
    constraint staff_aliases_normalised_name_unique unique
    constraint staff_aliases_normalised_name_valid check (char_length(normalised_name) between 1 and 200),
  -- Who lines with this name are credited to. Always set: an alias that matches nobody points at
  -- an alias_only staff row made from its own name, so its revenue stays attributed.
  staff_id bigint not null references public.staff (id),
  -- auto = matched by the sync to exactly one Kreloses staff name; manual = set by the owner;
  -- unmatched = no unique match (points at alias-only staff; re-tried on every sync until matched).
  match text not null constraint staff_aliases_match_valid check (match in ('auto', 'manual', 'unmatched')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index staff_aliases_staff_id_idx on public.staff_aliases (staff_id);

comment on table public.staff_aliases is
  'Staff names as written on invoice lines (short forms such as "Dr Alpha") and the staff member each is credited to.';

create trigger set_updated_at before update on public.staff_aliases
  for each row execute function public.set_updated_at();

create table public.invoice_lines (
  id bigint generated always as identity primary key,
  invoice_id bigint not null references public.invoices (id) on delete cascade,
  -- 1-based position in the Sale Overview's Items[].
  line_no integer not null constraint invoice_lines_line_no_valid check (line_no between 1 and 10000),
  item_name text not null,
  -- Kreloses's ItemType: 1 = product, 4 = service, 55 = discount line (others kept as sent).
  item_type integer not null,
  -- Exact decimal (fractional quantities happen: 0.5 tablet, 2.5 ml). Null only on a discount line.
  quantity numeric(12, 4),
  unit_price numeric(12, 2),
  -- The line's charged amount as Kreloses shows it (after any item-level discount).
  amount numeric(12, 2),
  -- The staff name on the line, as sent; null = no staff on the line.
  raw_staff_name text,
  discount_name text,
  -- Item-level discount on this line (0 when none).
  discount_amount numeric(12, 2) not null default 0,
  created_at timestamptz not null default now(),
  constraint invoice_lines_invoice_line_no_unique unique (invoice_id, line_no),
  constraint invoice_lines_values_present
    check (item_type = 55 or (quantity is not null and unit_price is not null and amount is not null))
);

comment on table public.invoice_lines is
  'Line items of an invoice as read from its Kreloses Sale Overview page (model.Items[]), discount lines (item_type 55) included.';

create table public.credited_lines (
  id bigint generated always as identity primary key,
  invoice_id bigint not null references public.invoices (id) on delete cascade,
  -- The non-discount line credited; null for an invoice's "unitemised remainder" (an invoice net
  -- with no non-discount line to spread it over; credited to no staff).
  invoice_line_id bigint constraint credited_lines_invoice_line_unique unique references public.invoice_lines (id) on delete cascade,
  -- The line's staff name (alias) it is credited through; null = "No staff on line".
  staff_alias_id bigint references public.staff_aliases (id),
  -- quantity × unit price, rounded half away from zero to the sen (the spreading weight).
  gross_amount numeric(12, 2) not null,
  -- The line's own charged amount (invoice_lines.amount).
  line_amount numeric(12, 2) not null,
  -- The line's share of the invoice's discount lines and of any gap between its lines and its net
  -- amount, spread in proportion to gross (negative = a discount).
  spread_amount numeric(12, 2) not null,
  -- What the line is credited with: line_amount + spread_amount. An invoice's credited lines sum
  -- to its revenue base (net amount of an active invoice) exactly.
  credited_amount numeric(12, 2) not null,
  constraint credited_lines_sum check (credited_amount = line_amount + spread_amount)
);

create unique index credited_lines_one_remainder_per_invoice on public.credited_lines (invoice_id) where invoice_line_id is null;
create index credited_lines_invoice_id_idx on public.credited_lines (invoice_id);
create index credited_lines_staff_alias_id_idx on public.credited_lines (staff_alias_id);

comment on table public.credited_lines is
  'Derived by src/attribution: per non-discount invoice line, the net amount credited to its staff. Sums to the invoice net exactly.';

-- What the Sale Overview page said besides its lines: Sale, Totals, RefundInfo, CreditNoteInfo
-- (never Customer: personal data the app does not need). Kept so refund handling (#6) can be
-- worked out from stored data.
alter table public.invoices add column raw_detail jsonb;

-- The header's version: 1 when first stored, +1 each time the sync writes a change to a parsed
-- header column (src/sync/store.ts). Compared for equality, never by clock, so two connections
-- syncing the same branch cannot mark lines read for one header current for another.
alter table public.invoices add column header_version integer not null default 1
  constraint invoices_header_version_valid check (header_version >= 1);
-- The header version the stored line items and credited lines were computed from (null = never).
alter table public.invoices add column lines_header_version integer;

-- Whether the stored line items (and credited lines) belong to the header as it is now. False =
-- never read, or the header changed since (the next sync re-reads them); meanwhile the Analytics
-- Service counts the invoice's revenue base as "line items not synced yet" so revenue never drops.
-- THE one definition of "lines are current".
alter table public.invoices add column lines_current boolean
  generated always as (coalesce(lines_header_version = header_version, false)) stored;

-- What the invoice's credited lines add up to — the SQL twin of invoiceRevenueBaseSen()
-- (src/attribution/credit.ts; a test keeps the two equal): the net amount of an active invoice,
-- zero for a cancelled one. Refunds are not deducted (pending live verification, #6). Change both
-- together.
alter table public.invoices add column revenue_base numeric(12, 2)
  generated always as (case when status = 'active' then net_amount else 0 end) stored;

-- The gap monitor: net amount − the sum of ALL line amounts (discount lines included) when the
-- lines were read. Normally 0; anything else is spread over the lines and counted on the run.
alter table public.invoices add column line_gap_amount numeric(12, 2);

comment on column public.invoices.lines_current is
  'Line items read for the current header version. Only then do its credited lines count; otherwise its revenue_base counts as pending.';
comment on column public.invoices.revenue_base is
  'What credited lines add up to (active: net_amount; cancelled: 0). Twin of invoiceRevenueBaseSen() in src/attribution/credit.ts.';

-- Things a run wants the owner to know even though it did not fail: [{"code", "message"}]
-- (src/sync/runs.ts: e.g. invoice pages that could not be opened, an unreadable staff list).
alter table public.sync_runs add column warnings jsonb not null default '[]'::jsonb
  constraint sync_runs_warnings_array check (jsonb_typeof(warnings) = 'array');

alter table public.staff enable row level security;
alter table public.staff_aliases enable row level security;
alter table public.invoice_lines enable row level security;
alter table public.credited_lines enable row level security;
revoke all on table public.staff, public.staff_aliases, public.invoice_lines, public.credited_lines
  from anon, authenticated;
