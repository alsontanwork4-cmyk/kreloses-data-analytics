# One Kreloses session per connection, enforced by a lease row, not an advisory lock

A sync run, a second sync and a "Test again" must never log in to the same Kreloses account at the
same time (two sessions for one login look suspicious to Kreloses and can invalidate each other).
The obvious tool is a Postgres advisory lock keyed by the connection id, but a session-level
advisory lock belongs to one server connection, and in production `DATABASE_URL` may be Supabase's
transaction pooler (port 6543), which hands a different server connection to each transaction:
the unlock can land on another backend and the lock leaks. A transaction-level lock would need a
transaction held open for the whole run (minutes of network I/O). So each connection has a lease
row in `connection_locks` (`src/connections/lock.ts`): taking it is one atomic
`insert … on conflict do update … where expires_at <= now` statement that works through any pooler,
the holder is a random token so only it can release it, and the lease expires on its own (the sync's
time budget plus a margin) so a crashed function frees the connection. The unique partial index
"one `running` sync run per connection" backs it up in the schema.
