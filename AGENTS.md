# Kreloses Data Analytics

Nightly sync of a veterinary clinic's Kreloses (sea.kreloses.com) sales into Supabase, a doctor revenue / AOV analytics dashboard on Vercel, and a read-only MCP server over the same data. Spec: issue #1.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `alsontanwork4-cmyk/kreloses-data-analytics` (write as the `alsontanwork4-cmyk` account; public repo, so no sensitive data). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root (created lazily). See `docs/agents/domain.md`.

## Codebase conventions

Read `README.md` ("Conventions for later tickets") before coding. In short:

- Local Supabase is ONE shared stack for every worktree: never `supabase stop`, `supabase db reset/pull/push`, or change `supabase/config.toml` ports/project_id. Use your own database (`npm run db:create-dev -- kx_dev_issue<N> --env`) and dev server port (3000 + issue number).
- Every page/Server Action calls `requireUser()` or `requireRole()` (`@/auth/session`); every route handler is wrapped in `withUser()` / `withRole()` (`@/auth/api`).
- App data via `getDb()` (postgres.js); Supabase JS for Auth only. New migration = new timestamped file; plain Postgres; RLS on, no policies.
- DB tests use `useTestDatabase()` (`@/db/testing`), never the shared `postgres` database. Done = `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` and `npm run test:e2e` all green.
- The global filter (`@/filters`) is the only code that reads/writes filter URL params; nav entries live in `src/components/shell/nav-config.ts`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
