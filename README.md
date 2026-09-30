# Kreloses Data Analytics

A private web app for a two-branch veterinary clinic: a nightly sync of Kreloses (sea.kreloses.com)
sales into Postgres, a doctor revenue / AOV dashboard, and a read-only MCP server over the same
data ([Connect Claude to the MCP server](#connect-claude-to-the-mcp-server)). The full spec is
GitHub issue #1; domain terms are in [`CONTEXT.md`](CONTEXT.md).

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
on the allow-list (`app_users`); invite managers from Settings → Users.

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
| `npm run test:live` | Opt-in smoke test against the REAL Kreloses; skipped unless test credentials are set (see [Live login check](#live-login-check-real-kreloses)) |
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
| `CREDENTIALS_ENCRYPTION_KEY` | Server only. 32 random bytes, base64 (`openssl rand -base64 32`): encrypts Kreloses passwords at rest. Required to save or test a connection; `db:create-dev --env` generates a local one. Changing it makes stored passwords unreadable (re-enter them) |
| `DATABASE_ADMIN_URL` | Local tooling only: superuser URL of the local cluster (default `postgresql://postgres:postgres@127.0.0.1:54322/postgres`) |
| `E2E_MAILPIT_URL`, `E2E_PORT`, `E2E_KRELOSES_PORT` | Local tooling only: e2e overrides |
| `KRELOSES_BASE_URL_WWW`, `KRELOSES_BASE_URL_SEA` | Tests only: point the Kreloses Reader at a local fake (the e2e suite sets them). Refused in production and must be a loopback URL |
| `KRELOSES_TEST_EMAIL`, `KRELOSES_TEST_PASSWORD`, `KRELOSES_TEST_SESSION_PROBE_MINUTES`, `KRELOSES_TEST_MONTH` | Local only: credentials (and options) for `npm run test:live`. Never commit them |
| `SYNC_TIME_BUDGET_SECONDS` | Optional: time budget of one sync invocation (10–280 s, default 200). Keep it well under the function limit (`maxDuration = 300` on the Connections page and the cron route). The nightly cron shares 250 s between all connections, each capped at this |
| `SYNC_NIGHTLY_WINDOW_DAYS` | Optional: how many days back the nightly sync re-reads the Sale List to notice edits, cancellations and refunds (1–366, default 45) |
| `CRON_SECRET` | Server only, **required for the nightly sync and the history backfill**: at least 16 random characters (`openssl rand -hex 32`). Vercel Cron sends it as `Authorization: Bearer …` to `/api/cron/nightly`, the backfill workflow to `/api/cron/backfill`; without it (or with a shorter one) both endpoints refuse every request |
| `BACKFILL_REQUEST_DELAY_SECONDS` | Optional: the history backfill's pause between two Kreloses requests of a login (0.5–30, default 2; the nightly sync's is 1) — see [History backfill](#history-backfill-8) |
| `BACKFILL_MAX_REQUESTS_PER_NIGHT` | Optional: Kreloses requests one login's backfill may send per night (50–50,000, default 2,500) |
| `BACKFILL_NIGHT_WINDOW` | Optional: `HH:MM-HH:MM` in Kuala Lumpur time (default `00:00-06:00`; may wrap past midnight); outside it the backfill endpoint does nothing. Keep `.github/workflows/backfill.yml`'s schedule (UTC) inside it |
| `CLINIC_NOW` | Tests only: freezes `clinicNow()` — "today" for the Daily page, the MCP server and the history backfill's night window (e.g. `2026-09-28T09:00:00+08:00`; the e2e suite sets it). Ignored when `NODE_ENV` or `VERCEL_ENV` is `production` |
| `MCP_BEARER_TOKEN` | Server only. The secret Claude sends to the MCP server (`openssl rand -base64 32`; at least 32 characters). Unset, blank or shorter → `/api/mcp` refuses every request. It grants read access to ALL clinic data: treat it like a password (see [Connect Claude](#connect-claude-to-the-mcp-server)) |

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
  auth/           Allow-list (+ inviting/removing managers), roles, session helpers, sign-in
                  emails, the proxy gate
  db/             DB client (getDb), connection options, migration runner, test harness
  filters/        The shared global filter (URL <-> {dateFrom, dateTo, branchIds?, doctorIds?})
  components/     shell/ (app shell, nav config, PageShell), settings/ (tabs, SettingsSection),
                  filter-bar/, data-table/ (THE table + CSV export), charts/ (chart convention),
                  empty-state, ui/ (shadcn)
  kreloses/       Kreloses Reader — the ONLY code that knows Kreloses exists (login, locations,
                  sale list, invoice pages, staff; __fixtures__/ synthetic responses, testing/ the fake)
  connections/    Kreloses connections: encrypted credentials, login test, store
  sync/           Sync Engine: Sale List → invoices/branches/customers, line items → credited
                  lines, sync_runs log, lease
  attribution/    Attribution & Rules — PURE functions: crediting lines, staff-name matching, item
                  groups (item name → service-mix group + flags)
  staff/          Staff directory + staff names on lines (aliases): matching, remap, kinds
  items/          Item groups: rules, the owner's assignments, derived classifications (#9)
  analytics/      Analytics Service — the single source of every metric (Overview KPIs, doctor
                  ranking, freshness, service mix, surgery / consult, working days)
  lib/            money (exact RM strings ↔ integer sen, display), format (display only)
  mcp/            Read-only MCP server (/api/mcp): bearer-token check, stateless Streamable HTTP
                  handler, tools/ (one file per tool + the registry)
  proxy.ts        Next.js proxy: session refresh + global auth gate
supabase/
  config.toml     Local stack config (shared; don't change ports/project_id)
  migrations/     Timestamped SQL migrations
  templates/      Auth email templates
scripts/          db:create-dev / db:drop-dev
e2e/              Playwright smoke suite
.github/workflows backfill.yml: the history backfill's night-time trigger (inert until the owner opts in)
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
`removeAppUser`, `upsertOwner`, `checkAccess`, `listAllowList`, `recordSignIn`, plus
`normaliseEmail` / `isValidEmail`) live in `@/auth/allow-list` and take a `sql` connection so they
can be tested against a throwaway database.

**Managing the allow-list** (Settings → Users, owner only) goes through `@/auth/managers`:
`inviteManager({ sql, actor, sendSignInLink }, email)` and
`removeManager({ sql, actor, ownerEmail }, email)`. `actor` is the caller's `Access`; both refuse
anyone but an owner themselves (`{ status: "forbidden" }`), so they are safe even if a caller's
own guard is missing. Rules: an invite only ever adds a **manager** (an email already on the list
is left alone, so owners are never demoted); only managers can be removed — never yourself, the
`OWNER_EMAIL` owner or any other owner. A removed manager is refused on their next request (the
proxy re-checks the allow-list, ADR 0002); their Supabase session is not revoked, it just stops
working. `app_users.invited_by` records the inviting owner and `app_users.last_sign_in_at` is set
by `/auth/confirm` each time a magic link is opened.

**Sign-in emails** have one code path: `sendSignInLink(supabase, email, origin)` in
`@/auth/magic-link`. The login page passes its cookie-bound client; an invite uses
`signInLinkSenderForInvites()`, which sends through a cookie-less client so the owner's own session
is untouched. If the invitation email fails the invite still stands and the page says so.

Public routes are listed in `src/auth/paths.ts`: `PUBLIC_PATHS` (with their sub-paths: `/login`,
`/auth/*`) and `PUBLIC_EXACT_PATHS` (that path only: `/api/mcp`, the MCP server — bearer token,
`src/mcp/auth.ts`; `/api/cron/nightly`, the nightly sync (#6) — Vercel Cron's `Authorization: Bearer
<CRON_SECRET>`, checked constant-time and failing closed by `src/sync/cron.ts`; `/api/cron/backfill`,
the history backfill (#8), same header and check; a route added under any of them later stays behind
the sign-in gate). Anything added there (prefer the exact list) is the one
exception to "wrap every route handler in `withUser`/`withRole`": it must authenticate itself.

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
  happen in SQL (`numeric` is exact); values come back as strings like `'1234.50'` (type `Money`).
  If JS must do money maths, use the one helper, `@/lib/money`: `moneyToSen("1234.50")` →
  `123450` (exact, from the decimal string — never `Number(value) * 100`), integer arithmetic on sen,
  then `senToMoney(sen)` → `"1234.50"`. No floating-point arithmetic on money anywhere. Format for
  display only at the edge (components/CSV): `formatRinggit`, `formatRinggitChange`.

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
(`e2e/support/mailpit.ts`, `signIn(page, email)` in `e2e/support/auth.ts`; it retries when
Supabase rate-limits links to the same address, 1s locally, and only accepts an email that arrived
after its own request). The owner is
`run.ownerEmail` (seeded by the app from `OWNER_EMAIL`), a manager `run.managerEmail`; use
`withRunDatabase(sql => …)` to put data into the run's database. Nav-driven tests read
`NAV_ITEMS`, so new pages are covered automatically; extend the suite for your ticket's flow.
`addConnection(page, …)` / `syncMonth(card, "September 2026")` (`e2e/support/connections.ts`) add a
connection and run "Sync now" (it reads line items too: allow ~15 s per synthetic month);
`clearSyncedData()` (`e2e/support/db.ts`) empties every synced table — call it before and after a
spec that syncs. A spec that changes item groups (`e2e/mix.spec.ts`) also deletes
`item_assignments`, owner `item_group_rules` and `item_classifications` before and after.

The app under test talks to a **fake Kreloses** (`e2e/support/fake-kreloses-server.ts`, the same
fake the unit tests use, on its own port) via `KRELOSES_BASE_URL_WWW/SEA`, with a throwaway
`CREDENTIALS_ENCRYPTION_KEY` per run (and backfill settings for `e2e/backfill.spec.ts`: night window
08:00–10:00 around the fixed 09:00 clock, 50 requests a night, 0.5 s pause). Its synthetic logins are `SYNTHETIC_ACCOUNTS` in
`src/kreloses/testing/fake-kreloses.ts` (`north`, `south`, `both`, `oneTimeCode`, `down`,
`brokenSaleList` — logs in fine, but its Sale List is in an unknown layout, so every sync of it
fails —, …). The suite's app gets a throwaway `CRON_SECRET` (`E2E_CRON_SECRET`), so a spec can call
`/api/cron/nightly` as Vercel Cron does (`e2e/nightly.spec.ts`). A
spec that creates connections must leave the table empty (the shell spec expects empty states); a
spec that syncs must also empty the synced tables (`clearSyncedData()`). The fake serves the
synthetic Sale List (`sale-list-rows.json`: Aug–Sep 2026 and Sep–Oct 2025) and every sale's
invoice page (`sale-overviews.json`), so a spec can "Sync now" September 2026 and get doctors.
A spec that needs other sales (e.g. dated relative to today) builds them with `syntheticSales([...])`
(`src/kreloses/testing/synthetic-sales.ts`: Sale List rows + invoice pages from a short description)
and makes the fake serve exactly those with `serveSales(...)`; it must call `restoreFixtureSales()` in
`afterAll` (`e2e/support/fake-kreloses-control.ts`, test-only `POST /__e2e/sales[/reset]` on the fake).
Unit tests pass the same builder's output to `createSyncHarness(sql, { fake: { saleList: { rows }, saleOverviews } })`.

### Kreloses Reader (`src/kreloses/`)

The only code that knows Kreloses exists. Import from `@/kreloses`:

```ts
login(credentials: { email; password }, options?: ReaderOptions): Promise<KrelosesSession>
listLocations(session): Promise<{ id: string; name: string }[]>   // POST /Report/GetFilter {report: 14}; never empty
fetchFilterTemplate(session, report: number): Promise<unknown>     // raw filter template (uncached)
listInvoices(session, { page, dateRange?, includeCancelled, pageSize?, previous? }): Promise<InvoicePage>
  // POST /Sale/Get, one page: { invoices: KrelosesInvoice[], totalCount, page, rowCount, hasMore, span }
  // pass the previous page back as `previous` for every page after the first
getInvoice(session, saleId): Promise<KrelosesInvoiceDetail>       // GET /Sale/Overview/{id} (#5)
  // { header: { saleId, grossSen, discountsSen, netSen, taxSen, totalSen, totalPaymentsSen, totalRefundsSen } (null = not on the page),
  //   lines: KrelosesInvoiceLine[], raw: { Sale, Totals, Transactions, RefundInfo, CreditNoteInfo } }
listStaff(session): Promise<{ id: string; name: string }[]>       // the Sale List filter's Staff options (#5)
readerOptionsFromEnv(process.env): ReaderOptions                   // real Kreloses, or the e2e fake outside production/Vercel
session.postJson(path, body): Promise<unknown>                     // AJAX POST to a sea endpoint (#4: /Sale/Get)
session.getHtml(path): Promise<string>                             // page load of a sea page (#5: /Sale/Overview/{id})
```

- **Errors** (all `KrelosesError`, safe to log/store — never passwords, cookie values, tokens or
  query strings). What to do with each:
  - `AuthFailed` — don't retry until the owner acts. `reason`: `bad_credentials` (the login form
    came back without ever reaching sea; Kreloses's own message in `detail`) | `unexpected_step`
    (`step`: `one_time_code` | `returned_to_login` (reached sea, then bounced to the login page) |
    `redirected_elsewhere` (off Kreloses; not followed) | `too_many_redirects` |
    `unrecognised_page`) | `session_expired` (an established session was answered with the login
    page: log in again once).
  - `LayoutChanged` — needs a code fix, don't retry: an unexpected page/JSON (`shape` = keys and
    types, never values), HTTP 500 on the login form POST (ASP.NET's answer to an anti-forgery
    mismatch), a Location filter with no locations, an app endpoint that redirects elsewhere or
    answers other than 200.
  - `RateLimited` (`retryAfterSeconds`) and `Transient` (`status` for a 5xx other than the login
    POST's 500, absent for network errors/timeouts; `request` = `METHOD host/path`) — retry later.
- **Session**: a browser-like session — a cookie jar that honours Domain/host-only/Path/Secure/
  expiry (the login is on www, the app on sea), redirects followed by hand and only between the
  two Kreloses hosts (at most 10 per request), requests **serial per session** with
  `requestDelayMs` (default 1 s) between them. `postJson` and `getHtml` both recognise an expired
  session the same way: a redirect to the login page, 401/403, ASP.NET Identity's AJAX answer
  (HTTP 200, empty body, `X-Responded-JSON` 401/403), or the login form instead of the content.
  `session.navigate({method, url, followRedirects})` is the lower-level page fetch.
- **Transport**: `ReaderOptions.transport` is fetch-shaped (`(url, init) => Promise<Response>`,
  always `redirect: "manual"`). Tests pass `createFakeKreloses().transport`. A Vitest setup file
  (`src/test-support/no-real-kreloses.ts`) makes any `fetch` to `*.kreloses.com` throw and fails
  the test, so a test that forgets the transport cannot reach the real site.
- **Fixtures and the fake** (Seam 2): synthetic responses in `src/kreloses/__fixtures__/` (see its
  README — none are real recordings yet), served by `createFakeKreloses()` in
  `src/kreloses/testing/fake-kreloses.ts`. Every sea path needs a signed-in session in the fake
  (page loads get a 302 to the login page, AJAX calls the `X-Responded-JSON` answer; option
  `ajaxAuthFailure: "redirect"` for a plain 302). To extend for `listInvoices` / `getInvoice`
  (#5): add `*.response.json` + body fixtures and a route to `BUILT_IN_ROUTES` (or
  `fake.addRoute({host: "sea", method, path, handler: ({request, account, fixture}) => …})` in a
  test) — the login check comes for free — then the Reader function on top of `session.postJson`
  / `session.getHtml`. Use `fake.intercept(request => Response | undefined)` for one-off failures
  and `fake.expireSessions()` for expiry. The Sale List route filters/sorts/pages `fake.saleRows`
  (mutable: cancel a sale, change a refund, then sync again); `createFakeKreloses({saleList:
  {ignoreDateFilter: true}})` simulates a server that ignores the date filter. `GET
  /Sale/Overview/{id}` renders `fake.saleOverviews[id]` (mutable models from
  `sale-overviews.json`: edit a sale's `Items`, then sync again; a sale without a model is a 404).
  To give a new synthetic sale line items, add its model there (keep its `Totals` equal to its
  Sale List row) and document the hand-computed figures in the test that uses it.
- **`listInvoices`** (`src/kreloses/sale-list.ts`): passes the Sale List filter template (fetched
  once per session, shared with `listLocations`) back as `filter` with every Sale status selected
  when `includeCancelled` (the default selects only Active), every location, and the date range in
  the template's own format (`dd/MM/yyyy` here; day-first assumed for slashed dates). Rows become
  `KrelosesInvoice`: ids as strings, money in **integer sen** (`grossSen`, `discountsSen`, `netSen`,
  `taxSen`, `totalSen`, `totalPaymentsSen`, `totalRefundsSen`; thousand separators, `(12.00)`,
  minus signs, `RM` prefixes and JSON numbers accepted; more than 2 decimals is refused), `saleAt`
  (instant) + `saleDate` (clinic day), `status` `active`|`cancelled` (+ Kreloses's `statusName`),
  `raw` (the row as sent). Any missing field, unreadable amount/date or unknown status raises
  `LayoutChanged` naming the row and field (never a value). **Verify with the live smoke test:**
  the server-side date filter, the `SaleDate` format (`/Date(ms)/` is read as UTC; an ISO string
  without a zone as KL wall-clock time) and the sort order are unrecorded guesses, so the Reader
  also drops rows outside the range itself and returns `hasMore: false` once a whole page is
  older than `dateRange.from` — but only while every page seen so far is newest first (otherwise
  it pages on to TotalCount). Paging that does not add up raises `LayoutChanged` instead of losing
  sales: a page shorter than asked while TotalCount says more (a capped page size), more rows than
  asked, more rows read so far than TotalCount, or a page repeating the previous one's first/last
  sale (RequestingPage ignored).
- **`getInvoice`** (`src/kreloses/sale-overview.ts`): the invoice page embeds `var model = {…};`.
  The Reader scans the page (never rewriting it): only an assignment inside a `<script>` counts,
  not one in HTML text, an HTML comment, a JS string or a JS comment; it reads the object to its
  matching brace (braces inside strings ignored), `JSON.parse`s it (two models that parse →
  `LayoutChanged`) and checks what it relies on: `Items[]` with
  `Name`, `Quantity`, `UnitPrice`, `Amount`, `StaffName`, `ItemType` (1 product, 4 service,
  **55 discount line**; other values kept as sent), `DiscountName`, `DiscountAmount`; `Sale.SaleId`
  (if present) must be the sale asked for; `Totals` amounts (if present) must be readable. Money →
  integer sen (same formats as the Sale List); quantities → exact decimal strings (`"2.5"`, `"-1"`;
  up to 4 places, stored `numeric(12,4)`); a blank `StaffName` → null ("No staff on line"). Only a
  discount line may lack Quantity/UnitPrice/Amount. No model, JSON that does not parse, a missing
  item field or an unreadable number → `LayoutChanged` naming the item and field (never a value).
  `Customer` is never returned. A page that is not there — HTTP 404/410 or a redirect anywhere but
  the login page (`session.getHtml`) — raises **`PageMissing`**, a subclass of `LayoutChanged`
  (`reason` `not_found` | `redirected`, `status`), so the Sync Engine can skip one missing invoice
  while treating a changed page as fatal. UNVERIFIED until the live check: `Totals` key names, that `Amount`
  is after the item discount, the discount line's sign, how refunds show in
  `RefundInfo`/`CreditNoteInfo` (kept raw in `invoices.raw_detail` for #6), and whether item lines
  ever carry an invoice-level discount's `DiscountName`/`DiscountAmount` as well as the type-55 line
  (would double-count that type's row on the Discounts page; the total discount stays exact).
- **`listStaff`** (`src/kreloses/staff.ts`): full staff names from the Sale List filter template's
  Staff filter (shared with `listLocations`); no Staff filter → `LayoutChanged` (the Sync Engine
  records it as a warning and carries on); an empty one (e.g. loaded on demand) → `[]` (names on
  lines then stay unmatched, still credited).

#### Live login check (real Kreloses)

`npm run test:live` logs in to the **real** Kreloses once, lists the locations the login can see,
and prints a redacted diagnostic: each HTTP hop's method, host/path (no query string; path
segments other than generic route words shown as `<segment>`, numbers as `<number>`), status and
any `X-Responded-JSON` status, cookie names with their Domain/Path/expiry/flags (never values),
whether a one-time-code step appeared, which host the session works on, the number of visible
locations (not their names) and the shape (keys/types) of the GetFilter JSON (objects whose keys
could be data — non-identifier keys, more than 20 keys, a single-word key that is not a known field
name (`{Ong: "a", Tan: 2}`), or values that all share one shape (a null matching anything, at any
depth) unless every key is made of known field words (`NetAmount`) — are shown only as
`{<n keys>: …}`; see `describeJsonShape` in `src/kreloses/json.ts`). It then reads ONE Sale List page (previous
month up to today, all statuses) and prints only its structure: the filter template's status
options, selection mechanism and date pattern, the response shape, TotalCount, which expected fields
are present/missing (and other field names), `SaleDate` patterns (digits as `9`), how many sales
fall in each 3-hour slot of the KL day as the Reader reads them (clinic hours showing at night would
mean `/Date()/` holds KL time sent as UTC), whether rows come newest first, how many rows fall
outside the requested range, how amounts are
formatted (separators / parentheses / minus / currency: yes or no), the status labels seen, whether
cancelled sales appear, and whether the Reader parses the page. Then it counts the staff in the
Sale List filter and opens up to THREE invoice pages of that Sale List page (the first active sale,
the first with a discount, the first with a refund or a negative net) and prints their structure in
aggregate: the first page's model keys and types, whether every page has the same top-level keys,
the item fields present/missing/other, how many lines have each ItemType, number formats, how many
lines name a staff member, and counts for the Reader's assumptions (Amount = Quantity × UnitPrice −
DiscountAmount, the discount lines' sign, pages whose lines add up to `Totals.NetAmount` and to the
Sale List's NetAmount — the gap monitor —, `Totals.NetAmount` = the Sale List's NetAmount,
`Sale.SaleId` = the sale asked for), the shapes of `RefundInfo` / `CreditNoteInfo`, and whether the
Reader parses each page — never a name, amount, quantity, number or id (sale ids become `<sale>`,
even in error messages). It is skipped unless credentials are set, needs no database, and is never part of `npm test`. Run it from a terminal without saving the password in
your shell history:

```bash
read -r "KRELOSES_TEST_EMAIL?Kreloses email: "; read -rs "KRELOSES_TEST_PASSWORD?Kreloses password: "; echo
export KRELOSES_TEST_EMAIL KRELOSES_TEST_PASSWORD
npm run test:live
# Optional: also measure session lifetime (one tiny request every 5 minutes for 60 minutes)
KRELOSES_TEST_SESSION_PROBE_MINUTES=60 npm run test:live
# Optional: read an older month's Sale List page and invoice pages instead (before the history backfill, #8)
KRELOSES_TEST_MONTH=2024-03 npm run test:live
unset KRELOSES_TEST_EMAIL KRELOSES_TEST_PASSWORD
```

(The `read "NAME?prompt"` form is zsh; in bash use `read -rp "Kreloses email: " KRELOSES_TEST_EMAIL`
and `read -rsp "Kreloses password: " KRELOSES_TEST_PASSWORD`.) Check the output before sharing it.

**Before enabling the history backfill (#8)**, check in the output: that the Sale List's "rows
outside the requested range" is 0 (the server applies the date filter — UNVERIFIED so far; the
backfill's per-month totals and listing cost depend on it), the `RefundInfo` / `CreditNoteInfo`
shapes (refunds, ADR 0008), and — with `KRELOSES_TEST_MONTH` set to a 2024 month — that old
invoice pages parse like recent ones. See [History backfill](#history-backfill-8).

### Kreloses connections (`src/connections/`)

A **connection** is one Kreloses login (the owner adds one per branch login) in the `connections`
table: label, Kreloses email, password as an AES-256-GCM envelope
`v1.<key id>.<iv>.<tag>.<ciphertext>` (`src/connections/encryption.ts`, key from
`CREDENTIALS_ENCRYPTION_KEY`, see ADR 0003), `status` (`untested` | `ok` | `failed`),
`last_error_code` / `last_error`, `last_tested_at`, `visible_locations` (`[{id, name}]`).

- `saveConnection(context, input)` validates, encrypts, stores and then runs the live login test
  (`login` + `listLocations`); a failed test still saves the connection, with a human message
  (`describeTestFailure` in `messages.ts`: wrong password vs extra login step vs unreachable…).
  `testConnection`, `deleteConnection`, `listConnections` complete the set. The page gets
  `connectionsContext()` (`@/connections/context`, server only).
- **The password never leaves the server**: `listConnections` / `ConnectionSummary` never select
  `password_ciphertext`, actions return only what the page shows, and the password field is never
  pre-filled (blank on edit = keep the stored one). Only `loginAsConnection(context, id)` decrypts,
  just for the Reader call — the Sync Engine logs in with it.
- **One Kreloses session per connection** (`@/connections/lock`, ADR 0004): a lease row in
  `connection_locks` (`acquireConnectionLease` / `releaseConnectionLease` / `withConnectionLease`,
  purpose `sync` | `login-test`, a TTL after which a crashed holder's lease is free). A login test
  (save or "Test again") takes it too: `testConnection` throws `ConnectionBusy` while a sync runs,
  and `saveConnection` saves but skips the test (`loginTestSkipped: "busy"`).
- `recordLoginOutcome(sql, id, {ok, visibleLocations} | {ok: false, error})` stores what a sync's
  login showed exactly as a login test would, so a failing login shows on the Connections page.

### Sales data (`invoices`, `branches`, `customers`, `sync_runs`, line items, staff)

Migration `…_sales_sync.sql`. Kreloses ids (location, customer, sale) are assumed unique across
every Kreloses login, so two connections that see the same branch update the same rows. Deleting a
connection **keeps** synced data: `branches.connection_id` / `sync_runs.connection_id` become null
(`sync_runs.connection_label` keeps the name); invoices do not reference connections.

- `branches` — `id` (what `GlobalFilter.branchIds` holds), `kreloses_location_id` (unique), `name`,
  `connection_id` (last connection that synced it).
- `customers` — `kreloses_customer_id` (unique), `name` (from the latest sale seen), `first_seen_date`
  (earliest synced clinic day).
- `invoices` — `kreloses_sale_id` (unique), `sale_number`, `branch_id`, `customer_id` (null = walk-in),
  `sale_at` (timestamptz) and `sale_date` (**generated**: the KL clinic day — filter on this),
  `status` (`active` | `cancelled`) + `status_name`, `gross_amount`, `discount_amount`, `net_amount`,
  `tax_amount`, `total_amount`, `payment_status`, `total_payments`, `total_refunds`
  (`numeric(12,2)`, Kreloses's sign), `raw_header` (jsonb), `sync_run_id`, `fetched_at` (when the
  header was last written, i.e. first read or changed — an identical re-read leaves the row alone),
  `detail_fetched_at` (#5: line items need a (re)fetch when null or `< fetched_at`). `raw_header`
  is refreshed on its own when only unparsed fields change (no new `fetched_at`). #5 added
  `raw_detail` (the invoice page's `Sale`/`Totals`/`Transactions`/`RefundInfo`/`CreditNoteInfo`),
  `header_version` (+1 whenever a header column that can change line items or revenue changes —
  status, gross, discounts, net, tax, total, refunds; since #6 NOT payment status / payments alone),
  `lines_header_version` (the version the stored lines were computed for), `lines_current`
  (**generated**: the two are equal — THE definition of "its line items belong to the header as it
  is now"), `revenue_base` (**generated**: what its credited lines' revenue adds up to — net less
  the refunded part, #6; twin of `invoiceRevenueBaseSen`), `line_gap_amount` (net − Σ all line
  amounts when last read; the gap monitor) and `detail_missing_count` (#6: invoice page missing this
  many reads in a row for the current header; at 3 the sync stops trying — "permanently missing"),
  `detail_unreadable_at` (#8: its page already opened but could not be read for the current header —
  only so a later run does not count it again as "the first pages tried all fail"; never an attempt
  limit; cleared when read or when the header changes).
- `invoice_lines` (migration `…_line_items_and_doctor_credit.sql`) — the invoice page's `Items[]`
  as read: `invoice_id`, `line_no` (1-based; unique per invoice), `item_name`, `item_type` (55 =
  discount line), `quantity` `numeric(12,4)`, `unit_price`, `amount` (the charged amount, after any
  item discount), `raw_staff_name` (null = no staff), `discount_name`, `discount_amount`. Upserted
  by (invoice, line_no), so ids survive a re-read.
- `credited_lines` — see [Credited lines](#credited-lines-the-revenue-model).
- `staff` — `full_name`, `name_key` (how the matcher reads it), `kind` (`doctor` | `other` |
  `generic`), `kind_source` (`auto` | `manual`: the owner's choice is never overwritten), `source`
  (`kreloses` from a staff list | `alias_only`: a line name matching nobody, e.g. a deleted doctor),
  `kreloses_staff_id`, `active` (false once the connection that listed them stops listing them),
  `connection_id`. Never deleted.
- `staff_aliases` — every distinct staff name seen on lines: `raw_name`, `normalised_name`
  (unique: trimmed, spaces collapsed, lower case), `staff_id` (always set), `match` (`auto` |
  `manual` | `unmatched`). A name is matched when first seen; once it has credited lines a sync
  never moves it (unmatched names get suggestions, `listStaffAliases`). Kinds follow
  `defaultStaffKind(fullName, lineNames)` until the owner sets one (generic only from the full name).
- `sync_runs.warnings` — `[{code, message}]` (see Sync Engine).
- `sync_runs` — `connection_id`, `connection_label`, `mode` (`nightly` | `backfill` | `manual`),
  `status` (`running` | `succeeded` | `partial` | `failed`), `date_from` / `date_to`, `started_at`,
  `finished_at`, `counts` (`SyncCounts`), `checkpoint` (`{nextPage, pageSize}`, nightly also
  `{processedAfter, listingDone}` — saved with every page, kept on partial/failed),
  `resumed_from_run_id` / `chain_started_at` (#6: the run it carried on from, and when that chain's
  first run started — what "data as of" uses), `covered_location_ids`
  (set when the run read its whole listing — succeeded, or partial only for missing invoice pages; drives "data as of"), `error_code` (`auth_failed` | `layout_changed` |
  `rate_limited` | `transient` | `key_problem` | `interrupted` | `internal`) + `error` (shown to users).
  At most one `running` run per connection (unique partial index).
- `connection_locks` — the per-connection lease (above; database clock, renewed by every write of a
  sync, ADR 0009). Holders are `sync:…`, `backfill:…` (#8) or `login-test:…`; `yield_requested_at`
  is set when the nightly sync or Sync now asks a backfill holder to step aside (ADR 0011).
- `connection_backfills` (#8) — one per connection: `status` (`active` | `paused` | `complete`),
  `date_from` (2024-01-01), `date_to` (fixed by its first chunk: the clinic day it ran; null before),
  `requested_at`, `started_at`, `paused_at`, `completed_at`. Month progress is not stored: see
  [History backfill](#history-backfill-8).

### Credited lines: the revenue model

Every revenue figure is a sum of **credited lines** (spec: Attribution & Rules; ADRs 0005, 0006):

- **The rule** (`creditInvoice`, `src/attribution/credit.ts`, PURE, unit-tested edge by edge): each
  non-discount line starts from its own `Amount` (what it charged, after any item-level discount).
  The invoice's discount lines (ItemType 55) and any gap between the lines and the revenue base are
  spread over the non-discount lines **in proportion to what each line charged** (lines that
  charged ≤ 0 take no share while any line charged more; if none did, by |quantity × unit price|;
  if that is zero too, equally), in whole sen by largest remainder, ties to the lower line_no. An
  invoice with no non-discount line gets one "unitemised remainder" row (`invoice_line_id` null, no
  staff). **An invoice's credited lines add up exactly to its revenue base.**
- **Refunds** (#6, ADR 0008 — an ASSUMPTION until live data shows how Kreloses reports them): the
  part of an invoice's net that was refunded is `invoiceRefundSen()` = TotalRefunds × net ÷ total
  (refunds taken as tax-inclusive like Total), half up to the sen, at most the net, 0 when net, total
  or refunds are not positive (a return sale's refund is the return itself) or the invoice is
  cancelled. It is spread over the lines like the discounts (by what each charged).
- **The revenue base** is defined twice, kept equal by a test (`src/sync/lines.test.ts`, every
  rounding/sign corner through the generated column) and a runtime check in `saveInvoiceLines`:
  `invoiceRevenueBaseSen()` in TypeScript and the generated `invoices.revenue_base` in SQL (what
  pending rows and reconciliations use) — `net_amount − refund` if active, 0 if cancelled. Change
  both together (one migration + one function; the #6 migration shows how, including re-basing
  existing credited lines by bumping `header_version`).
- **Stored per invoice read** (`saveInvoiceLines`, `src/sync/lines.ts`, one transaction): the
  lines, the credited lines (`gross_amount`, `line_amount`, `spread_amount`, `credited_amount =
  line_amount + spread_amount` — what the line was charged, its share of the invoice NET, before
  refunds —, `refund_amount` — its share of the refund —, `revenue_amount = credited_amount −
  refund_amount` (generated) — what revenue counts —, `staff_alias_id` — null = "No staff on
  line"), and on the invoice
  `lines_header_version` (the `header_version` the lines were computed for), `detail_fetched_at`,
  `raw_detail` and `line_gap_amount` (net − Σ all line amounts: the gap monitor; ≠ 0 is counted on
  the run as `lineItemGaps`). If the header changed while its page was being read, nothing is
  written and the invoice stays pending.
- **Current or pending**: `invoices.lines_current` (generated) = `lines_header_version =
  header_version`. The sync bumps `header_version` whenever a parsed header column changes, so lines
  are compared with the header they were computed for — by version, never by clock.
- **Who and what kind are resolved at query time**: `credited_lines.staff_alias_id →
  staff_aliases.staff_id → staff.kind`. A remap (Settings → Doctors) or a kind change changes every
  figure at once, with no re-sync and nothing re-derived (the amounts do not depend on the staff).
- **Query them only through `revenueFacts`** (`src/analytics/facts.ts`), which adds the invoice's
  `sale_date`/`branch_id`/`customer_id`, the resolved `staff_id` and `credit_group` (`doctor` |
  `other` | `generic` | `no_staff` | `pending`), applies the branch and doctor filters, keeps only
  active invoices whose `lines_current` is true, and adds ONE `pending` row (its `revenue_base`) per
  active invoice whose lines are missing or stale — so revenue never drops between a header sync
  and its line sync. Its `revenue` is `credited_lines.revenue_amount` (after refunds); its
  `credited_amount` column is the pre-refund amount (null on pending rows). Reconciliation (tested
  per branch and month): Σ revenue = Σ `revenue_base`, and Σ credited amount = Σ active net.

**#9 (item groups / mix)** is in place: `revenueFacts` has the item and its service-mix group and
flags as columns (see [Item groups and service mix](#item-groups-and-service-mix-srcitems-9)).

**#6 (nightly / change detection / refunds)**: which invoices get their lines (re)read is decided
in ONE place, `invoicesNeedingLines()` (`src/sync/lines.ts`): active, `not lines_current` (never
read, or the header version moved — and `saveInvoicePage` moves it only for line/revenue-relevant
columns: status, gross, discounts, net, tax, total, refunds), and not permanently missing
(`detail_missing_count < MAX_PAGE_MISSING_ATTEMPTS`). Refunds are deducted as above; if the live
check shows Kreloses represents them differently (`raw_detail.RefundInfo` / `CreditNoteInfo`),
change `invoiceRefundSen()` and `invoices.revenue_base` together and bump `header_version` of the
invoices whose base changes (the nightly sweep then re-reads them).

**Discounts (#12, `src/analytics/discounts.ts`)**: per SOLD line (a credited item line with
`gross_amount >= 0`: `soldLine()`), discount = `gross_amount − credited_amount` (`revenueFacts`'
`credited_amount`: what the line was charged after its item discount AND its share of the
invoice's discount lines/gap, BEFORE refunds — so a multi-doctor invoice's discount is shared by
#5's spread rule and nothing re-spreads it). Per doctor: discount = Σ gross − Σ charged, rate = discount ÷ gross, an invoice is
"discounted" for them when THEIR share of its discount is > RM 0.05 (`DISCOUNTED_INVOICE_THRESHOLD`).
Return lines (gross < 0) are left out of every discount figure in both functions — totals, rate,
counts, types, difference row — so a return-only invoice is out entirely (orchestrator decision:
counted, a discounted return showed as a positive "discount" at a negative rate); the rate is null
when gross ≤ 0. Pending rows and the unitemised remainder (e.g. a sale with only a discount line)
have no gross and are left out too (`pendingLineItems` says how many are pending). **Refunds are not discounts**: charged is the pre-refund amount (`credited_amount`); since #6
deducts refunds from revenue, a doctor's "charged" differs from their Doctors-page revenue by their
lines' refund shares (and by return lines, which discounts leave out). Discount types come from
`invoice_lines`: item discounts (`discount_name`, or any line charged ≠ gross; amount = gross −
amount), discount lines (`item_type = 55`, amount = −`amount`) and one "other difference to the
invoice net" row (Σ line amount − credited not explained by discount lines; can be negative), so
without a doctor filter the types add up exactly to the total discount. Names are grouped by
`lower(name)` with ALL whitespace removed ("5%DISCOUNT" = "5% discount"), shown as written most often.
Live check: do item lines ever carry an invoice-level discount's DiscountName/DiscountAmount as well
as the type-55 line? (That would double-count that type's row; the total stays exact.) Under a doctor filter an invoice-level type counts in the
proportion the spread gave the selected doctors' lines, rounded per type.

### Sync Engine (`src/sync/`)

```ts
runSync(deps: SyncDeps, connectionId, mode: "manual" | "nightly" | "backfill", options?): Promise<SyncResult>
  // deps: { sql, login(id) → KrelosesSession, reader?, now?, sleep? }; syncDeps() (@/sync/context) in the app
  // options: { dateRange? (default: nightly → nightlyWindow(now, windowDays); else the current clinic month),
  //            windowDays? (nightly, default 45), timeBudgetMs? (default 200 s), pageSize?, startPage?,
  //            resume? (carry on from the connection's latest run of the same mode — nightly: any window;
  //            else exactly these dates — that stopped part-way: time limit, failed or interrupted with a
  //            checkpoint, chain started < resumeMaxAgeMs (default 6 h) ago; a run that read its whole
  //            listing is never resumed), sweep? (default: nightly), maxRetries? (default 3),
  //            maxRequests? (#8: stop cleanly before sending more Kreloses requests than this),
  //            backfillYieldWaitMs? (#8, nightly/manual: how long to wait for a backfill to step aside, default 60 s) }
  // → { status: "succeeded" | "partial" | "failed", runId, counts, error?, warnings, stoppedAtTimeLimit?,
  //     stopReason? ("time_limit" | "request_limit" | "yielded"), resumedFromRunId? }
  //   | { status: "busy", heldFor: "sync" | "backfill" | "login-test", until } | { status: "not_found" }
runNightlySync(deps, { windowDays?, totalBudgetMs? (250 s), maxRunBudgetMs? }): Promise<NightlyConnectionResult[]>
  // @/sync/nightly: every connection (failed ones included), one after another, resume: true
runBackfill(deps, { config, budgetMs?, pageSize? }): Promise<BackfillOutcome>      // @/sync/backfill (#8): the endpoint's work
runBackfillChunk(deps, connectionId, { config, budgetMs?, pageSize? }): Promise<BackfillChunkResult>
getBackfillProgress(sql, { now, config }): Promise<BackfillProgress[]>           // @/sync/backfill-progress: Sync status, Connections
getSyncAlerts(sql): Promise<SyncAlert[]>          // @/sync/alerts: the dashboard banner's data
listPermanentlyMissingInvoices(sql): Promise<{ total, invoices }>   // @/sync/lines: Sync status
listSyncRuns(sql, { limit? }): Promise<SyncRun[]>   // newest first, for the Sync status page
```

A run takes the connection's lease (else `busy`, no run row; database clock, 4-minute TTL renewed
inside the transaction of EVERY write — a run whose renewal fails because another run took over
stops at once without writing anything more: fencing, ADR 0009), marks the connection's stale
`running` runs `interrupted` (and runs of deleted connections left `running` for over an hour),
with `resume` picks the run to carry on from, logs in, stores the visible branches (and the connection's login
status) and the staff list (`upsertStaffDirectory`, `src/staff/store.ts`: new staff, renamed staff,
inactive ones; unmatched line names are matched again), then reads Sale List pages serially (the
Reader's polite delay). After each page it opens the invoice page of each of the page's invoices
in `invoicesNeedingLines()` and stores lines + aliases + credited lines per invoice in one
transaction (`saveInvoiceLines`), checking the time budget before each; the page stays the
checkpoint until its line items are done (so carrying on re-reads that page, a no-op for headers,
then the missing line items). `counts.lineItemsRead` counts invoice pages read.

- **A missing invoice page** (the Reader's `PageMissing`: HTTP 404/410, or a redirect anywhere but the
  login page) is skipped: `counts.lineItemsFailed` +1, `invoices.detail_missing_count` +1, the
  invoice stays pending at its revenue base and the next run tries it again — up to
  `MAX_PAGE_MISSING_ATTEMPTS` (3) reads in a row; then it is "permanently missing" (never tried again
  until its header changes; listed on Sync status). A run that read its whole listing but skipped
  pages ends **`partial`** with `coveredLocationIds` set (so it counts for "data as of" and is never
  resumed), `checkpoint` `{nextPage: 1}` and an `invoice_pages_missing` warning; `SyncResult` says
  `stoppedAtTimeLimit: false`. If the first `MISSING_PAGES_TO_FAIL` (3) pages of the run's LISTING it
  tries FOR THE FIRST TIME are all missing (pages already missing in earlier runs do not count), it
  fails (`layout_changed`: something systematic). A listing page whose content changed
  (`LayoutChanged` proper) still fails the run at once. In the nightly SWEEP neither ever fails the
  run: a missing page is counted as above (it uses up one of its 3 attempts), and an older page that
  opened but the app cannot READ (`LayoutChanged`) is skipped — counted apart
  (`counts.lineItemsUnreadable`, an `invoice_pages_unreadable` warning) and NOT using up attempts, so
  after a Kreloses change old invoices are never marked "permanently missing" and the first sweep
  after the app is updated reads them; the run ends `partial` with its listing covered.
- **Time budget**: no Kreloses request starts after the deadline, and no login (the first, or the one
  fresh login after an expired session) starts with less than `MIN_LOGIN_BUDGET_MS` (15 s) left — the
  run stops cleanly as `partial` (stopped at its time limit) instead of running past the function's
  limit.
- **Nightly** (#6): the Sale List of `nightlyWindow` (the last `SYNC_NIGHTLY_WINDOW_DAYS`, default
  45, up to today; cancelled sales included) → change detection above (an unchanged invoice costs no
  request; payment-only changes are stored without a re-read) → the **sweep**: active invoices of
  ANY date still not current (synced before line items, changed outside the window, pending after a
  missing page, re-based by a migration) — ONLY of the branches whose Kreloses locations the login
  listed in this run (another login's invoices are never opened with this session) — newest first,
  while the budget lasts (a `line_items_left` warning says how many of this login's remain; the next
  night carries on). The checkpoint is
  DATE-based (`processedAfter`: every sale newer than that instant is done; `listingDone`), since
  pages of a newest-first list shift as sales are added or deleted: carrying on re-lists only the
  days up to `processedAfter`. Fixed past ranges (Sync now, #8 backfill) keep `nextPage`. A resumed
  run records `resumed_from_run_id` / `chain_started_at`; "data as of" for it is the chain's start.
  With the once-a-day cron a nightly never resumes the previous night's run (24 h > the 6 h chain
  limit): it starts afresh, and change detection makes that cheap (only what the stopped run did not
  get to is opened). Resume matters for a crash retried within hours (by hand, or a future cron).
- **Warnings** (`sync_runs.warnings`, `SyncResult.warnings`, `SyncWarning` in `src/sync/runs.ts`):
  `invoice_pages_missing`, `staff_list_unreadable` (no readable Staff filter in report 14: the run
  carries on, names stay unmatched, nobody is marked inactive), `line_items_left` and
  `invoice_pages_unreadable` (nightly sweep, above), `backfill_request_budget` and `backfill_yielded`
  (#8: a backfill run stopped at tonight's request budget, or to let another sync use the login).
  Sync status and the "Sync now" message show them.
- **Counts** (`SyncCounts`): `pages, invoicesSeen, inserted, updated, unchanged, lineItemsRead,
  lineItemsFailed, lineItemGaps, lineItemsSwept, lineItemsUnreadable` (#6), `requests` (#8: HTTP
  requests sent to Kreloses — its login's, redirects and retries included; a login that fails is not
  counted — from `KrelosesSession.requestCount`) and `saleListTotal` (#8, optional: Kreloses's
  TotalCount for the run's dates at its last Sale List page). Older rows lack the new keys; `listSyncRuns` fills the counts with 0. Each page is upserted
**idempotently** (`on conflict … do update … where (…) is distinct from (…)`: a re-run writes
nothing and counts `unchanged`; a change only in fields the app does not parse refreshes
`raw_header` without counting as a change or moving `fetched_at`) together with the run's counts
and checkpoint in one transaction. Each page is handed back to the Reader as `previous`, so paging
that does not advance fails the run.
Before each page it checks the time budget and stops as `partial` with a checkpoint. Errors:
`AuthFailed` and `LayoutChanged` fail the run at once (AuthFailed and key problems also mark the
connection failed); an expired session gets one fresh login per run; `RateLimited` / `Transient`
are retried with backoff (5 s, 15 s, 45 s, or Retry-After) while the budget allows. Every run ends
with a `sync_runs` row, failures included (`describeSyncFailure` words the error).
"Sync now" (Connections page, owner only) runs `manual` for one chosen month (`@/sync/months`)
with `resume: true`, so syncing a month that stopped at the time limit (or failed part-way) again
within 6 hours carries on from its checkpoint.

**Scheduler** (#6): `vercel.json` has one cron, `GET /api/cron/nightly` at `0 19 * * *` UTC = 03:00
in Kuala Lumpur. On Vercel **Hobby** a cron job may run only once a day and Vercel may start it at
any time within that hour (±59 min), hence one run per night covering every connection. The route
(`src/app/api/cron/nightly/route.ts`, `maxDuration = 300`) checks `Authorization: Bearer
<CRON_SECRET>` (`handleNightlyCron`, `src/sync/cron.ts`: constant-time; no or short secret →
every request refused with 401) and runs `runNightlySync`: every connection, failed ones included
(a fixed login recovers by itself; one that still fails stays failed with the new error), one after
another under its own lease, sharing a 250 s budget (each gets the time left ÷ connections still to
go, at least 20 s, at most `SYNC_TIME_BUDGET_SECONDS`). To run it by hand:
`curl -H "Authorization: Bearer $CRON_SECRET" https://<app>/api/cron/nightly`. The history backfill
(#8) has its own trigger (GitHub Actions, below) because Hobby allows no second, more frequent cron.

**Failure banner** (#6): `getSyncAlerts(sql)` — a connection whose login fails (`status = failed`),
or whose latest finished NIGHTLY run failed with no later run (nightly or Sync now; never a history
backfill run, #8, which reads old months) that succeeded or read its
whole listing (a later failed or time-limited Sync now does not hide it) — is rendered by the
dashboard layout on every page for everyone signed in (`<SyncAlertBanner>`,
`src/components/sync-alert-banner.tsx`): the error in plain words; owners get a link to Connections,
managers the message only.

**Extension points.** #5 (line items), #6 (nightly, cron, resume, sweep, fencing) and #8 (history
backfill, below) are in place (`SyncReader` has `listLocations`, `listStaff`, `listInvoices`,
`getInvoice`). Tests: `createSyncHarness(sql, { requestDelayMs? })` / `clearSyncTables(sql)` /
`snapshotSyncedData(sql)` (every synced row by natural keys, for "identical state" assertions) in
`src/sync/test-support.ts` (fake Kreloses, fake clock, recorded sleeps; `h.fake.saleOverviews`
edits line items; `clearSyncTables` empties staff too). The lease follows the DATABASE clock: to
simulate expiry, move `connection_locks.expires_at` into the past. For hand-built sales instead of the
shared fixture set: `syntheticSales([{ saleId, branch: "north" | "south", at: "2026-10-05 10:00" (KL),
customer, status?, page?, lines: [{ name, amount, staff, itemType?, quantity?, unitPrice? }] }])` →
`{ rows, overviews }` (`src/kreloses/testing/synthetic-sales.ts`; a line is one unit at `amount` unless
it gives `quantity` + `unitPrice`) → `createSyncHarness(sql, { fake: { saleList: { rows }, saleOverviews: overviews } })`.
#9: every run (manual, nightly and its sweep) first recomputes every item name's service-mix
classification under the current rules (`reclassifyAllItems`, in `runSync`; writes only what
changed), and `saveInvoiceLines` classifies new item names in its transaction (`classifyItemNames`) — see
[Item groups](#item-groups-and-service-mix-srcitems-9).

### History backfill (#8)

Spec stories 10–12: every connection's sales from **1 January 2024** are loaded on first connection,
spread over several nights at a gentle rate, with progress on Sync status. Code: `src/sync/backfill.ts`
(`runBackfill`, `runBackfillChunk`, `backfillMonths`, `completedMonths`), `backfill-config.ts` (settings,
night window), `backfill-store.ts` (`connection_backfills`), `backfill-progress.ts`
(`getBackfillProgress`), the endpoint `src/app/api/cron/backfill/route.ts` (`handleBackfillCron` in
`cron.ts`) and the trigger `.github/workflows/backfill.yml`. ADR 0011.

- **Starts by itself** the first time a connection's login test works (`ensureBackfill` in
  `runLoginTest`, `src/connections/service.ts`; the migration also starts one for connections already
  connected). The owner can **Pause backfill** / **Start backfill** on Sync status (a pause keeps its
  progress; start carries on).
- **Month by month, newest first.** The first chunk fixes the dates: 1 Jan 2024 → the clinic day it
  ran (`date_to`). Each chunk takes the newest month not done yet and runs the Sync Engine over exactly
  that month (`mode: "backfill"`, `resume: true` with a 7-day chain limit, page checkpoints — past
  months are fixed ranges — `sweep: false`, one retry per request), then the next month while its
  time and request budget last, reusing one Kreloses session (one login per chunk).
- **A month is done** when any complete run of the connection (succeeded, or read its whole listing
  with some pages missing) covered all its days: the backfill's own, a nightly whose 45-day window
  contained it, or a Sync now of that month. So months the nightly sync already read are skipped, and
  within a month only invoices whose lines are not current are opened (`invoicesNeedingLines`):
  **no invoice page is read twice for the same header**, whichever mode got there first. Rerunning a
  month changes nothing (tested). Deviation from the ticket's "up to the start of the nightly
  window": the backfill ends on the day its first chunk ran, overlapping the window, because a
  connection's first nightly runs cannot read a whole 45-day window in their 250 s (the oldest days
  would fall out of the window unread); the overlap costs only Sale List pages.
- **Politeness** (`backfillConfigFromEnv`): the backfill's Kreloses sessions pause
  `BACKFILL_REQUEST_DELAY_SECONDS` (default **2 s**, the nightly's is 1 s) after each answer; one login
  sends at most `BACKFILL_MAX_REQUESTS_PER_NIGHT` (default **2,500**) requests per night — counted in
  real HTTP requests (`counts.requests`), a run stops before the next request once reached (warning
  `backfill_request_budget`); nothing at all happens outside `BACKFILL_NIGHT_WINDOW` (default
  **00:00–06:00** Kuala Lumpur time). A call runs for at most 240 s; logins that see different
  branches run side by side (requests stay serial per login), logins that share a branch take turns
  (so they never open the same invoice page at once). A chunk does nothing while the
  connection's login fails (no retrying a bad password every 15 minutes), and after a backfill run
  failed tonight because Kreloses asked to slow down (`rate_limited`) or changed its pages
  (`layout_changed`) it waits for the next night; passing errors are retried by the next chunk. A
  backfill run **never waits out a rate limit** (not even a short Retry-After): it would hold the
  connection meanwhile and a waiting nightly sync would give up, so the run stops at once.
- **Invoice pages it cannot read** (Kreloses changed a page): like the nightly sweep, the backfill
  skips an old invoice page that opens but cannot be read — counted (`lineItemsUnreadable`), warned
  (`invoice_pages_unreadable`), the sale stays "line items not synced yet" at its revenue base, the
  month still completes, and the nightly sweep reads it once the app is updated (unreadable pages
  never use up "missing" attempts). So one odd old page never stops the older months. It stays loud
  about a systematic change: a run whose first 3 invoice pages that fail FOR THE FIRST TIME (missing,
  or unreadable — `invoices.detail_unreadable_at` marks pages already seen unreadable for the current
  header) all fail with none read still fails (`layout_changed`, and the backfill waits for the next
  night). A Sale List page it cannot read always fails the run.
- **The maths.** ~35,000 invoice pages over two logins = ~17,500 per login, plus one Sale List page
  per 500 invoices. 24 chunks a night (every 15 minutes, 00:00–05:45) × (240 s ÷ ~2.5 s a request
  (2 s pause + ~0.5 s answer) = 96, less ~6 for logging in and re-listing where it stopped) ≈ 2,160
  useful requests a night per login, and never more than the budget (2,500):
  `backfillRequestsPerNight`. 17,500 ÷ 2,160 ≈ 8.1: **about 8–9 nights** (more if GitHub delays or
  skips scheduled runs). On average one request every ~10 s per login over the night. Test:
  `backfill-config.test.ts`.
- **The nightly sync comes first.** Runs never overlap for one connection (the lease). A backfill
  run holds it as `backfill:…`; when the nightly sync (or Sync now) finds it held by a backfill it asks
  it to step aside (`requestBackfillYield`) and waits up to 60 s: the backfill sees the request at its
  next lease renewal, stops cleanly before its next request (`partial`, checkpoint kept, warning
  `backfill_yielded`) and releases the lease (ADR 0011). A chunk that finds the connection held by
  another sync exits at once (`busy`, no run). The nightly's sweep may read line items of sales the
  backfill has listed but not read yet (older sales "not synced yet") — no page is read twice.
- **"Data as of"** is unchanged: a completed month counts for periods within it from its run (or, for
  a month carried on over several chunks, its chain's first run); months far in the past never make
  "now" look fresh. Backfill runs never hide a failed nightly sync's banner (`getSyncAlerts`).
- **Progress** (`getBackfillProgress`; Sync status card per connection, one line on Connections):
  months done / total and the month it is on; **invoices done / total** (done = cancelled, lines read,
  or page permanently missing, at the login's branches; total = per month what a complete read stored,
  else Kreloses's TotalCount once the backfill has listed the month, and the average of those for
  months not listed yet — shown as "about" until every month is listed). A run records TotalCount
  (`counts.saleListTotal`) only while every Sale List page it read held sales of its dates only: a
  page with rows outside them means the server ignored the date filter (UNVERIFIED, see the live
  check below), and then TotalCount counts every sale ever. Also: line items read; requests used
  tonight (or last night) / budget; nights left ((invoices to go + one Sale List page per month not
  done) ÷ `backfillRequestsPerNight`, rounded up); the last chunk's time and error. It says the
  backfill **runs at night once the trigger is set up** until its first chunk, and warns when a
  started backfill had no chunk during the last whole night window (the trigger may have stopped).
- **Check with the live test before enabling the backfill** (`npm run test:live`, README "Live
  login check"): (1) whether the Sale List's date filter is honoured server-side (its "rows outside
  the requested range" count must be 0 — otherwise each month's listing pages through every newer
  sale, and month totals cannot be used); (2) the shapes of `RefundInfo` / `CreditNoteInfo` (refunds,
  ADR 0008); (3) sample a few 2024 invoice pages (`KRELOSES_TEST_MONTH=2024-03 npm run test:live`
  reads that month's Sale List page and up to three of its invoice pages) to confirm old pages open
  and parse like recent ones — otherwise the backfill skips them as unreadable.
- **Trigger.** Vercel Hobby allows one cron a day (the nightly), so `.github/workflows/backfill.yml`
  calls `GET /api/cron/backfill` every 15 minutes from 16:00 to 21:45 UTC (00:00–05:45 KL) plus by
  hand (`workflow_dispatch`), with `Authorization: Bearer <CRON_SECRET>` (the nightly's secret and
  check). It is **inert until the owner opts in** (the repository is public): the job runs only when
  the repository variable `BACKFILL_ENABLED` is `true`; it needs no repository permissions, never
  overlaps itself, prints only the HTTP status (never the secrets or the answer: public logs), uses
  HTTPS only and fails on anything but 2xx so the owner gets GitHub's failure email. The endpoint
  answers at once outside the window, when tonight's budget is spent or when every backfill is
  complete. The optional "chunk after the nightly cron" was not added: the nightly's own sweep already
  spends its leftover time reading line items of sales the backfill listed.
- **Owner setup (production, after #7)** — GitHub → the repository → Settings → Secrets and
  variables → Actions:
  1. Secret `APP_URL` = the production URL (`https://…`, no path).
  2. Secret `CRON_SECRET` = exactly the app's `CRON_SECRET` (Vercel → Environment Variables).
  3. Variable `BACKFILL_ENABLED` = `true` (set it to anything else, or delete it, to stop the trigger).
  4. Optionally run it once by hand: Actions → "History backfill" → Run workflow (outside the night
     window it answers 200 and does nothing).
  The optional `BACKFILL_*` variables go in Vercel. If you change `BACKFILL_NIGHT_WINDOW`, change the
  workflow's cron (UTC) to match.
- By hand: `curl -H "Authorization: Bearer $CRON_SECRET" https://<app>/api/cron/backfill`.
- Tests: `src/sync/backfill.test.ts` (Seam 1, `__fixtures__/backfill-sales.ts`: several chunks = one
  uninterrupted load, crash resume, window, budget, rate limits, unreadable pages, a server ignoring
  the date filter, nightly mid-backfill, yielding, progress, auto start, pause/start), `backfill-config.test.ts`, `backfill-workflow.test.ts` (the workflow's YAML, and
  its step run with a stand-in `curl`), `cron.test.ts` (endpoint auth), `e2e/backfill.spec.ts` (the
  e2e app's window is 08:00–10:00 around its fixed 09:00 clock, budget 50, delay 0.5 s).

### Analytics Service (`src/analytics/`)

The single source of every metric; pages and MCP tools only render its results. Every query
takes `(sql, filter: GlobalFilter)`; sums and averages happen in SQL on `numeric`; money comes back
as exact strings (`"1234.50"`, `Money` in `@/lib/money`), changes are worked out in integer sen.

```ts
getOverviewKpis(sql, filter): Promise<OverviewKpis>
  // { period, previousPeriod, lastYear, total: KpiSet, branches: (KpiSet & { branchId, branchName })[] }
  // KpiSet = { revenue: Kpi<Money>, invoices: Kpi<number>, customers: Kpi<number>, aovPerCustomer: Kpi<Money | null> }
  // Kpi<T> = { value, previousPeriod: { base, change, changePercent }, lastYear: { … } }  (changePercent null when base is 0)
getDataFreshness(sql, { dateFrom?, dateTo?, branchIds? }?): Promise<{ branchId, branchName, dataAsOf: Date | null }[]>
  // latest run that read the branch's whole listing (succeeded, or partial only for missing invoice
  // pages) whose dates include least(dateTo, the day it started); a resumed chain counts from its
  // first run's start (#6);
  // no dateTo = "now" (runs that read the day they ran). An old month never makes today look fresh.
getDoctorRanking(sql, filter, { splitByBranch? }?): Promise<DoctorRanking>
  // { period, totalRevenue (all revenue in the dates + branches: the share denominator; the doctor filter does not apply),
  //   doctors: DoctorRow[] (kind doctor, by revenue desc then name; `branches` per branch when splitByBranch),
  //   groups: { other: StaffGroup, generic: StaffGroup, noStaff: StaffFigures, pending: StaffFigures } }
  // StaffFigures = { revenue: Money, invoices, customers, aovPerCustomer: Money | null, itemsPerInvoice: number | null, sharePercent: number | null }
  // DoctorRow/StaffRow = StaffFigures & { staffId, name, source: "kreloses" | "alias_only", active }; StaffGroup = StaffFigures & { members: StaffRow[] }
listDoctors(sql): Promise<{ id, name }[]>          // kind doctor with a name on lines; the filter bar's doctor options
getPendingLineItems(sql, { dateFrom, dateTo, branchIds? }): Promise<{ invoices, revenue: Money }>
  // sales whose line items are not synced yet (doctor filter ignored on purpose): pages show
  // <PendingLineItemsNote> (src/components/pending-line-items-note.tsx) under a doctor filter
getStaffAliasRevenue(sql, { dateFrom, dateTo, branchIds? }): Promise<Record<aliasId, Money>>   // Settings → Doctors
getDoctorDiscounts(sql, filter): Promise<DoctorDiscounts>   // #12, see "Discounts" above
  // { period, total: DiscountFigures, doctors: StaffDiscountRow[] (by discount desc), groups: { other, generic: StaffDiscountGroup, noStaff },
  //   pendingLineItems }   DiscountFigures = { gross, charged, discount: Money, discountRatePercent, invoices, discountedInvoices, discountedInvoicesPercent }
getDiscountTypes(sql, filter): Promise<DiscountTypes>
  // { period, total: Money, types: { key, label, appliedTo: "item" | "invoice" | "both" | "difference", lines | null, invoices, amount, sharePercent }[] }
searchSales(sql, filter, { customer?, item?, minRevenue?, maxRevenue?, sort?, page?, pageSize? }?): Promise<SalesSearchResult>
  // (#17, MCP search_sales) active sales matching every criterion (customer / item: part of the name, any case;
  // revenue limits inclusive; doctorIds: ≥ 1 line credited to them; a pending sale matches neither doctor nor item),
  // newest first by default: { period, page, pageSize (≤ SALES_SEARCH_MAX_PAGE_SIZE = 50, default 20), totalMatches,
  //   totalPages, totalRevenue, sales: { invoiceId, saleNumber, saleDate, branchId, branchName, customerName | null,
  //   revenue, lineItemsSynced, credits: { staffId | null, name, creditGroup, revenue, lines }[] }[] }
getConnectionSyncStatus(sql): Promise<ConnectionSyncStatus[]>
  // (#17) per connection, by label: { connectionId, label, loginStatus, loginError, lastTestedAt, lastRun: { mode,
  //   outcome: running | succeeded | stopped_at_time_limit | invoice_pages_missing | failed, dateFrom, dateTo,
  //   startedAt, finishedAt, error, warnings: string[] } | null }   (never the Kreloses email or password)
listBranches(sql) / listDoctorNames(sql)   // (#17) directory lookups for resolving typed names: { id, name } / { id, name, lineNames }
// #9 service mix (src/analytics/mix.ts, service-lines.ts) — see "Item groups and service mix":
getServiceMix, getTopItemsByDoctor, getItemRevenue, getServiceLinesByDoctor, getMonthlyServiceLineRevenue,
getServiceLineKpis, getRevenuePerWorkingDay, serviceLineCondition
METRIC_DEFINITIONS   // plain-language definitions (also in CONTEXT.md); MCP results quote them verbatim
```

What counts as revenue — and who it is credited to — is decided in ONE place:
`revenueFacts(sql, factsScope(filter))` in `facts.ts`: one row per credited line (plus the pending
rows), columns `sale_date, branch_id, customer_id, invoice_id, revenue` (after refunds),
`credited_line_id, invoice_line_id, staff_alias_id, staff_id, credit_group, gross_amount` and
`credited_amount` (before refunds; #6) (see
[Credited lines](#credited-lines-the-revenue-model)) plus the item: `item_name, item_type,
item_key, mix_group, is_surgery, is_consult, is_vaccine, is_dental_scaling, is_procedure` (see
[Item groups](#item-groups-and-service-mix-srcitems-9)). Build every new metric on it (`with facts as
(${revenueFacts(sql, scope)}) …`): `sum(revenue)`, `count(distinct invoice_id)`, `count(distinct
customer_id)`, `count(invoice_line_id)` (item lines), grouped by `staff_id` / `credit_group` /
`branch_id` / `sale_date`. With `doctorIds` (staff ids) it keeps only lines credited to them, so
the Overview's KPIs become "credited to the selected doctors". Doctor metric definitions: AOV per
customer = the doctor's revenue ÷ distinct customers with ≥ 1 line credited to them (per branch when
split); items per invoice = their item lines ÷ their invoices; share = revenue ÷ `totalRevenue`. Comparison periods:
`comparisonPeriods()` (previous = same length immediately before; last year = same dates, 29 Feb →
28 Feb). The Seam 1 test (`overview.test.ts`) documents the hand-computed fixture totals.

#### Trends and doctor detail (#10, `src/analytics/trends.ts`, `doctor-detail.ts`)

```ts
getMonthlyTrends(sql, filter, { now? }): Promise<MonthlyTrends>
  // { period, months: TrendMonth[], doctors: DoctorTrend[] (kind doctor with credited lines in the range; by total revenue desc, then name) }
  // TrendMonth = { month: "YYYY-MM", dateFrom, dateTo (the month's days in the range), partial, partialReason: "current_month" | "cut_by_range" | null }
  // DoctorTrend = { staffId, name, source, active, total: TrendFigures (whole range), points: (TrendFigures & { month })[] (one per month, zeros filled) }
  // TrendFigures = { revenue, invoices, customers, aovPerCustomer: Money | null, surgeryRevenue: Money | null, consultRevenue: Money | null }
trendMonths(period, today): TrendMonth[]     // the months a range overlaps, up to the current month (later ones are dropped)
getYearOnYear(sql, filter, { now? }): Promise<YearOnYear>
  // { years: YearColumn[] (first year with a sale in the branches → current year; the DATE RANGE IS IGNORED),
  //   rows: YearOnYearRow[] (doctors by name; an all-branches row (branchId null) when they have revenue at 2+ branches, then each branch) }
  // YearColumn = { year, dateFrom, dateTo, partial (current year: 1 Jan → today), comparedWith: previous whole year | same dates last year (partial) | null (first) }
  // YearOnYearCell = { year, revenue, invoices, customers, aovPerCustomer, base: YearFigures | null, revenueChangePercent, aovChangePercent }
getDoctorDetail(sql, staffId, filter, { now? }): Promise<DoctorDetail>
  // { status: "not_found" } | { status: "not_a_doctor", staff: { staffId, name, kind } }
  // | { status: "ok", doctor, period, totalRevenue, figures: StaffFigures (= their getDoctorRanking row), branches: BranchFigures[],
  //     months, monthly: TrendPoint[], pendingLineItems }   — the filter's own doctorIds are ignored (the view is for staffId)
TREND_MEASURES, availableTrendMeasures()     // revenue, aovPerCustomer, surgeryRevenue, consultRevenue
listTrendDoctors(sql): Promise<TrendDoctor[]> // every doctor, colour-slot order: active Kreloses-listed first, then the rest, by name
ITEM_GROUP_MEASURES_AVAILABLE                // true: #9's surgery/consult flags are on revenueFacts
```

- Months are clinic (KL) calendar months of `sale_date`: a sale at 00:30 KL on the 1st is the new
  month's. A month is **partial** when it is the current month (and the range reaches today) or the
  range cuts it; months after the current one are not listed. AOV per customer in a month = the
  doctor's revenue that month ÷ their distinct customers that month.
- Only doctors get series/rows. Pending sales ("line items not synced yet") are credited to nobody,
  so they are in no series: the Trends page always shows `<PendingLineItemsNote doctorsOnly>`.
- Year on year: each whole year against the previous one; the current year (1 Jan → today) against
  the same dates last year (`addYears`, so 29 Feb → 28 Feb), never against a whole year.
- **Surgery / consult (#9, wired):** `itemGroupRevenue()` sums `revenueFacts` rows with
  `serviceLineCondition(sql, "surgery" | "consult")` (`f.is_surgery` / `f.is_consult`), the same
  definition as the Mix page and the Overview tiles; the measure switch offers
  `?measure=surgery|consult`. `trends.test.ts` has the hand-computed surgery / consult months.
- Seam 1 test: `trends.test.ts` adds its own synthetic sales (`src/analytics/__fixtures__/trend-sales.json`:
  2024 → early 2026, sales at 23:30 KL on 31 Dec and 00:30 KL on the 1st) to the shared fixtures in
  its own fake Kreloses, and documents every hand-computed month and year.

#### Daily sales (#11: `src/analytics/daily.ts`, `/daily`)

```ts
getDailySales(sql, day: IsoDate, filter?: { branchIds?, doctorIds? }): Promise<DailySales>
  // { day, comparisonDays: { lastWeek, lastYear }, total: DailyFigures,
  //   branches: (DailyFigures & { branchId, branchName })[]            every branch in the filter, by name (zeros included)
  //   doctors: (DailyFigures & { staffId, name, source })[]            credited lines on the day OR a comparison day; by revenue on the day
  //   groups: (DailyFigures & { group: "other" | "generic" | "noStaff" | "pending" })[] }   same rule; empty under a doctor filter
  // DailyFigures = { revenue: DailyMetric<Money>, invoices: DailyMetric<number>, customers: DailyMetric<number>, aovPerCustomer: DailyMetric<Money | null> }
  // DailyMetric<T> = { value, lastWeek: KpiChange<T>, lastYear: KpiChange<T> }   (KpiChange: { base, change, changePercent }; % null when base is 0)
dailyComparisonDays(day)       // { lastWeek: day − 7, lastYear: same date a year earlier (29 Feb → 28 Feb) }
defaultDailyDay(now?)          // yesterday at the clinic (Asia/Kuala_Lumpur), whatever the server's time zone
dailyDayProblem(value, now?)   // (#18) null if value is a real date from 2000-01-01 (EARLIEST_DAILY_DAY) up to today at
                               // the clinic (today allowed), else "not_a_date" | "too_early" | "in_the_future"
resolveDailyDay(value, now?)   // value (e.g. ?day=, first if repeated) if dailyDayProblem says it is fine, else defaultDailyDay
DAILY_GROUP_LABELS             // (#18) group → name ("Other staff", …): the page's row names and daily_sales's `label`
formatDayWithWeekday(day, style?)  // @/filters: "Sunday 27 Sep 2026" (moved there from the page for daily_sales)
clinicNow()                    // @/lib/clinic-clock (server only): "now" for clinic-relative defaults; CLINIC_NOW
                               // (ISO instant with zone) freezes it outside production (the e2e suite sets it)
```

- Built on `revenueFacts`, so revenue, invoices, customers and AOV per customer mean exactly what they
  mean on the Overview and Doctors pages (AOV per customer = revenue ÷ distinct customers with ≥ 1
  credited line in scope that day). The global filter's branches and doctors apply; its **date range
  does not** (the day does). Sales whose line items are not synced yet count in the total and branches
  and as the `pending` group (never under a doctor filter — show `<PendingLineItemsNote>` from
  `getPendingLineItems(sql, {dateFrom: day, dateTo: day, branchIds})`).
- Definitions for pages and MCP: `METRIC_DEFINITIONS.dailySales`, `sameWeekdayLastWeek`,
  `sameDateLastYear` (+ the usual revenue / invoices / customers / aovPerCustomer / change).
- The page: `/daily?day=YYYY-MM-DD` (none = yesterday), a day picker (`next/form` GET form + previous /
  next day links, other params kept), totals tiles, "By branch" (with each branch's "data as of" for the
  day) and "By doctor" `<DataTable>`s. On screen each metric shows its value and its change vs last
  week and last year (percentage + amount, arrow + sign + colour); the CSV has, per metric, the value,
  each comparison day's value, the change and the change % (`daily-branches_<day>.csv`,
  `daily-doctors_<day>.csv`).
- MCP `daily_sales` (#18): `getDailySales(sql, day, { branchIds, doctorIds })` with `day` = the
  argument or `defaultDailyDay(now)`; unlike the page it refuses a day `dailyDayProblem` rejects
  (saying why) instead of answering for yesterday.
- Tests: `src/analytics/daily.test.ts` (Seam 1, hand-computed figures for the synthetic scenario in
  `src/analytics/testing/daily-scenario.ts`, dates relative to the day), `e2e/daily.spec.ts` (the same
  scenario around yesterday, with the app's clock fixed by `CLINIC_NOW` = `E2E_CLINIC_NOW` from
  `playwright.config.ts`: yesterday is 27 Sep 2026).

### Retention (`src/analytics/retention.ts`, #13)

New vs returning customers, yearly cohorts and the 90-day return rate, all counted in **service
visits** (definitions: `RETENTION_DEFINITIONS` in `retention-definitions.ts`, spread into
`METRIC_DEFINITIONS`; CONTEXT.md "Retention"). The Retention page (`/retention`) and #18's MCP
`retention` tool only render this:

```ts
getRetention(sql, filter): Promise<Retention>
  // { period, historyFrom, syncedThrough, matureThrough (= syncedThrough − 90), limitedHistory, pendingInvoices,
  //   clinic: RetentionFigures,                              // every service visit; the doctor filter does NOT apply
  //   doctors: (RetentionFigures & { staffId, name, source })[] }   // kind doctor now, within the doctor filter, by name
  // RetentionFigures = { newVsReturning: { customers, newCustomers, returningCustomers, newPercent, returningPercent },
  //                      returns90: { visits, notYetMature, mature, returned, returnPercent },
  //                      cohorts: { year, accruing, partialYear, customers, retainedAnyDoctor, retainedAnyDoctorPercent,
  //                                 retainedSameDoctor, retainedSameDoctorPercent }[] }   // newest year first; same-doctor null for the clinic
  // Percentages: numbers to one decimal, null when the denominator is 0.
```

- **Service visit** — defined ONCE in `src/analytics/service-visits.ts`; every visit-based metric
  (#15's 14-day post-op follow-up included) builds on it rather than re-deriving visits:

  ```ts
  SERVICE_ITEM_TYPE                     // 4 (Kreloses ItemType of a service line)
  serviceVisitLines(sql, branches)      // SQL: one row per credited service line that makes a visit:
                                        //   customer_id, sale_date, branch_id, invoice_id, invoice_line_id, staff_id, credit_group
  serviceVisits(sql, branches)          // SQL: distinct customer_id, sale_date
  syncedThrough(sql, branches)          // SQL scalar date: latest clinic day with a synced sale (any status) at the branches
  // branches: BranchScope (branchScope(filter), or { all: true }); a doctor visit = a line with credit_group 'doctor'
  ```

  A visit = (customer, clinic day) with ≥ 1 credited line of item type 4 and quantity > 0 on an
  active invoice whose lines are current (`revenueFacts` joined to `invoice_lines`). Products,
  discount lines, returned (negative-quantity) lines, cancelled and pending sales and walk-ins never
  make a visit. A visit counts for every doctor credited with one of its service lines; visits
  credited only to other staff / generic / no staff count for the clinic and as returns.
- **Filters** (`METRIC_DEFINITIONS.retentionFilters`, orchestrator decision): the branch filter
  decides which visits put a customer IN a period or cohort (the denominators); whether they are
  new, came back the next year, or returned within 90 days is judged across ALL branches (a customer
  who moves branch is neither new nor lost). The doctor filter only picks the doctors listed (the
  whole-clinic rows and "any doctor" never depend on it). The date range applies to new vs
  returning and the 90-day rate, never to cohorts.
- **Synced history**: `historyFrom` = the earliest clinic day of any synced sale at the SELECTED
  branches; `syncedThrough` = the latest at ANY branch (`syncedThrough(sql, { all: true })`: returns
  count at any branch, and a closed or lagging branch never stays "not yet mature" / "still
  accruing"). A visit is mature once visit day + 90 ≤ `syncedThrough`; a cohort Y is listed once
  `syncedThrough` reaches 1 Jan Y+1, is `accruing` until it reaches 31 Dec Y+1, and is a
  `partialYear` when `historyFrom` is after 7 Jan Y (tolerance: a backfill from 1 Jan whose first
  sale falls in the first week, e.g. after the New Year holiday, is a full year);
  `limitedHistory` = the period starts less than 90 days after `historyFrom`. Caveat: when branches
  were synced from different dates, a customer's earlier visits at a branch whose history starts
  later are not seen.
- SQL does everything (a `lead()` window for "next visit", `min()` over the customer for "first
  visit", one scan of every branch's visit lines with an `in_scope` flag); ~100 ms for 35k invoices
  / 105k lines on the local stack, so no extra index.
- Tests: `retention.test.ts` and `service-visits.test.ts` sync `retention-fixture.ts` (hand-built
  customers 2024–2026 written compactly and emitted in Kreloses's Sale List / Sale Overview shapes)
  through the fake Kreloses; `e2e/retention.spec.ts` syncs the shared fixture months and checks the page.
- `staffCondition(sql, staffScope(filter), column)` is exported from `facts.ts` (the doctor
  filter as a SQL condition), next to `branchCondition`.
- Charts: `<HorizontalBarChart>` now draws a zero value as a 2px stub (`minPointSize`), so a 0.0%
  rate (or RM 0.00) keeps its bar label.

### Upsell (`src/analytics/upsell.ts`, #14)

How often each doctor's consults include diagnostics, products or a second service, and average
items per invoice per month (spec stories 46–47). Definitions: `UPSELL_DEFINITIONS`
(`upsell-definitions.ts`, spread into `METRIC_DEFINITIONS`; names in `UPSELL_METRICS`) and CONTEXT.md
"Upsell". The Upsell page (`/upsell`) and a future MCP tool only render this:

```ts
getConsultAttachRates(sql, filter): Promise<ConsultAttachRates>
  // { period, doctors: (AttachRateSet & { staffId, name, source, active })[]   kind doctor, within the doctor filter,
  //                                                                            with ≥ 1 consult invoice; most consult invoices first, then name
  //   allDoctors: AttachRateSet     every doctor's consult invoices pooled, dates + branches (doctor filter ignored)
  //   pendingLineItems }            sales not synced yet in dates + branches: they cannot be classified, so they are left out
  // AttachRateSet = { consultInvoices, wholeInvoice: AttachFigures, ownLines: AttachFigures }
  // AttachFigures = { diagnostics, products, secondService, anyAddOn: { invoices, percent (1 dp, SQL; null without consult invoices) } }
getItemsPerInvoiceTrend(sql, filter, { now? }): Promise<ItemsPerInvoiceTrend>
  // { period, months: TrendMonth[] (#10's trendMonths: partial months flagged), doctors: { staffId, name, source, active,
  //   total, points: { month, itemLines, invoices, itemsPerInvoice (2 dp | null) }[] }[] }   most invoices first, then name
itemsPerInvoiceSql(sql)   // (./items-per-invoice.ts) THE items-per-invoice aggregate over revenueFacts rows `f`; getDoctorRanking uses it too
```

- **Consult invoice** (orchestrator decision): an active invoice in the dates and branches, line items
  synced, with ≥ 1 line credited to the doctor whose item has the consult flag (#9) and quantity > 0 (a
  free consult counts, a returned one does not). Two consulting doctors on one invoice: it is each one's.
- **Add-on**: a line on that invoice that is NOT a consult line and charged more than zero
  (`invoice_lines.amount`, its own amount after any item discount — so a free add-on, a returned item
  and a discount line, which is no credited line at all, never count). Diagnostics = `mix_group =
  'diagnostics'`; product = ItemType 1 (`PRODUCT_ITEM_TYPE`); second service = ItemType 4 (not
  consult). They overlap (an X-ray service is diagnostics AND a second service); "any add-on" is ≥ 1 of
  the three. An add-on whose credited amount an invoice discount took to 0 still counts (its own line
  charged > 0). Unmapped items have no flags and no group: never a consult line, never diagnostics,
  but a product / second service by ItemType — so the rates move when the owner maps items. **Whole invoice** (the default) counts add-ons credited to anyone on the invoice (the
  visit's basket); **own lines** only those credited to the doctor. Both come back from one query.
- Pending sales (line items not synced yet) cannot be classified: excluded, and the page shows
  `<PendingLineItemsNote doctorsOnly>` with `pendingLineItems`.
- Items per invoice over time = #5's definition (`itemsPerInvoiceSql`) per clinic month; the whole
  period equals the Doctors page's figure (tested).
- The page: attach-rate `<GroupedBarChart>` (series = the three add-on kinds, slots 1–3) and table
  (`upsell-attach-rates[-own-lines]` CSV, with each rate's invoice count as an export-only column),
  the `?addons=own` switch (page-specific param the filter bar keeps), the items-per-invoice
  `<LineTrendChart axisFormat="decimal">` (toggleable doctors, colours in `listTrendDoctors` order as on
  Trends) and monthly table (`upsell-items-per-invoice` CSV with the lines and invoices behind each
  figure), empty states per section.
- Tests: `upsell.test.ts` (Seam 1) syncs `testing/upsell-scenario.ts` (hand-built sales, Aug–Sep 2026:
  diagnostics by another doctor, a free product, two consult lines, consult + surgery, a discount line,
  a returned product, a missing invoice page…) and documents every hand-computed rate, plus
  `UPSELL_EDGE_CASES` (free and returned consults, an add-on credited 0 by a discount line, unmapped
  items, and an item mapped as a consult afterwards);
  `e2e/upsell.spec.ts` serves the same scenario through the fake and checks the page, CSVs and filters.
  `syntheticSales` lines may now be `itemType: 55` (a discount line: negative amount, no staff).

### Item groups and service mix (`src/items/`, #9)

Every item sold (discount lines excluded) is in one of eight **service-mix groups** — keys
`MIX_GROUPS` = `consult`, `surgery`, `diagnostics`, `hospital_treatment`, `rehab_tcvm`,
`medicines_supplements`, `preventive`, `retail_other` (labels `MIX_GROUP_LABELS`: Consult, Surgery,
Diagnostics, Hospital & treatment, Rehab & TCVM, Medicines & supplements, Preventive, Retail &
other) — with five **flags** (spec stories 23–27, 35, 40–43; ADR 0010):

| Flag (`revenueFacts` column) | Meaning |
| --- | --- |
| `is_surgery` | A surgery line (spec "Surgery": the SURGERY service, neutering/spay, cryoablation, cystotomy, tooth extraction, pyometra, C-section, FHO, hernia repair, closed reduction, wound stitching, anaesthesia/sedation and related surgical charges) |
| `is_procedure` | An actual operation. Always implies `is_surgery` (the pure checker and CHECK constraints enforce it). `is_surgery and not is_procedure` = a sedation / anaesthesia-only charge — for #15: a surgery case is an operation when ANY of its surgery lines is a procedure, otherwise "sedation only" |
| `is_consult` | A consult line (CONSULTATION services and the TCVM examination; the TCVM exam is in the Consult group) |
| `is_vaccine` | A vaccination (seeded in the Preventive group) — #15 vaccine revenue |
| `is_dental_scaling` | Dental scaling (seeded in the Preventive group) — #15 dental revenue |

Flags are independent of the group (the owner can flag a Diagnostics item as consult), except
procedure ⇒ surgery. Unmapped / no-item / pending rows have every flag false.

- **The matcher** (`src/attribution/item-groups.ts`, PURE): an item is identified by `itemKey(name)`
  (NFKC, trimmed, whitespace collapsed, lower case). Precedence: the owner's **assignment** for the
  item key → **exact** rules (text = key) → **pattern** rules (SQL `ILIKE` semantics on the key:
  `%` any run, `_` one character, `\` escapes; the whole name must match; matched in O(n·m), never
  via a regex) — within exact and within pattern rules by `priority` (higher wins), ties to the
  lower id; an exact rule beats every pattern — else `unmapped`. The first matching rule decides,
  and a rule may say **leave unmapped** (`classification: null`, stored as `mix_group = 'unmapped'`
  with no flags): matching items stay unmapped (`{ source: "unmapped", ruleId }`) instead of falling
  through to a broader rule. `createItemClassifier(rules, assignments)`, `classifyItem`,
  `patternMatches`, `checkItemRule` (validates + normalises a rule), `checkItemFlags`.
- **Tables** (migration `…_item_groups.sql`): `item_group_rules` (`match_type` exact|pattern,
  `pattern` stored normalised, `priority` −10000…10000, `mix_group` (or `unmapped` = leave unmapped), the five `is_*` flags, `source`
  seed|owner, `created_by`; unique (match_type, pattern)); `item_assignments` (`item_key` primary
  key, group + flags, `assigned_by`); `item_classifications` — DERIVED, one row per raw
  `invoice_lines.item_name` of a sold line: `item_key`, `mix_group` (a group or `unmapped`), the
  flags, `source` assignment|rule|unmapped, `rule_id` (also set when a leave-unmapped rule decided). Never copy groups/flags onto `credited_lines`.
- **Keeping `item_classifications` current** (`src/items/store.ts`, its only writer): every rule /
  assignment change (`addItemRule`, `deleteItemRule`, `assignItem`, `clearItemAssignment`) recomputes
  every known name in the same transaction, so every figure over all history follows at commit;
  `saveInvoiceLines` calls `classifyItemNames(tx, names)` for new names; `runSync` first runs
  `reclassifyAllItems(sql)`: every name recomputed under the rules as they are now, writing only rows
  that change (names stored without a row, and rule changes made outside the app). **A migration that
  adjusts seed rules** (plain SQL: it cannot run the matcher) changes only `source = 'seed'` rules,
  by their exact match type + text, never by id, adds rules with `on conflict (match_type, pattern)
  do nothing`, leaves `item_assignments` alone, and does not touch `item_classifications`: the change
  shows from the next sync run (e.g. `…_item_group_seed_refinements.sql`, tested in
  `src/items/seed-refinements-migration.test.ts`). Writers take
  `pg_advisory_xact_lock(hashtext('item_classifications'))`. A name with no row counts as
  `unmapped` in `revenueFacts` (its revenue is never lost). Anything else that inserts
  `invoice_lines` (e.g. a #6 re-credit step) should call `classifyItemNames` in its transaction too.
- **Seed rules**: from the spec's Surgery / Consult definitions plus conservative common vet names
  for the other groups. Priorities: 99 leave unmapped (`%cancel%`; removing the stitches / sutures /
  a drain, cast, bandage, splint or tick itself — "Stitch removal", "Removal of cast", but not
  "Castration - cryptorchid (testicle removal)" or "Mass removal with stitching") · 98 consult (`%consult%`: "Spay consult", "Vaccination &
  consultation"; the TCVM exam) · 96 exceptions (post-op wording only — surgery follow-up / recheck /
  review, post-op check / visit / review, the spay / neuter check itself (`spay check%`, `%spay
  recheck%`, … — "Spay + pre-op check" stays the operation), wound check, check-up → Consult, so
  "Follow-up X-ray" stays Diagnostics and "Follow up vaccination" a vaccine; pre-anaesthetic and
  heartworm tests → Diagnostics; heartworm treatment → Hospital & treatment; a scaling under
  anaesthesia → Preventive dental scaling, NOT a surgery line; drops / anaesthetic creams →
  Medicines; flea comb and the vaccine card / certificate / book / record as a phrase → Retail &
  other ("Vaccination - Rabies (with certificate)" stays a vaccine); the surgical pack /
  consumables itself (`surgery pack` alone or followed by a space or "/", not "Surgery package" or
  "Surgery - Spay package") → Surgery but not an operation) · 95 a generic `%review%` → leave
  unmapped · 94 flushing a foreign body → Hospital & treatment · 93 a foreign body in an eye or ear
  → leave unmapped · 92 operations named by what is removed (mass, tumour, lump, foreign body) · 91 operations (the SURGERY service, `surgery %`, named procedures; C-section anchored as a word) ·
  90 sedation / anaesthesia (surgery, not an operation — "Sedation for X-ray" too, per the spec) ·
  80 preventive · 60 diagnostics, rehab & TCVM · 50 hospital & treatment · 40 medicines · 30 retail;
  owner rules default to 100. Every probe name is pinned in `src/items/store.test.ts`. The owner's
  original hand-built rules were not available: unknown items stay **unmapped** (a visible bucket)
  and Settings → Items is where they are reconciled. Also `listItemRules(sql)`, `listItems(sql)` (per item key: name, spellings, item
  types, lines, source, classification, deciding rule), `loadItemClassifier(sql)`.
- **In `revenueFacts`**: `item_name`, `item_type`, `item_key` (null on the unitemised remainder and
  pending rows), `mix_group` = a group | `unmapped` | `no_item` (unitemised remainder) | `pending`
  (line items not synced yet: its whole revenue base), and the five flags. Every credited sen is in
  exactly one `mix_group`, so group totals add up to revenue (tested per doctor and for the clinic,
  over all history).

Analytics (`src/analytics/mix.ts`, `service-lines.ts`; definitions `METRIC_DEFINITIONS.mixGroup`,
`serviceMix`, `mixShare`, `mixComparison`, `topItems`, `surgeryRevenue`, `consultRevenue`,
`workingDay`, `revenuePerWorkingDay`):

```ts
getServiceMix(sql, filter): Promise<ServiceMix>
  // { period, thresholdPoints (MIX_COMPARISON_THRESHOLD_POINTS = 5),
  //   doctors: { staffId, name, source, revenue, groups: Record<MixBucket, MixComparison> }[]  (the filter's doctors; revenue desc, name)
  //   allDoctors: { revenue, groups: Record<MixBucket, MixShare> }      the clinic average: all doctors in dates + branches (doctor filter ignored)
  //   clinic: { revenue, groups: Record<ClinicMixBucket, MixShare> } } all revenue in dates + branches (doctor filter ignored)
  // MixBucket = MixGroup | "unmapped" (MIX_BUCKETS); ClinicMixBucket adds "no_item" | "pending" (CLINIC_MIX_BUCKETS); labels MIX_BUCKET_LABELS
  // MixShare = { revenue: Money, sharePercent: number | null }  (1 dp; null when the row's total ≤ 0)
  // MixComparison = MixShare & { averageSharePercent, differencePoints (doctor − all doctors, pp, 1 dp),
  //                              comparison: "above" | "below" | "in_line" | null }  (above/below when |difference| ≥ 5.0)
getTopItemsByDoctor(sql, filter, { limit?, groups? }): Promise<{ period, limit, doctors: { staffId, name, revenue, items: TopItem[] }[] }>
  // limit default 5, max 50; TopItem = { itemKey, name (most frequent spelling), group, revenue, sharePercent (of the doctor's revenue), lines, invoices }; positive revenue only
  // groups (#18, MCP item_mix): rank only items in these MixBuckets; shares stay of the doctor's WHOLE revenue; every doctor still listed
getItemRevenue(sql, filter): Promise<Record<itemKey, Money>>   // dates + branches, doctor filter ignored (Settings → Items)
getServiceLinesByDoctor(sql, filter): Promise<{ period, total: ServiceLineFigures, doctors: (ServiceLineFigures & { staffId, name, source })[] }>
  // ServiceLineFigures = { revenue, surgeryRevenue, consultRevenue, surgerySharePercent, consultSharePercent }; total = the whole filter (doctor filter applies);
  // a period without sales: total all "0.00" (shares null), no doctors
getMonthlyServiceLineRevenue(sql, filter, line: "surgery" | "consult"): Promise<{ month: "YYYY-MM"; staffId; revenue: Money }[]>
  // per doctor (kind doctor) per month, by month then doctor name — for the Trends measure switch (#10)
serviceLineCondition(sql, line)   // the SQL fragment `f.is_surgery` / `f.is_consult`, for a query over revenueFacts aliased f
getServiceLineKpis(sql, filter): Promise<ServiceLineKpis>
  // { period, previousPeriod, lastYear, total: { surgeryRevenue: Kpi<Money>, consultRevenue: Kpi<Money> },
  //   branches: (… & { branchId, branchName })[] } — the same comparisons as getOverviewKpis
getRevenuePerWorkingDay(sql, filter, { splitByBranch? }): Promise<Record<staffId, WorkingDayFigures>>
  // { staffId, revenue (= the ranking's revenue), workingDays, revenuePerWorkingDay: Money | null,
  //   branches?: { branchId, revenue, revenuePerWorkingDay }[] }
  // working day = a clinic day with ≥ 1 consult or surgery line credited to them at ANY branch:
  // the branch filter narrows the revenue, never the days
```

Pages: **Mix** (`/mix`, everyone): a stacked bar chart of revenue per group per doctor
(`<StackedBarChart>`), "Revenue by service group" (doctors, all doctors, whole clinic; CSV), "Mix
compared with the clinic average" (shares, ↗ / ↘ at ±5 points), "Surgery and consult revenue", "Top N
items per doctor" (`?top=3|5|10`, default 5). The share table's CSV also has, per group, the
difference in points and Above / Below / In line (export-only columns). **Settings → Items**
(`/settings/items`, owner only): unmapped items by revenue in the URL's period (the top 100 shown,
with the count when there are more; the CSV has all), all items (search `?q=`; same cap), the rules
(add — including "Leave unmapped" — / delete). Changes revalidate the whole dashboard. The
**Doctors** page has "Working days" ("Working days (any branch)" when split by branch: the count is
the doctor's, repeated per branch) and "Revenue per working day"; the **Overview** has Surgery
revenue and Consult revenue tiles, and says how many sales are not synced yet (in revenue but in
neither service line) whenever there are any.

### Surgery department, vaccines and dental (#15)

Spec stories 44–45 and "Metric definitions" Surgery / Surgery case. Definitions:
`SURGERY_DEFINITIONS` (`src/analytics/surgery-definitions.ts`, spread into `METRIC_DEFINITIONS`:
`surgeryCase`, `surgeryOperation`, `sedationOnlyCase`, `surgeryFee`, `wholeVisitValue`,
`topProcedures`, `postOpFollowUp`, `vaccineRevenue`, `dentalScalingRevenue`; CONTEXT.md "Surgery
case" …). Built on `revenueFacts` and #9's flags, so staff remaps and item changes apply at once:

```ts
getSurgeryDepartment(sql, filter): Promise<SurgeryDepartment>          // src/analytics/surgery.ts
  // { period, followUpDays (POST_OP_FOLLOW_UP_DAYS = 14), syncedThrough, matureThrough (= syncedThrough − 14),
  //   pendingLineItems (dates + branches, doctor filter ignored),
  //   total: SurgeryFigures, branches: (SurgeryFigures & { branchId, branchName })[] (every branch in the filter, by name),
  //   doctors: (SurgeryFigures & { staffId, name, source })[] (kind doctor, with a case; by surgery fees desc, then name) }
  // SurgeryFigures = { cases, operations, sedationOnly, surgeryFees, wholeVisitValue, averageSurgeryFee, averageWholeVisitValue,
  //   surgeryFeeSharePercent, followUp: { withoutCustomer, notYetMature, mature, followedUp, followUpPercent } }
getTopProcedures(sql, filter, { limit? }): Promise<TopProcedures>      // limit default 5, clamped 1–50
  // { period, limit, overall: TopProcedure[], doctors: { staffId, name, procedures: TopProcedure[] }[] }
  // TopProcedure = { itemKey, name (most frequent spelling), cases, fees, averageFee }; by fees desc, cases desc, name
getVaccineDentalRevenue(sql, filter): Promise<VaccineDentalRevenue>   // src/analytics/vaccines-dental.ts
  // { period, total, doctors: (… & { staffId, name, source })[] (kind doctor with revenue; by revenue desc) }
  // figures = { revenue, vaccineRevenue, vaccineSharePercent, dentalScalingRevenue, dentalScalingSharePercent }
```

- **Case** = an active sale whose line items are synced with ≥ 1 SOLD surgery line (`is_surgery`,
  `invoice_lines.quantity > 0`: a returned surgery line never makes a case). Pending sales have no
  known lines, so they are never cases — `pendingLineItems` says how many there are and the page
  notes it (without a doctor filter too). **Operation** = a case with ≥ 1 sold `is_procedure` line,
  whoever it is credited to (an invoice-level property: a case where one doctor operates and another
  sedates is an operation for both); otherwise **sedation only**.
- **Attribution**: a case counts for its branch and for EVERY doctor (kind doctor now) with a sold
  surgery line on it. **Surgery fee** = Σ revenue of the case's surgery lines (a doctor: their own;
  the total under a doctor filter: the selected doctors' lines, and only their cases); **whole-visit
  value** = Σ revenue of every line on the sale (all staff; counted in full for each doctor of a
  shared case). Averages = ÷ cases (sen, half away from zero); fee share = fees ÷ whole visit (1 dp).
  Surgery fees ≠ #9's surgery revenue: that counts every surgery line in the period, so a surgery
  item returned on a LATER sale lowers surgery revenue but never the fee of the case it was sold on.
- **Post-op follow-up** reuses #13's `serviceVisits(sql, { all: true })`: another service visit of
  the customer 1–14 days after the case day, at ANY branch (clinic-wide, like retention: a follow-up
  at the other branch counts under a branch filter), possibly after the period. A case is mature
  once case day + 14 ≤ `syncedThrough(sql, { all: true })`; not-yet-mature cases and walk-ins (no
  customer) are out of the rate and counted (`notYetMature`, `withoutCustomer`). The visits are
  materialized and hash-joined to the cases (a correlated `EXISTS` ran per row: 1.3 s all-time at
  35k sales / 13k cases, now ~250 ms; one month ~25 ms on the local stack), so no extra index.
- **Top procedures**: `is_procedure` lines grouped by `item_key`, only on sales where that item was
  SOLD (so the sale is a case): cases = such sales, fees = Σ revenue of the item's lines there. Overall
  = the filter's lines (a doctor filter narrows it), per doctor = lines credited to them.
- **Vaccine / dental-scaling revenue**: Σ revenue of `is_vaccine` / `is_dental_scaling` lines, per
  doctor and for the whole filter (like `getServiceLinesByDoctor`: pending sales are in the total
  revenue only).
- **Page**: Mix has two tabs (`src/app/(dashboard)/mix/mix-tabs.tsx`, links keep the global filter):
  "Service mix" (`/mix`) and "Surgery, vaccines & dental" (`/mix/surgery`, everyone): a stacked
  chart of operations / sedation-only cases per doctor, "Surgery cases by doctor" / "by branch",
  "Post-op follow-up within 14 days", top procedures overall and per doctor (`?top=5|10|20`), and
  "Vaccines and dental scaling" — each a `<DataTable>` with CSV.
- **Tests**: `src/analytics/surgery.test.ts` (Seam 1; every figure hand-computed) syncs the synthetic
  scenario `src/analytics/testing/surgery-scenario.ts` — its OWN item names ("Syn Spay", "Syn
  Sedation" …) classified by explicit owner assignments (`SURGERY_SCENARIO_ASSIGNMENTS`), so the
  figures never depend on the seeded rules. `e2e/surgery.spec.ts` serves the same scenario, inserts
  the assignments before syncing September 2026, and deletes `item_assignments`, owner rules and
  `item_classifications` afterwards (like `e2e/mix.spec.ts`).

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
  `listBranchOptions()` lists the synced `branches` (id = `branches.id`), empty before the first sync;
  `listDoctorOptions()` lists the doctors (`listDoctors`, Analytics Service; id = `staff.id`, what
  `GlobalFilter.doctorIds` holds), empty before the first sync with line items.

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
- **Settings is a hub**: `src/app/(dashboard)/settings/layout.tsx` renders the "Settings" `h1` and
  a tab per settings page from `SETTINGS_NAV_ITEMS` (also in `nav-config.ts`: `href`, `label`,
  optional minimum `role`); `/settings` redirects to the first tab the user's role may see
  (`/forbidden` if none), and the sidebar's Settings link goes straight there (the `landing`
  option on its `NAV_ITEMS` entry), so clicks don't redirect. Tabs today: Doctors (#5), Items (#9), Users. To add a settings
  page: create `src/app/(dashboard)/settings/<name>/page.tsx` that calls
  `requireRole(...)` and returns `<SettingsSection title description>…</SettingsSection>`
  (`@/components/settings/settings-section`, an `h2` — don't render another `PageShell`), then
  add its entry to `SETTINGS_NAV_ITEMS`. The tabs and the e2e suite (`e2e/users.spec.ts`
  visits every tab) pick it up.
- Timestamps for display: `formatClinicDateTime(date)` (`@/filters`) → `'28 Sep 2026, 09:05'` in
  the clinic's time zone. Money: `formatRinggit("1234.50")` → `'RM 1,234.50'`,
  `formatRinggitChange(…)` (`@/lib/money`); counts, % changes and durations in `@/lib/format`.
- KPIs: `<KpiTile title kpi kind="money" | "count">` (`src/components/kpi-tile.tsx`) renders an
  Analytics Service `Kpi` with its changes vs the previous period and last year. The Overview
  (`src/app/(dashboard)/overview/page.tsx`) lays tiles out with a container query (`@container`),
  so columns follow the space available rather than the window. An analytics page shows
  `<NoSalesYet>` while nothing has been synced (`getDataFreshness(sql)` is empty).
- Mobile first (the owner checks numbers on a phone): the shell switches to a top bar + slide-in
  menu below `md`, and the e2e suite asserts no horizontal scrolling at phone width.
- Doctors (`/doctors`, #5): the ranking (`?split=branch` for the per-branch view — a page-specific
  param the filter bar keeps), a bar chart of revenue by doctor, the "not in the ranking" groups, and
  each doctor linked to `/doctors/<staff id>` (the doctor detail page, below).
  Discounts (`/discounts`, #12): totals (discount, rate, invoices discounted), a bar chart of
  discount by doctor, the per-doctor table, the "not in the ranking" groups and the discount types
  (each a `<DataTable>` with CSV); sales with line items not synced yet are named in a note.
  Settings → Doctors (`/settings/doctors`, owner only): every name on lines with its match and
  revenue for the URL's period, a form to credit it to another staff member, and each staff
  member's kind; changes revalidate the whole dashboard.
- Trends (`/trends`, #10): a line chart of each doctor's monthly figure (toggleable lines; clicking a
  line or point opens the doctor), the measure switch (`?measure=aov`, page-specific; surgery and
  consult once item groups exist), a branch switch (writes the global `?branch=`), the monthly
  table and the year-on-year table (whole years; ignores the date range, keeps branch/doctor; its
  CSV is named after the years it covers).
- Doctor detail (`/doctors/<staff id>`, #10): `getDoctorDetail` → KPIs (the ranking's own figures),
  monthly trend and branch split. An unknown id is a 404; a staff member of another kind gets a
  "not a doctor" page. The page is for one doctor: the global doctor filter does not narrow it, and
  picking a single other doctor in the filter bar redirects to that doctor's page. The filter bar
  gets the URL's own `parseFilter` state — never a filter with the page's doctor added — so date or
  branch changes, nav links and "Back to the doctor ranking" never carry `doctor=<this doctor>`.
- UI components: shadcn/ui (`npx shadcn@latest add <component>` → `src/components/ui/`), Tailwind
  utilities, `cn()` from `@/lib/utils`, icons from `lucide-react`.

### Tables and CSV export (`src/components/data-table/`)

Every analytics table is a `<DataTable>` (spec story 55, "export any table to CSV"):

```tsx
const columns: DataTableColumn<Row>[] = [
  { key: "doctor", header: "Doctor", kind: "text", value: (row) => row.name, cell: (row) => <Link …>{row.name}</Link> },
  { key: "revenue", header: "Revenue", kind: "money", value: (row) => row.revenue },     // Money string
  { key: "share", header: "Share of revenue", kind: "percent", value: (row) => row.sharePercent },
  { key: "customers", header: "Customers", kind: "count", value: (row) => row.customers, priority: "secondary" },
];
<DataTable caption="Doctor ranking" columns={columns} rows={rows} rowKey={(row) => row.id}
  export={{ name: "doctors", filter }} testId="doctor-ranking" />
```

- `kind` decides display AND export: `money` (a `Money` string) shows `RM 1,234.50` and exports
  `1234.50` (header gets ` (RM)`); `count` `1,234` / `1234`; `decimal` `1.50`; `percent` `57.2%` /
  `57.2` (header ` (%)`); `text` as is (CSV defuses `= + - @` formulas). `null` shows `—`, exports empty.
- The CSV is built on the server from the same `columns` and `rows` (`toCsv`: RFC 4180, CRLF,
  UTF-8 BOM for Excel) and downloaded in the browser; the file is `<name>_<from>_to_<to>.csv`
  (`csvFileName`). `cell` only changes the display; the CSV always exports `value`.
- Server-renderable (pass column functions from a Server Component). Rows come from the Analytics
  Service already computed. The first column is the row header and stays put when the table
  scrolls sideways on a phone; `priority: "secondary"` hides a column below `sm` (the CSV keeps it).
- `exportOnly: true` keeps a column in the CSV only (e.g. a percentage the page shows inside another
  column's `cell`); `label` is a shorter on-screen header (the CSV always uses `header`).
- `export.rows` exports other rows than those shown — e.g. every row when the table shows only the
  first N (say so in the description; Settings → Items).
- The download button makes sure the file starts with exactly one byte-order mark
  (`withByteOrderMark`): React drops it from a long CSV string on its way to the browser.
- e2e: rows are `data-testid="data-table-row"`, cells `[data-column="<key>"]`, the button "Export CSV".

### Charts (`src/components/charts/`)

- Recharts through shadcn's chart component (`src/components/ui/chart.tsx`, `ChartContainer`).
  Charts are client components that receive plain, already-computed data; a chart is a picture of
  a table that is also on the page (the accessible and exportable view), so give the chart an
  `aria-label` summary and keep the numbers in a `<DataTable>`.
- Colours: `--chart-1` … `--chart-8` in `globals.css` (light and `.dark`), a categorical palette
  validated for colour-blind separation in that order; `seriesColor(slot)` returns `var(--chart-N)`.
  Assign slots in fixed order by a stable key (`stableSeriesSlots(ids)`), never by rank, so a filter
  never repaints the survivors — pass it the FULL key set (e.g. every doctor from `listDoctors`),
  not the rows a filter left; more than 8 series fold into "Other". One series = slot 1, no legend.
  Text (labels, values) uses text colours, never the series colour.
- Marks: bars ≤ 24px with a 4px rounded data end, 2px lines, recessive grid, the exact value
  (pre-formatted `formatRinggit`) at the bar tip / line end, a hover tooltip. Pass numbers for
  geometry only (`Number(money)`); what people read is always the exact formatted string. No
  dual axes. Height follows the rows; width the container (phone-friendly).
- `<HorizontalBarChart data={[{ id, label, value, valueLabel }]} title valueName />` is the ranked
  single-series bar chart (Doctors page). Add new chart kinds next to it following the same rules.
- `<LineTrendChart periods={[{ key, label, partial }]} series={[{ id, label, slot, href?, values, valueLabels }]} title valueName />`
  (#10) is the over-time line chart: one line per series with a legend of toggle buttons (and an
  "open" link per series) when there are several, hollow points for partial periods, clicking a
  line/point goes to its `href` (points are `data-testid="trend-point"` with `data-series`), one
  series = slot 1 with its last value labelled. `formatMonth("2026-09")` → `"Sep 2026"`
  (`charts/month-label.ts`). **Exception to "fold into Other":** a line chart per entity draws the
  series past slot 8 in a neutral colour (`slot: null`) instead of an "Other" line, because an
  "Other" line would be a sum computed in the component and ratios such as AOV per customer cannot
  be summed at all. Trends gives the slots to active doctors in the Kreloses staff list first
  (`listTrendDoctors` order passed as `stableSeriesSlots`'s `compare`), so current doctors get the
  colours and each keeps theirs whatever the filter shows.
- `<GroupedBarChart rows={[{ id, label, values, valueLabels }]} series={[{ key, label, color }]} title domain? />`
  (#14) is the grouped horizontal bar chart (Upsell: attach rates per doctor, one bar per add-on kind):
  series in fixed order with stable colours, a 2px gap between a group's bars, the exact value at each
  tip, an HTML legend and a tooltip listing the row; `domain={[0, 100]}` for percentages.
  `<LineTrendChart axisFormat="decimal">` labels the value axis with plain numbers on round ticks
  (items per invoice) instead of ringgit.
- `<StackedBarChart rows={[{ id, label, values, valueLabels, totalLabel }]} series={[{ key, label, color }]} title />`
  is the part-to-whole chart (Mix page: groups per doctor): series in a fixed order with stable
  colours (the eight groups take slots 1–8 in `MIX_GROUPS` order; "Unmapped" is neutral
  `--muted-foreground`), a 2px surface gap between segments, negatives left of zero, the total at the
  tip, an HTML legend and a tooltip listing every segment.

### MCP server (`src/mcp/`)

`/api/mcp` (`src/app/api/mcp/route.ts` → `handleMcpRequest`, `src/mcp/handler.ts`) is a **stateless**
Streamable HTTP MCP server built on the official SDK (`@modelcontextprotocol/sdk`, pinned): every
POST gets a fresh `McpServer` + `WebStandardStreamableHTTPServerTransport` (no session id, plain
JSON answers, no SSE), so it runs as an ordinary Vercel function. GET/DELETE → 405. It is in
`PUBLIC_EXACT_PATHS` (no sub-paths; a test fails if a route appears under it) and authenticates
itself first (`checkMcpBearerToken`, `src/mcp/auth.ts`):
`Authorization: Bearer <MCP_BEARER_TOKEN>`, compared in constant time; no/short env token → 503 for
everything (fail closed); missing/wrong token → 401 + `WWW-Authenticate: Bearer`. Never log the
token or the `Authorization` header.

**Tools are one file each** in `src/mcp/tools/`, listed once in `MCP_TOOLS` (`tools/index.ts`), each
a thin wrapper over the Analytics Service calls its dashboard page makes:

| Tool (`src/mcp/tools/<kebab-name>.ts`) | Wraps | Notes |
| --- | --- | --- |
| `doctor_performance` | `getDoctorRanking` + `getPendingLineItems` | `splitByBranch` |
| `daily_sales` (#18) | `getDailySales(sql, day, { branchIds, doctorIds })` + `getPendingLineItems` for the day | `day` (default `defaultDailyDay`, yesterday) instead of a period; a day the page would replace (`dailyDayProblem`: not a date, before 2000, in the future) is REFUSED with the reason, never swapped for yesterday; groups carry `label` (`DAILY_GROUP_LABELS`, shared with the page); freshness for the day |
| `search_sales` | `searchSales` | customer / item / amount criteria, paged (≤ 50) |
| `item_mix` (#18) | `getServiceMix` + `getTopItemsByDoctor` + `getServiceLinesByDoctor` + `getPendingLineItems` | `groups` (keys of `MIX_BUCKETS`) narrows every mix row to those buckets (a projection) and ranks top items within them (`getTopItemsByDoctor`'s `groups` option); `topItems` 1–20 (default 5); `groupLabels` names the buckets shown |
| `retention` (#18) | `getRetention` | freshness for EVERY branch (returns count at any branch) |
| `discounts` (#18) | `getDoctorDiscounts` + `getDiscountTypes` | |
| `data_freshness` | `getConnectionSyncStatus` | |

To add one:

```ts
export const myTool = defineTool({                   // src/mcp/tools/my-tool.ts
  name: "my_tool", title: "My tool",
  description: "… ≤ 2,048 characters (Claude Code cuts longer ones) … quote the key METRIC_DEFINITIONS verbatim",
  input: { ...filterInput, /* tool-specific zod fields */ },   // dates/preset, branches, doctors by id or name
  output: { covers: filterOutput, figures: figuresSchema /* satisfies z.ZodType<YourAnalyticsType> */ },
  definitions: ["revenue", "aovPerCustomer", …],               // MetricName[]: returned verbatim in every result
  async run(context, input) {
    const { filter, covers } = await resolveFilter(context, input);   // throws ToolInputError with a helpful message
    const figures = await getMyFigures(context.sql, filter);         // Analytics Service ONLY — no SQL here
    return { data: { covers, figures }, summary: "One or two sentences…", freshness: { dateFrom: filter.dateFrom, dateTo: filter.dateTo, branchIds: filter.branchIds } };
  },
});
```

A definition too long for the 2,048 characters (e.g. `yearlyCohort`, 1,131 on its own) is quoted by
its opening sentences with `definitionExcerpt(name, sentences)` (`tools/text.ts`: sliced verbatim from
the definition, " …" appended). It cuts only at a real sentence end (`splitSentences`: a full stop,
space and capital, but never after an abbreviation such as "e.g.", "i.e.", "Dr." or "No.", a dotted
word, or a single capital letter, which may be an initial, so "…in calendar year Y. Retained…" runs on);
`text.test.ts` checks every excerpt the tools quote. Every result still carries the definition in
full. Thresholds a description or summary names come from the Analytics Service's constants
(`MIX_COMPARISON_THRESHOLD_POINTS`, `FULL_YEAR_HISTORY_BY_DAY`, `DISCOUNTED_INVOICE_THRESHOLD`,
`RETURN_WINDOW_DAYS`, `LIMITED_HISTORY_DAYS`), never retyped (`description-constants.test.ts` changes
them and checks the descriptions and the retention summaries follow).
Summaries only word the service's figures (`formatRinggit`, `percent`, `plural`, `describeCoverage`,
`formatDayWithWeekday`): they choose what to mention, never compute a metric.

The registry (`tools/registry.ts`) does the rest for every tool alike: read-only annotations;
strict input (unknown arguments are refused, so a misspelt filter never widens an answer); a
READ ONLY, REPEATABLE READ transaction around the whole call (one snapshot, any write fails); adds
`summary`, `dataFreshness` (per-branch data as of for `freshness`, `src/mcp/tools/freshness.ts`) and
`definitions` to the structured result; validates it against `output`; puts the summary + freshness
sentence and the same JSON in `content` (Claude Code shows the model only `structuredContent` when
both are present, other clients only the text, so both carry everything — keep results small, e.g.
`search_sales` pages hold at most 50 sales); turns `ToolInputError` into its message and anything
else into a generic error (logged server-side). Shared pieces: `filterInput` / `periodInput` / `branchesInput` /
`doctorsInput`, `resolveFilter`, `filterOutput`, `isoDate` (`tools/filter.ts`); name matching (`tools/names.ts`:
id, exact name, or every typed word starting a word of the name — ambiguous → an error listing the
candidates); `money`, `pendingLineItemsOutput` (`tools/schemas.ts`); `clinicTimestamp` (ISO with
`+08:00`); `describeCoverage` / `describeScope` / `plural` / `percent` / `joinAnd` / `definitionExcerpt` / `splitSentences`
(`tools/text.ts`). The route passes `clinicNow()` as the clock, so "today" (month to date,
`daily_sales`'s yesterday) is the dashboard's, and `CLINIC_NOW` freezes both in tests. Output schemas
are checked by the SDK on every call, so an Analytics Service result that breaks its own type (e.g. a
null where `Money` is promised) fails loudly instead of reaching Claude — that is how #18 found
`getServiceLinesByDoctor` returning a null total for a period without sales. Tests: `src/mcp/mcp.test.ts`
drives the real handler with the SDK's client over a synced throwaway database — add each new tool to
`TOOLS` (and to `PERIODS` if it does not take a period), which the "every tool is behind the token",
"lists exactly the read-only tools", "never writes" and "every result states data as of" tests loop
over, and assert its output equals the Analytics Service function's for the same filter;
`e2e/mcp.spec.ts` compares each tool's answer with its page's CSV export.

## Connect Claude to the MCP server

The app includes a **read-only** MCP server, so Claude can answer questions about the clinic's sales
("which doctor's AOV dropped last month?", "show me Customer 0001's visits in September") with
exactly the dashboard's numbers and definitions. It never changes anything, has no raw SQL tool and
never contacts Kreloses. Its tools (all read-only):

- `doctor_performance` — the Doctors page: each doctor's revenue, AOV per customer, invoices, items
  per invoice and share of revenue, optionally split by branch.
- `daily_sales` — the Daily page: one day's revenue, invoices, customers and AOV per customer by
  branch and doctor, compared with the same weekday last week and the same date last year
  (default yesterday; a future day is refused).
- `search_sales` — individual sales by date, branch, doctor, customer, item and amount, paged, with
  each sale's revenue split per staff member.
- `item_mix` — the Mix page: each doctor's revenue per service group compared with the clinic
  average, their top items and their surgery and consult revenue (optionally for some groups only).
- `retention` — the Retention page: new vs returning customers, the 90-day return rate and yearly
  cohorts (any doctor / same doctor), per doctor and for the whole clinic.
- `discounts` — the Discounts page: each doctor's discount total, discount rate and share of
  invoices discounted, and the discount types used.
- `data_freshness` — data as of per branch, and each Kreloses connection's latest sync.

Every answer states how fresh the data is per branch and carries the definitions of its numbers,
and dates are clinic days (Asia/Kuala_Lumpur).

1. **Create a token** and set it on the server as `MCP_BEARER_TOKEN` (Vercel: Project → Settings →
   Environment Variables, marked sensitive, Production only; then redeploy):

   ```bash
   openssl rand -base64 32
   ```

   Without it (or with one shorter than 32 characters) the endpoint refuses every request.
2. **The URL** is `https://<your-deployment>/api/mcp` (locally `http://localhost:3000/api/mcp` with
   `MCP_BEARER_TOKEN` in `.env.local`).
3. **Claude Code**: add it once, for your user (every project on this machine):

   ```bash
   read -rs "KRELOSES_MCP_TOKEN?MCP token: "; echo      # zsh; bash: read -rsp "MCP token: " KRELOSES_MCP_TOKEN
   claude mcp add --scope user --transport http kreloses https://<your-deployment>/api/mcp \
     --header "Authorization: Bearer $KRELOSES_MCP_TOKEN"
   unset KRELOSES_MCP_TOKEN
   ```

   Then ask, for example, "Using kreloses, rank the doctors for last month". `claude mcp list`
   shows whether it connected. **Never use `--scope project` with a literal token**: it writes the
   header into `.mcp.json` in the repository, which is public (`.mcp.json` is git-ignored here as a
   safety net, but other checkouts may not be).
4. **Claude apps (custom connector)**: add `https://<your-deployment>/api/mcp` as a custom
   connector where the connector settings let you send an `Authorization: Bearer <token>` header.
   This server does not implement OAuth, so a connector that only offers OAuth sign-in cannot use
   it; use Claude Code (or another MCP client that supports custom headers) instead.

**The token grants read access to ALL clinic data** (every sale, customer name and doctor figure):
treat it like a password. Don't paste it into chats, commit it or share screenshots of it; clients
store it in their config (Claude Code: `~/.claude.json`). To revoke it, set a new `MCP_BEARER_TOKEN`
and redeploy, then update each client: the new deployment accepts only the new token. Older Vercel
deployments keep the environment they were built with, so their own URLs
(`<project>-<hash>.vercel.app`) still accept the old token — keep Vercel **Deployment Protection**
on (it guards every deployment URL except the production domain) or delete the old deployments.

Check it by hand (`tools/list` with the token → the seven tools; without it → `401`). Step 3
cleared the variable, so read the token again first:

```bash
read -rs "KRELOSES_MCP_TOKEN?MCP token: "; echo
curl -s https://<your-deployment>/api/mcp \
  -H "Authorization: Bearer $KRELOSES_MCP_TOKEN" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
unset KRELOSES_MCP_TOKEN
```

Answers: `401` = missing or wrong token; `503` = the server has no `MCP_BEARER_TOKEN`; `405` = not a
POST (the server is stateless: no event stream or sessions).

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
- Set `CRON_SECRET` (`openssl rand -hex 32`) as a sensitive variable: Vercel Cron sends it to the
  nightly sync (`vercel.json`, once a day at 19:00 UTC = 03:00 KL, ±59 min on Hobby). Without it the
  nightly endpoint refuses every call and nothing syncs by itself.
- History backfill (#8): in GitHub (Settings → Secrets and variables → Actions) add the secrets
  `APP_URL` and `CRON_SECRET` (the same value as in Vercel) and the variable `BACKFILL_ENABLED=true`
  (see [History backfill](#history-backfill-8)); optionally set `BACKFILL_*` in Vercel.
- Set `CREDENTIALS_ENCRYPTION_KEY` (`openssl rand -base64 32`, a fresh one — never reuse a local
  key) as a sensitive, server-only variable. Losing or changing it means re-entering every
  Kreloses password. Never set `KRELOSES_BASE_URL_*` there (the app refuses to start a login with
  them in production).
- Set `MCP_BEARER_TOKEN` (`openssl rand -base64 32`, a fresh one) as a sensitive, server-only
  variable to turn the MCP server on (see [Connect Claude](#connect-claude-to-the-mcp-server)).
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
