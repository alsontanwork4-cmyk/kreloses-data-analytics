-- Sales sync (#4): what the Sync Engine reads from Kreloses's Sale List, and its run log.
--
--   branches          Kreloses locations seen by a sync
--   customers         Kreloses customers seen on invoices
--   sync_runs         one row per sync run (manual / nightly / backfill), including failures
--   invoices          one row per Kreloses sale (invoice header; line items come in #5)
--   connection_locks  a lease so only one Kreloses session per connection runs at a time
--
-- Kreloses ids (location, customer, sale) are assumed to be unique across every Kreloses login
-- (they are the ids of one Kreloses database), so two connections that see the same branch
-- update the same rows. Kreloses ids are text: their format is Kreloses's business.
--
-- Deleting a connection never deletes synced data (the Connections page promises "Sales already
-- synced are kept"): branches.connection_id and sync_runs.connection_id are set to null, and
-- invoices do not reference connections at all.
--
-- Server-only like every app table: RLS on with no policies, API roles revoked.

create table public.branches (
  id bigint generated always as identity primary key,
  kreloses_location_id text not null
    constraint branches_kreloses_location_id_unique unique
    constraint branches_kreloses_location_id_valid check (char_length(kreloses_location_id) between 1 and 64),
  -- Kreloses's location name, as last seen.
  name text not null constraint branches_name_valid check (char_length(btrim(name)) between 1 and 200),
  -- The connection that last synced this branch (null once that connection is deleted).
  connection_id bigint references public.connections (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index branches_connection_id_idx on public.branches (connection_id);

comment on table public.branches is
  'Clinic branches = Kreloses locations, created by the sync. The global filter''s branch ids are branches.id.';

create trigger set_updated_at before update on public.branches
  for each row execute function public.set_updated_at();

create table public.customers (
  id bigint generated always as identity primary key,
  kreloses_customer_id text not null
    constraint customers_kreloses_customer_id_unique unique
    constraint customers_kreloses_customer_id_valid check (char_length(kreloses_customer_id) between 1 and 64),
  -- Kreloses's customer name (personal data: never logged, never in fixtures).
  name text,
  -- Sale time of the invoice the name was taken from: a name is only replaced by one from a later sale.
  name_seen_at timestamptz,
  -- The clinic day of the earliest synced sale for this customer (active or cancelled).
  first_seen_date date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.customers is 'Kreloses customers (pet owners) seen on synced invoices.';

create trigger set_updated_at before update on public.customers
  for each row execute function public.set_updated_at();

create table public.sync_runs (
  id bigint generated always as identity primary key,
  -- Null once the connection is deleted; connection_label keeps the name for the Sync status page.
  connection_id bigint references public.connections (id) on delete set null,
  connection_label text not null,
  mode text not null constraint sync_runs_mode_valid check (mode in ('nightly', 'backfill', 'manual')),
  -- running → succeeded (the whole range was read) | partial (stopped at the time budget;
  -- `checkpoint` says where to resume) | failed (`error_code` / `error` say why).
  status text not null default 'running'
    constraint sync_runs_status_valid check (status in ('running', 'succeeded', 'partial', 'failed')),
  -- The clinic days this run reads (inclusive).
  date_from date not null,
  date_to date not null,
  started_at timestamptz not null,
  finished_at timestamptz,
  -- {"pages", "invoicesSeen", "inserted", "updated", "unchanged"} (see src/sync/runs.ts).
  counts jsonb not null default '{}'::jsonb
    constraint sync_runs_counts_object check (jsonb_typeof(counts) = 'object'),
  -- Where to carry on: {"nextPage", "pageSize"}; saved after every page, null once finished.
  checkpoint jsonb,
  -- Kreloses location ids this run read completely (set when it succeeds). "Data as of" per
  -- branch is the latest succeeded run covering its location.
  covered_location_ids text[] not null default '{}',
  error_code text
    constraint sync_runs_error_code_valid check (
      error_code in (
        'auth_failed', 'layout_changed', 'rate_limited', 'transient', 'key_problem', 'interrupted', 'internal'
      )
    ),
  error text,
  constraint sync_runs_dates_ordered check (date_from <= date_to),
  constraint sync_runs_finished_matches_status check ((status = 'running') = (finished_at is null)),
  constraint sync_runs_error_matches_status check ((status = 'failed') = (error_code is not null and error is not null)),
  constraint sync_runs_partial_has_checkpoint check (status <> 'partial' or checkpoint is not null)
);

-- At most one running run per connection (the connection lease enforces this first).
create unique index sync_runs_one_running_per_connection on public.sync_runs (connection_id) where status = 'running';
create index sync_runs_connection_id_started_at_idx on public.sync_runs (connection_id, started_at desc);
create index sync_runs_started_at_idx on public.sync_runs (started_at desc);

comment on table public.sync_runs is
  'One row per sync run (manual, nightly, backfill), including failed ones: what it read, counts, errors, checkpoint.';

create table public.invoices (
  id bigint generated always as identity primary key,
  kreloses_sale_id text not null
    constraint invoices_kreloses_sale_id_unique unique
    constraint invoices_kreloses_sale_id_valid check (char_length(kreloses_sale_id) between 1 and 64),
  -- The invoice number people see (Kreloses's SaleName).
  sale_number text,
  branch_id bigint not null references public.branches (id),
  -- Null for a sale without a customer (walk-in).
  customer_id bigint references public.customers (id),
  sale_at timestamptz not null,
  -- The clinic day of the sale. Every date filter uses this, never a UTC date.
  sale_date date not null generated always as ((sale_at at time zone 'Asia/Kuala_Lumpur')::date) stored,
  -- active = counts in revenue; cancelled = cancelled/voided in Kreloses (kept, never counted).
  status text not null constraint invoices_status_valid check (status in ('active', 'cancelled')),
  -- Kreloses's own status label.
  status_name text not null,
  -- Amounts in RM exactly as Kreloses shows them (a return can be negative).
  gross_amount numeric(12, 2) not null,
  discount_amount numeric(12, 2) not null,
  net_amount numeric(12, 2) not null,
  tax_amount numeric(12, 2) not null,
  total_amount numeric(12, 2) not null,
  payment_status text,
  total_payments numeric(12, 2) not null,
  total_refunds numeric(12, 2) not null,
  -- The Sale List row as Kreloses sent it.
  raw_header jsonb not null,
  -- The run that last wrote this row.
  sync_run_id bigint references public.sync_runs (id) on delete set null,
  -- When the header was last written: first read, or re-read with a different value in any of the
  -- columns above. An identical re-read leaves the row (and this) alone.
  fetched_at timestamptz not null,
  -- When the invoice's line items were last read (#5). Needs a (re)fetch when null or older
  -- than fetched_at.
  detail_fetched_at timestamptz,
  created_at timestamptz not null default now()
);

-- The Analytics Service's filters: clinic day and branch, active sales only.
create index invoices_active_sale_date_idx on public.invoices (sale_date, branch_id)
  include (customer_id, net_amount) where status = 'active';
create index invoices_branch_id_sale_date_idx on public.invoices (branch_id, sale_date);
create index invoices_customer_id_idx on public.invoices (customer_id);
create index invoices_sync_run_id_idx on public.invoices (sync_run_id);

comment on table public.invoices is
  'One row per Kreloses sale (invoice header from the Sale List). Revenue counts status = active only.';
comment on column public.invoices.sale_date is 'Clinic-local (Asia/Kuala_Lumpur) calendar day of sale_at.';

-- A lease per connection: whoever holds it (a sync run, a login test) is the only code with a
-- Kreloses session for that login. A plain table rather than a Postgres advisory lock so it works
-- through Supabase's transaction pooler; see docs/adr/0004. An expired lease is free to take.
create table public.connection_locks (
  connection_id bigint primary key references public.connections (id) on delete cascade,
  -- A random token per holder, prefixed with what it is for (e.g. "sync:…", "login-test:…").
  holder text not null,
  acquired_at timestamptz not null,
  expires_at timestamptz not null,
  constraint connection_locks_expiry_after_acquired check (expires_at > acquired_at)
);

comment on table public.connection_locks is
  'Per-connection lease: at most one Kreloses session (sync or login test) per connection at a time.';

alter table public.branches enable row level security;
alter table public.customers enable row level security;
alter table public.sync_runs enable row level security;
alter table public.invoices enable row level security;
alter table public.connection_locks enable row level security;
revoke all on table public.branches, public.customers, public.sync_runs, public.invoices, public.connection_locks
  from anon, authenticated;
