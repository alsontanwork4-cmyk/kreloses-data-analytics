-- History backfill (#8): every connection's Kreloses sales from 1 Jan 2024, loaded month by month
-- (newest first) in small chunks over several nights, and a way for the backfill to step aside
-- when the nightly sync (or Sync now) needs the same Kreloses login.
--
-- Server-only like every app table: RLS on with no policies, API roles revoked.

-- ---------------------------------------------------------------------------------------------
-- 1. One backfill per connection.
--
-- Where each month stands is NOT stored here: a month is done once a sync run of this connection
-- (any kind) read its whole Sale List for dates that include the whole month, and a month the
-- backfill stopped in carries on from that month's latest backfill run's checkpoint (sync_runs).
-- See src/sync/backfill.ts.
create table public.connection_backfills (
  connection_id bigint primary key references public.connections (id) on delete cascade,
  -- active = runs at night (the backfill endpoint) until every month is done; paused = the owner
  -- paused it (it keeps its progress); complete = every month from date_from to date_to is done.
  status text not null
    constraint connection_backfills_status_valid check (status in ('active', 'paused', 'complete')),
  -- The first clinic day loaded (spec: history from 1 Jan 2024).
  date_from date not null default '2024-01-01',
  -- The last clinic day loaded: set by the first chunk that runs (the clinic day it ran), then
  -- fixed. Null = not planned yet (no chunk has run). Later days are the nightly sync's.
  date_to date,
  -- When the backfill was asked for: the connection's first successful login test, or the owner.
  requested_at timestamptz not null default now(),
  -- When its first chunk ran (null = not yet).
  started_at timestamptz,
  paused_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint connection_backfills_dates_ordered check (date_to is null or date_from <= date_to),
  constraint connection_backfills_complete_has_time check ((status = 'complete') = (completed_at is not null)),
  constraint connection_backfills_paused_has_time check ((status = 'paused') = (paused_at is not null)),
  constraint connection_backfills_started_when_planned check ((date_to is null) = (started_at is null))
);

comment on table public.connection_backfills is
  'History backfill per connection (#8): its status and the dates it loads. Month progress is derived from sync_runs (mode backfill + complete runs of any mode).';

create trigger set_updated_at before update on public.connection_backfills
  for each row execute function public.set_updated_at();

alter table public.connection_backfills enable row level security;
revoke all on table public.connection_backfills from anon, authenticated;

-- Connections whose login already works when this migration runs load their history too (a new
-- connection's backfill is asked for by its first successful login test).
insert into public.connection_backfills (connection_id, status)
select id, 'active' from public.connections where status = 'ok'
on conflict (connection_id) do nothing;

-- Backfill progress and "requests used tonight" read a connection's runs by kind and start time.
create index sync_runs_connection_id_mode_started_at_idx on public.sync_runs (connection_id, mode, started_at desc);

-- ---------------------------------------------------------------------------------------------
-- 2. The backfill steps aside for other syncs (docs/adr/0011).
--
-- A backfill run holds the connection's lease like any sync (holder "backfill:…"). When the
-- nightly sync or Sync now finds the connection held by a backfill, it sets yield_requested_at;
-- the backfill run sees it at its next lease renewal (every write), stops cleanly at its next
-- request (partial, with its checkpoint) and releases the lease, which the other sync then takes.
-- Taking the lease clears it.
alter table public.connection_locks add column yield_requested_at timestamptz;

comment on column public.connection_locks.yield_requested_at is
  'Set by a nightly sync or Sync now waiting for a BACKFILL holder: the backfill stops at its next request and releases the lease. Cleared whenever the lease is taken.';
