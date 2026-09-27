# Direct Postgres for app data; Supabase JS only for Auth

The app reads and writes all of its own tables with postgres.js over `DATABASE_URL`, server-side
only, and uses `@supabase/ssr` / `@supabase/supabase-js` solely for Auth (magic links and session
cookies). The Sync Engine and Analytics Service are dominated by heavy SQL aggregates and
transactional upserts that the Supabase Data API (PostgREST) expresses poorly, and nothing needs
browser-side data access. As a consequence, app tables are server-only: RLS is enabled with no
policies, the `anon`/`authenticated` roles are revoked, and `auto_expose_new_tables` is off.
Migrations must stay plain Postgres so tests can apply them to a fresh throwaway database.
