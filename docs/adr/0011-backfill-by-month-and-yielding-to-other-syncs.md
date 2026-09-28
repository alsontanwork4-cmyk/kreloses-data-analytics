# The history backfill runs month by month and steps aside for other syncs

The history backfill (#8) loads ~35,000 invoice pages over about a week of nights, one small chunk
every 15 minutes (a GitHub Actions schedule: Vercel Hobby allows one cron a day), while the nightly
sync keeps running once a night for the same Kreloses logins.

**Month by month, done = covered by any complete run.** Each chunk runs the ordinary Sync Engine over
one calendar month at a time (newest first), resuming the month's previous backfill run from its page
checkpoint (past months are fixed ranges, so pages do not shift). We store no per-month state: a
month is done once any complete sync run of the connection (backfill, a nightly whose window covered
it, or Sync now) read all its days, derived from `sync_runs`. That makes the backfill skip what the
nightly already read without coordination, keeps "data as of" working per month with no new rules,
and a crash leaves nothing to repair. A single run over the whole 2024→today range would have been
simpler, but "data as of" for any past month would then wait for the whole backfill to finish.

**The backfill yields.** Runs never overlap for one connection (the lease, ADR 0004/0009). If a
backfill chunk held the lease when the nightly cron fired (its time within the hour is not fixed on
Hobby), the nightly would skip that connection for the night. So a backfill takes the lease as a
`backfill:` holder, and the nightly sync or Sync now that finds one sets
`connection_locks.yield_requested_at` and waits (up to 60 s). The backfill sees the flag at its next
lease renewal (every write), stops cleanly before its next Kreloses request (`partial`, checkpoint
kept) and releases the lease. We rejected blocking the backfill around the nightly's hour (couples two
schedules, loses a sixth of the night) and preempting by expiring the lease (the backfill would lose
its fencing guarantee mid-write).

**Budgets are counted in real requests.** The per-night budget is the sum of `counts.requests`
(HTTP requests the run's sessions sent, from `KrelosesSession.requestCount`) over tonight's backfill
runs, so it survives crashes and parallel chunks without a separate counter.
