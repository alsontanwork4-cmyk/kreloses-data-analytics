# Kreloses passwords are encrypted in the app with a key from the environment

The sync has to log in to Kreloses as the owner (there is no API or token), so the app must be
able to recover each connection's password; hashing is not an option. We encrypt it in the app
with AES-256-GCM under a 32-byte key from `CREDENTIALS_ENCRYPTION_KEY` (a server-only Vercel
environment variable), rather than using Supabase Vault or pgsodium, so the scheme is plain
Postgres + Node (tests apply migrations to a fresh database, ADR 0001) and a database dump alone
never reveals a password. The stored value is a versioned envelope
`v1.<key id>.<iv>.<tag>.<ciphertext>`; the key id is a fingerprint of the key, so rotating means
adding the old key to the keyring's `previous` list and re-encrypting, and a changed key produces
a clear "encrypted with key X, current key is Y" error instead of a silent failure. Without the
key the app refuses to store or test connections (fail closed).
