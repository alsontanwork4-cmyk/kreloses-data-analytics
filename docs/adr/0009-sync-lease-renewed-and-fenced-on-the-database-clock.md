# The sync lease is renewed with every write and fenced, on the database clock

ADR 0004 made the per-connection lease a row in `connection_locks` that expires on its own. Its
first version relied on the TTL (time budget + 2 min) outliving Vercel killing the function, and
judged expiry by each server's clock. Two failure modes remained: a run that goes on longer than its
TTL (slow requests, retries, a larger `maxDuration`) keeps writing after a second run took the
connection over, and servers with skewed clocks disagree about expiry.

Since #6 every write of a sync run happens in a transaction that first renews the lease
(`renewConnectionLease`: `update … set expires_at = now() + ttl where holder = <this run>`); if
the row no longer names this run as holder, the transaction is aborted and the run stops at once
without writing anything more (fencing), only marking its own run row interrupted if nobody else did.
Expiry is always `now()` of the database, never a server's `Date`. With renewals, the TTL is a short
fixed 4 minutes — longer than the longest stretch without a write (one Kreloses request with its
retries) — so a crashed run frees its connection within minutes instead of after its whole budget.
A lease that expired but was not taken over can still be renewed by its holder (nobody else wrote).

The run row itself carries no heartbeat: holding the lease is the proof a run is alive, and the next
run of the connection marks older `running` rows interrupted as soon as it takes the lease, then
carries on from their checkpoint.
