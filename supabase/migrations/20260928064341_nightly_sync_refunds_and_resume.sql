-- Nightly sync (#6): refunds in the revenue base, credited lines that keep the pre-refund amount
-- apart from the refund, invoice pages that keep going missing, and resumable run chains.
--
-- Server-only like every app table (RLS on with no policies, API roles revoked) — nothing new here
-- is a table.

-- ---------------------------------------------------------------------------------------------
-- 1. Refunds come off the revenue base (docs/adr/0008; an ASSUMPTION pending live verification).
--
-- The SQL twin of invoiceRevenueBaseSen() / invoiceRefundSen() in src/attribution/credit.ts (a test
-- and a runtime check in saveInvoiceLines keep them equal; change both together): an active
-- invoice's net amount less the part of it refunded, where Kreloses's TotalRefunds is taken to be
-- tax-inclusive like Total, so its net part is total_refunds × net ÷ total, rounded half up to the
-- sen — computed exactly in integer sen with div() — and never more than the net. No deduction when
-- the net, the total or the refunds are not positive (a return sale already has a negative net).
-- Cancelled: 0.
alter table public.invoices drop column revenue_base;
alter table public.invoices add column revenue_base numeric(12, 2) generated always as (
  case
    when status <> 'active' then 0
    when net_amount <= 0 or total_amount <= 0 or total_refunds <= 0 then net_amount
    else net_amount - least(net_amount, div(200 * total_refunds * net_amount + total_amount, 2 * total_amount) / 100)
  end
) stored;

comment on column public.invoices.revenue_base is
  'What the revenue of its credited lines adds up to: active: net_amount less its refunded part (total_refunds × net ÷ total, half up, at most the net); cancelled: 0. Twin of invoiceRevenueBaseSen() in src/attribution/credit.ts.';

-- A credited line keeps what it was charged BEFORE refunds (credited_amount = line_amount +
-- spread_amount: its share of the invoice net; the discount metric uses gross_amount − this) and
-- carries its share of the invoice's refund separately, so a refund never looks like a discount.
alter table public.credited_lines add column refund_amount numeric(12, 2) not null default 0;
-- Existing rows had no refund share; from now on every writer sets it.
alter table public.credited_lines alter column refund_amount drop default;
alter table public.credited_lines add column revenue_amount numeric(12, 2)
  generated always as (credited_amount - refund_amount) stored;

comment on column public.credited_lines.credited_amount is
  'The line''s share of the invoice NET amount, before refunds: line_amount + spread_amount. Discount = gross_amount − credited_amount.';
comment on column public.credited_lines.refund_amount is
  'The line''s share of the invoice''s refund (invoiceRefundSen), spread like the discounts: in proportion to what each line charged. >= 0.';
comment on column public.credited_lines.revenue_amount is
  'credited_amount − refund_amount: what revenue metrics count (revenueFacts.revenue). An invoice''s lines add up to its revenue_base.';
comment on table public.credited_lines is
  'Derived by src/attribution: per non-discount invoice line, the net amount credited to its staff (credited_amount, sums to the invoice net), its refund share and its revenue (sums to the invoice revenue_base).';

-- Credited lines computed before refunds counted no longer add up to their invoice's revenue base:
-- a new header version makes them "line items not synced yet" (counted at the new revenue base
-- meanwhile) and the next nightly sync reads them again (its sweep takes invoices of any date).
update public.invoices set header_version = header_version + 1
where status = 'active' and lines_current and revenue_base <> net_amount;

-- ---------------------------------------------------------------------------------------------
-- 2. Invoice pages that keep going missing.
--
-- How many times in a row the invoice's page could not be opened (HTTP 404/410, or sent elsewhere)
-- for its current header version. Reset when its lines are stored or its header version moves. At
-- MAX_PAGE_MISSING_ATTEMPTS (src/sync/lines.ts) the sync stops trying ("permanently missing",
-- listed on Sync status); the invoice keeps counting at its revenue base as not synced yet.
alter table public.invoices add column detail_missing_count integer not null default 0
  constraint invoices_detail_missing_count_valid check (detail_missing_count >= 0);

-- The nightly sweep: active invoices of any date whose lines are not current, newest first.
create index invoices_lines_pending_idx on public.invoices (sale_at desc, id desc)
  where status = 'active' and not lines_current;

-- ---------------------------------------------------------------------------------------------
-- 3. Resumable run chains.
--
-- A run that carries on from an earlier run's checkpoint (stopped at its time limit, failed or
-- interrupted part-way, a few hours old at most) records which run it continued and when the FIRST
-- run of that chain started: "data as of" for the chain is that start, so pages read by an earlier
-- run never look fresher than they are.
alter table public.sync_runs add column resumed_from_run_id bigint references public.sync_runs (id) on delete set null;
alter table public.sync_runs add column chain_started_at timestamptz;
alter table public.sync_runs add constraint sync_runs_chain_started_before
  check (chain_started_at is null or chain_started_at <= started_at);

create index sync_runs_resumed_from_run_id_idx on public.sync_runs (resumed_from_run_id);

comment on column public.sync_runs.chain_started_at is
  'For a run that resumed an earlier run''s checkpoint: when the first run of the chain started (what "data as of" uses). Null = started fresh.';
comment on column public.sync_runs.checkpoint is
  'Where to carry on: {"nextPage", "pageSize"} and, for nightly runs, {"processedAfter"} (every sale in range newer than this instant is done) / {"listingDone": true} (only the sweep was left). Kept on partial/failed runs.';
