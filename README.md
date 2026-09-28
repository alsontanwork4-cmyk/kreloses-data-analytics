# Kreloses Data Analytics

A private web app for a two-branch veterinary clinic: a nightly sync of Kreloses (sea.kreloses.com)
sales into Postgres, a doctor revenue / AOV dashboard, and (later) a read-only MCP server over the
same data. The full spec is GitHub issue #1; domain terms are in [`CONTEXT.md`](CONTEXT.md).

**Stack:** Next.js 16 (App Router, TypeScript strict) · Tailwind CSS 4 + shadcn/ui · Supabase
(Postgres + Auth magic links) · `postgres` (postgres.js) for all app data · Vitest · Playwright ·
npm. Clinic time zone: `Asia/Kuala_Lumpur`.

## Run it locally

Prerequisites: Node 22+, npm, Docker, and the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started).

```bash
npm install

# 1. The local Supabase stack. ONE stack per machine, shared by every worktree.
#    Start it if `supabase status` says it is not running. Never `supabase stop`,
#    `supabase db reset` or change ports/project_id in supabase/config.toml: other worktrees use it.
supabase start

# 2. Your own database on that cluster (+ .env.local for this worktree).
echo "OWNER_EMAIL=you@example.com" > .env.local
npm run db:create-dev -- kx_dev_you --env     # creates kx_dev_you, applies migrations,
                                               # seeds OWNER_EMAIL, writes DATABASE_URL and
                                               # the Supabase URL/publishable key to .env.local

# 3. The app.
npm run dev -- --port 3000                     # parallel worktrees: 3000 + issue number
```

Sign in: open <http://localhost:3000>, enter `OWNER_EMAIL`, then open the local mail catcher
(Mailpit) at <http://127.0.0.1:54324> and click the link. Any other email is refused unless it is
on the allow-list (`app_users`).

Re-run `npm run db:create-dev -- kx_dev_you` after pulling new migrations (idempotent), or add
`--reset` to start from an empty database. `npm run db:drop-dev -- kx_dev_you` removes it.

### Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Next.js dev server (pass `-- --port N`) |
| `npm run build` | Production build |
| `npm run typecheck` | Route type generation + `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm test` | Vitest (unit + database tests; needs the local Supabase stack) |
| `npm run test:e2e` | Playwright smoke suite (see [E2E](#e2e-tests)) |
| `npm run db:create-dev -- <kx_name> [--reset] [--env]` | Create/migrate your own dev database |
| `npm run db:drop-dev -- <kx_name>` | Drop it |

### Environment variables

Every variable is listed with placeholders in [`.env.example`](.env.example). Never commit a real
`.env*` file (they are git-ignored).

| Variable | Used for |
| --- | --- |
| `DATABASE_URL` | Direct Postgres for all app data (server only) |
| `DATABASE_PREPARE` | Prepared statements; defaults to `false` on port 6543 (Supabase's transaction pooler), `true` otherwise |
| `DATABASE_POOL_MAX` | Connections per server instance (default 3) |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase API URL (Auth only) |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key (`sb_publishable_…`) |
| `OWNER_EMAIL` | Always on the allow-list as owner (upserted automatically) |
| `DATABASE_ADMIN_URL` | Local tooling only: superuser URL of the local cluster (default `postgresql://postgres:postgres@127.0.0.1:54322/postgres`) |
| `E2E_MAILPIT_URL`, `E2E_PORT` | Local tooling only: e2e overrides |

The app never needs a Supabase secret key today. If a later feature needs admin Auth calls, use
`SUPABASE_SECRET_KEY` (server only, never `NEXT_PUBLIC_`).

## Project layout

Modules follow the spec (issue #1). Create a folder when its first ticket needs it.

```
src/
  app/            Pages and route handlers (thin: no metric maths here)
    (dashboard)/  Signed-in pages; each calls requireUser()/requireRole()
    login/, auth/ Public sign-in flow (magic link request, /auth/confirm, /auth/sign-out)
    api/          Route handlers; each wrapped in withUser()/withRole()
  auth/           Allow-list, roles, session helpers, the proxy gate
  db/             DB client (getDb), connection options, migration runner, test harness
  filters/        The shared global filter (URL <-> {dateFrom, dateTo, branchIds?, doctorIds?})
  components/     shell/ (app shell, nav config, PageShell), filter-bar/, empty-state, ui/ (shadcn)
  kreloses/       Kreloses Reader — the ONLY code that knows Kreloses exists (later)
  sync/           Sync Engine (later)
  attribution/    Attribution & Rules — pure functions (later)
  analytics/      Analytics Service — the single source of every metric (later)
  mcp/            Read-only MCP server (later)
  proxy.ts        Next.js proxy: session refresh + global auth gate
supabase/
  config.toml     Local stack config (shared; don't change ports/project_id)
  migrations/     Timestamped SQL migrations
  templates/      Auth email templates
scripts/          db:create-dev / db:drop-dev
e2e/              Playwright smoke suite
```

Dashboard pages and MCP tools are thin wrappers over the Analytics Service. Never compute a metric
in a React component or an MCP handler.

## Conventions for later tickets

### Auth and access

Supabase Auth (magic link) proves who someone is; the `app_users` allow-list (roles `owner` |
`manager`) decides whether they get in. Only sessions that came from an emailed link count:
`sessionEmail()` (`src/auth/supabase-shared.ts`) verifies the JWT with `getClaims()` and requires
the `amr` claim to contain `otp` (our token-hash link) or `magiclink` (the PKCE fallback). A
password, OAuth or anonymous session for an invited email is treated as signed out — Supabase's
public Auth API would otherwise let someone register a password for an invited email.
Enforcement happens twice:

1. **The proxy** (`src/proxy.ts` → `src/auth/proxy-gate.ts`) runs on every request except static
   files. It refreshes the session cookie and checks the allow-list: anonymous → `/login?next=…`
   (pages) or `401` (API); signed in but not allow-listed → signed out, `/login?error=access-denied`
   or `403`. New pages and API routes are protected automatically. The matcher skips Next.js
   internals and paths ending in a static-file extension (`.svg`, `.png`, `.jpg`, `.jpeg`,
   `.gif`, `.webp`, `.ico`, `.txt`), so a route handler at such a path relies on its in-code
   guard alone.
2. **In code, always** (defence in depth, and to get the role):

| Where | Call | On failure |
| --- | --- | --- |
| Page / layout / Server Action | `const user = await requireUser()` (`@/auth/session`) | redirect to `/login` |
| Owner-only page / action | `const user = await requireRole("owner")` | redirect to `/forbidden` |
| Route handler | `export const GET = withUser(async (request, context, user) => …)` (`@/auth/api`) | `401` / `403` JSON |
| Owner-only route handler | `export const POST = withRole("owner", async (request, context, user) => …)` | `401` / `403` JSON |
| Optional user | `await getCurrentUser()` → `AppUser \| null`; `await getAccess()` → `{status: "anonymous" \| "denied" \| "allowed"}` | — |

`user` is `{ email, role }` (`AppUser` in `@/auth/roles`); `hasRole(user, "owner")` checks a role
(owners pass every check). Allow-list data functions (`findAppUser`, `addAppUser`,
`removeAppUser`, `upsertOwner`, `checkAccess`) live in `@/auth/allow-list` and take a `sql`
connection so they can be tested against a throwaway database.

Public routes are listed in `PUBLIC_PATHS` (`src/auth/paths.ts`): today `/login` and `/auth/*`.
Anything added there (e.g. a future `/api/mcp` with a bearer token, `/api/cron` with a secret) is
the one exception to "wrap every route handler in `withUser`/`withRole`": it must authenticate
itself.

Never redirect to a user-supplied path without `safeNextPath()` (`src/auth/paths.ts`): it refuses
control characters and backslashes (browsers strip tabs/newlines, so `/\t/evil.example` becomes
`//evil.example`), resolves the path, and returns only a same-origin pathname + query.

The owner row is upserted from `OWNER_EMAIL` the first time the server checks access for a
signed-in email (and by `db:create-dev`), so a fresh production database needs no manual seeding.
Changing `OWNER_EMAIL` adds the new owner; it never demotes anyone.

Magic links: the email template (`supabase/templates/magic_link.html`) links straight to
`/auth/confirm?token_hash=…&type=email`, so a link requested on a laptop can be opened on a phone.
`/auth/confirm` also accepts `?code=` (PKCE, same browser only) in case a hosted project still uses
Supabase's default template.

### Database

- App data goes through **`getDb()`** (`@/db/client`, server only) — postgres.js over
  `DATABASE_URL`. Supabase JS is used for Auth only; never read app tables via the Data API.
- `DATABASE_URL` on port 6543 (Supabase's transaction pooler) turns prepared statements off
  automatically (`src/db/env.ts`); `DATABASE_PREPARE` overrides.
- Connection behaviour is defined once in `createSql()` (`src/db/sql.ts`): result columns are
  camelCased (`created_at` → `createdAt`; write SQL in snake_case), `date` columns come back as
  `'YYYY-MM-DD'` strings, `numeric`/`bigint`/`count(*)` come back as strings (cast deliberately,
  e.g. `count(*)::int`), and the session time zone is never relied on — use
  `at time zone 'Asia/Kuala_Lumpur'` explicitly.
- **Money** (RM): columns are `numeric(12,2)`. Sums, discount spreads and other money arithmetic
  happen in SQL (`numeric` is exact); values come back as strings like `'1234.50'`. If JS must do
  money maths, convert to integer sen first (`Math.round(Number(value) * 100)` on a 2-dp string)
  and back at the end. Never do floating-point arithmetic on money. Format for display only at the
  edge (components/CSV).

### Migrations

- New file per change: `supabase migration new <snake_case_name>` →
  `supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql`. A fresh timestamp avoids collisions between
  parallel tickets. **Never edit a migration that is already on `main`.**
- Plain Postgres only. Tests apply every migration to a fresh, empty database, so never reference
  the `auth` or `storage` schemas or Supabase-only extensions. Grants/revokes on the cluster-wide
  roles `anon`, `authenticated`, `service_role` are fine.
- Extensions: install contrib extensions into the `extensions` schema with exactly these two lines,
  which work both in a fresh test database and in hosted Supabase (where the schema already exists):

  ```sql
  create schema if not exists extensions;
  create extension if not exists pg_trgm with schema extensions;
  ```

  The `postgres` role's search_path includes `extensions` locally and on Supabase, so functions
  such as `similarity()` can be called unqualified (covered by `src/db/testing.test.ts`).
- App tables are server-only: `alter table … enable row level security;` with **no policies**, and
  `revoke all on table … from anon, authenticated;` (the Supabase advisor's "RLS enabled, no
  policy" notice is expected). `supabase/config.toml` also turns off auto-exposing new tables.
- Tables with `updated_at` reuse the trigger function from the first migration:
  `create trigger set_updated_at before update on <table> for each row execute function public.set_updated_at();`
- Functions: `set search_path = ''` and schema-qualify names.
- Check your migration: `npm test` (every test database applies all migrations) and
  `npm run db:create-dev -- kx_dev_you`. Don't `supabase db reset/pull/push` the shared stack.

### Tests

- **Vitest** (`npm test`): files named `src/**/*.test.ts`. Write the failing test first. Tests assert
  external behaviour (numbers out for data in), never internal calls or SQL shape.
- **Database tests** use the harness in `src/db/testing.ts` — never the shared `postgres` database:

  ```ts
  import { useTestDatabase } from "@/db/testing";

  describe("…", () => {
    const db = useTestDatabase(); // fresh kx_test_<ts>_<rand> database per file, all migrations applied, dropped afterwards
    it("…", async () => {
      await db.sql`insert into …`;
    });
  });
  ```

  `useTestDatabase()` exposes `sql`, `url` and `name`; `createTestDatabase()` →
  `{ name, url, sql, close() }` gives you one outside the Vitest hooks. Databases are uniquely
  named, so several worktrees can run `npm test` at once. The global setup also drops databases
  that crashed runs left behind — only ones with the exact generated name shape
  (`kx_test_<base36 ms>_<8 hex>`), older than two hours, and with nobody connected; the e2e setup
  does the same for `kx_e2e_*`.
- `server-only` imports are stubbed in Vitest, so server modules can be tested directly.

### E2E tests

`npm run test:e2e` runs the Playwright smoke suite in `e2e/`. One-time per machine:
`npx playwright install --only-shell chromium`. It needs the local Supabase stack and
`.env.local` (for the Supabase URL/publishable key).

Each run is self-contained and parallel-safe: its own database (`kx_e2e_…`, created in global
setup, dropped in teardown), its own `next dev` on a port derived from the worktree path (override
with `E2E_PORT`) building into `.next-e2e/` (so it doesn't disturb your dev server), and unique
synthetic emails. It signs in through the real magic-link flow by reading the email from Mailpit
(`e2e/support/mailpit.ts`, `signIn(page, email)` in `e2e/support/auth.ts`). The owner is
`run.ownerEmail` (seeded by the app from `OWNER_EMAIL`), a manager `run.managerEmail`; use
`withRunDatabase(sql => …)` to put data into the run's database. Nav-driven tests read
`NAV_ITEMS`, so new pages are covered automatically; extend the suite for your ticket's flow.

### Global filter

The one filter every dashboard page and Analytics Service query takes lives in `@/filters`
(safe on server and client):

```ts
interface GlobalFilter { dateFrom: IsoDate; dateTo: IsoDate; branchIds?: string[]; doctorIds?: string[] }
```

- Dates are inclusive, clinic-local calendar dates (`'YYYY-MM-DD'`, Asia/Kuala_Lumpur). Ids are
  strings (the table's primary key as text); absent = all, never an empty array.
- State lives in the URL: `?range=today|this-week|month-to-date|last-month|year-to-date`, or
  `?from=YYYY-MM-DD&to=YYYY-MM-DD` for a custom range, plus `?branch=1,2` and `?doctor=…`.
  No params = month to date, everything. Weeks start on **Monday**; every preset ends today except
  "last month" (the whole previous calendar month).
- In a page: `const { range, filter } = parseFilter(await searchParams);` then pass `filter` to the
  Analytics Service. Other helpers: `serializeFilter(state)`, `mergeFilterIntoSearchParams(current, state)`
  (keeps page-specific params such as `?measure=aov`), `filterSearchParamsOnly(params)`,
  `resolveDatePreset(preset, now)`, `clinicToday(now)`, `formatDateRange(from, to)`.
- Selector options come from `getFilterOptions()` in `@/filters/options` (server only):
  `listBranchOptions()` returns `[]` until the `branches` table exists (#4 replaces its body);
  `listDoctorOptions()` returns `undefined`, which hides the doctor selector — return a list (#5)
  and the selector appears (the slot is already in `filter-bar-controls.tsx`).

### Pages and navigation

- The nav is one list: `NAV_ITEMS` in `src/components/shell/nav-config.ts` (`href`, `label`,
  `icon`, `section: "analytics" | "admin"`, optional minimum `role`). Add one entry per new
  top-level page; the sidebar, mobile menu and e2e tests pick it up. Owner-only entries are hidden
  from managers, but the page must still call `requireRole("owner")`.
- Page template: `const user = await requireUser()`, `const filterState = parseFilter(await searchParams)`,
  then `<PageShell title description filter={filterState}>` (passing `filter` shows the global
  filter bar — analytics pages only — built from the same server-resolved state the page queries
  with, so labels and data never disagree). Pass `filterState.filter` to the Analytics Service.
  Empty states: `<EmptyState>` and `<NoSalesYet user filter what>` in `src/components/empty-state.tsx`.
- Nav links keep the current filter params, so the date range and branch survive page switches.
- Mobile first (the owner checks numbers on a phone): the shell switches to a top bar + slide-in
  menu below `md`, and the e2e suite asserts no horizontal scrolling at phone width.
- UI components: shadcn/ui (`npx shadcn@latest add <component>` → `src/components/ui/`), Tailwind
  utilities, `cn()` from `@/lib/utils`, icons from `lucide-react`.

## Production (not deployed yet)

When a hosted Supabase project and Vercel are set up:

- `DATABASE_URL` = the Supabase pooler URL with `?sslmode=require`; with the transaction pooler
  (port 6543) set `DATABASE_PREPARE=false`. Apply migrations with `supabase db push`.
- Auth → URL configuration: Site URL = the app URL; add `https://<app>/auth/confirm` (and preview
  URLs if needed) to the redirect allow-list.
- Auth → Email templates: set **Magic link** and **Confirm signup** to the body of
  `supabase/templates/magic_link.html` (link `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=email`).
- Use the new API keys (`sb_publishable_…`); JWTs signed with asymmetric keys are verified locally
  by `getClaims()`.
- Set `OWNER_EMAIL`.
- **Confirm email must stay ON in hosted Supabase; never `supabase config push` the local
  `config.toml`.** (Locally it is on too.) The app also refuses non-magic-link sessions, but
  confirmation stops password sign-ups from getting a session at all.

Known limitation: Supabase Auth itself will create an `auth.users` row for any email that calls its
API directly with the publishable key; such users still get no access (the allow-list gate), but a
Supabase "before user created" hook could block them at the source later.

## Troubleshooting

- *"Cannot reach the local Postgres cluster"* — run `supabase start`.
- *"For security purposes, you can only request this after N seconds"* — Supabase rate-limits
  links to the same email; wait and retry.
- `npm install` warns that install scripts are not covered by `allowScripts` — harmless; nothing in
  this project needs them.
