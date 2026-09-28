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
| `KRELOSES_TEST_EMAIL`, `KRELOSES_TEST_PASSWORD`, `KRELOSES_TEST_SESSION_PROBE_MINUTES` | Local only: credentials for `npm run test:live`. Never commit them |
| `SYNC_TIME_BUDGET_SECONDS` | Optional: time budget of one sync invocation (10–280 s, default 200). Keep it well under the function limit (`maxDuration = 300` on the Connections page) |

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
  attribution/    Attribution & Rules — PURE functions: crediting lines, staff-name matching
  staff/          Staff directory + staff names on lines (aliases): matching, remap, kinds
  analytics/      Analytics Service — the single source of every metric (Overview KPIs, doctor
                  ranking, freshness)
  lib/            money (exact RM strings ↔ integer sen, display), format (display only)
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
spec that syncs.

The app under test talks to a **fake Kreloses** (`e2e/support/fake-kreloses-server.ts`, the same
fake the unit tests use, on its own port) via `KRELOSES_BASE_URL_WWW/SEA`, with a throwaway
`CREDENTIALS_ENCRYPTION_KEY` per run. Its synthetic logins are `SYNTHETIC_ACCOUNTS` in
`src/kreloses/testing/fake-kreloses.ts` (`north`, `south`, `both`, `oneTimeCode`, `down`, …). A
spec that creates connections must leave the table empty (the shell spec expects empty states); a
spec that syncs must also empty the synced tables (`clearSyncedData()`). The fake serves the
synthetic Sale List (`sale-list-rows.json`: Aug–Sep 2026 and Sep–Oct 2025) and every sale's
invoice page (`sale-overviews.json`), so a spec can "Sync now" September 2026 and get doctors.

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
unset KRELOSES_TEST_EMAIL KRELOSES_TEST_PASSWORD
```

(The `read "NAME?prompt"` form is zsh; in bash use `read -rp "Kreloses email: " KRELOSES_TEST_EMAIL`
and `read -rsp "Kreloses password: " KRELOSES_TEST_PASSWORD`.) Check the output before sharing it.

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
  `header_version` (+1 whenever a parsed header column changes), `lines_header_version` (the
  version the stored lines were computed for), `lines_current` (**generated**: the two are equal —
  THE definition of "its line items belong to the header as it is now"), `revenue_base`
  (**generated**: what its credited lines add up to; twin of `invoiceRevenueBaseSen`) and
  `line_gap_amount` (net − Σ all line amounts when last read; the gap monitor).
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
  `finished_at`, `counts` (`{pages, invoicesSeen, inserted, updated, unchanged}`), `checkpoint`
  (`{nextPage, pageSize}` — saved with every page, kept on partial/failed), `covered_location_ids`
  (set when the run read its whole listing — succeeded, or partial only for missing invoice pages; drives "data as of"), `error_code` (`auth_failed` | `layout_changed` |
  `rate_limited` | `transient` | `key_problem` | `interrupted` | `internal`) + `error` (shown to users).
  At most one `running` run per connection (unique partial index).
- `connection_locks` — the per-connection lease (above).

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
- **The revenue base** is defined twice, kept equal by a test (`src/sync/lines.test.ts`) and a
  runtime check in `saveInvoiceLines`: `invoiceRevenueBaseSen()` in TypeScript (what credited lines
  add up to) and the generated `invoices.revenue_base` in SQL (what pending rows and reconciliations
  use) — today `net_amount` if active, 0 if cancelled; refunds recorded, not subtracted. Change both
  together (one migration + one function).
- **Stored per invoice read** (`saveInvoiceLines`, `src/sync/lines.ts`, one transaction): the
  lines, the credited lines (`gross_amount`, `line_amount`, `spread_amount`, `credited_amount =
  line_amount + spread_amount`, `staff_alias_id` — null = "No staff on line"), and on the invoice
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
  and its line sync. Reconciliation (tested per branch and month): Σ credited = Σ `revenue_base`.

**#9 (item groups / mix)**: keep the item → group rules in their own table(s) and resolve them at
query time, exactly like staff: add a pure matcher in `src/attribution/` (item name/type →
`{group, surgery, consult, vaccine, dental}`), store the owner's rules (e.g. `item_groups` +
per-name overrides), and add `mix_group` and the four flags as columns of `revenueFacts` by joining
`invoice_lines` (`item_name`, `item_type`) on `invoice_line_id`. Do not copy groups onto
`credited_lines` (a rule change must change history at once, spec story 26). Pending rows have no
item (group "Line items not synced yet"); the unitemised remainder has none either.

**#6 (nightly / change detection / refunds)**: which invoices get their lines (re)read is decided
in ONE place, `invoicesNeedingLines()` (`src/sync/lines.ts`: active and `not lines_current`, i.e.
never read, or the header version moved). To re-read only on line-relevant header changes, bump
`header_version` in `saveInvoicePage` (`src/sync/store.ts`) only for those columns. Refund handling
changes `invoiceRevenueBaseSen()` AND `invoices.revenue_base` together — once the live check shows
how Kreloses represents refunds (`total_refunds`, `raw_detail.RefundInfo` / `CreditNoteInfo`).
Existing credited lines then need re-deriving: bump `header_version` for the affected invoices (they
turn pending and the next sync re-reads them), or add a re-credit step that recomputes
`credited_lines` from stored `invoice_lines`.

**Discounts (#12, `src/analytics/discounts.ts`)**: per SOLD line (a credited item line with
`gross_amount >= 0`: `soldLine()`), discount = `gross_amount − revenue` (the credited amount: after the line's item discount AND its share of the invoice's
discount lines/gap, so a multi-doctor invoice's discount is shared by #5's spread rule — nothing
re-spreads it). Per doctor: discount = Σ gross − Σ charged, rate = discount ÷ gross, an invoice is
"discounted" for them when THEIR share of its discount is > RM 0.05 (`DISCOUNTED_INVOICE_THRESHOLD`).
Return lines (gross < 0) are left out of every discount figure in both functions — totals, rate,
counts, types, difference row — so a return-only invoice is out entirely (orchestrator decision:
counted, a discounted return showed as a positive "discount" at a negative rate); the rate is null
when gross ≤ 0. Pending rows and the unitemised remainder (e.g. a sale with only a discount line)
have no gross and are left out too (`pendingLineItems` says how many are pending). **Refunds are not discounts**: charged is the pre-refund amount — true today because the
revenue base does not deduct refunds; if #6 ever deducts them, discounts must add the refund share
back (the refund test in `discounts.test.ts` fails until then). Discount types come from
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
  // options: { dateRange? (default: current clinic month), timeBudgetMs? (default 200 s),
  //            pageSize?, startPage?, resume? (carry on from the latest partial run of the same
  //            connection + dates), maxRetries? (default 3) }
  // → { status: "succeeded" | "partial" | "failed", runId, counts, error? } | { status: "busy", heldFor, until } | { status: "not_found" }
listSyncRuns(sql, { limit? }): Promise<SyncRun[]>   // newest first, for the Sync status page
```

A run takes the connection's lease (else `busy`, no run row), marks the connection's stale
`running` runs `interrupted` (and runs of deleted connections left `running` for over an hour),
logs in, stores the visible branches (and the connection's login
status) and the staff list (`upsertStaffDirectory`, `src/staff/store.ts`: new staff, renamed staff,
inactive ones; unmatched line names are matched again), then reads Sale List pages serially (the
Reader's polite delay). After each page it opens the invoice page of each of the page's invoices
in `invoicesNeedingLines()` and stores lines + aliases + credited lines per invoice in one
transaction (`saveInvoiceLines`), checking the time budget before each; the page stays the
checkpoint until its line items are done (so carrying on re-reads that page, a no-op for headers,
then the missing line items). `counts.lineItemsRead` counts invoice pages read.

- **A missing invoice page** (the Reader's `PageMissing`: HTTP 404/410, or a redirect anywhere but the
  login page) is skipped: `counts.lineItemsFailed` +1, the invoice stays pending at its revenue base
  and the next run tries it again. A run that read its whole listing but skipped pages ends
  **`partial`** with `coveredLocationIds` set (so it counts for "data as of"), `checkpoint`
  `{nextPage: 1}` (Sync now starts over) and an `invoice_pages_missing` warning; `SyncResult` says
  `stoppedAtTimeLimit: false`. If the first `MISSING_PAGES_TO_FAIL` (3) pages a run tries are all
  missing, it fails (`layout_changed`: something systematic). A page whose content changed
  (`LayoutChanged` proper) still fails the run at once.
- **Warnings** (`sync_runs.warnings`, `SyncResult.warnings`, `SyncWarning` in `src/sync/runs.ts`):
  `invoice_pages_missing`, `staff_list_unreadable` (no readable Staff filter in report 14: the run
  carries on, names stay unmatched, nobody is marked inactive). Sync status and the "Sync now"
  message show them.
- **Counts** (`SyncCounts`): `pages, invoicesSeen, inserted, updated, unchanged, lineItemsRead,
  lineItemsFailed, lineItemGaps`. Older rows lack the new keys; `listSyncRuns` fills them with 0. Each page is upserted
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
with `resume: true`, so syncing a month that stopped at the time limit again carries on from its
checkpoint.

**Extension points.** #5 (line items) is in place (above; `SyncReader` has `listLocations`,
`listStaff`, `listInvoices`, `getInvoice`). #6 (nightly/cron/resume): call `runSync(…, "nightly", { dateRange, startPage: checkpoint.nextPage })`
from a cron route (under `PUBLIC_PATHS`, secret-authenticated); the lease already stops overlapping
runs. #8 (backfill): `mode: "backfill"` over bounded date ranges; `partial` + checkpoint says where
the chunk stopped. Tests: `createSyncHarness(sql)` / `clearSyncTables(sql)` in
`src/sync/test-support.ts` (fake Kreloses, fake clock, recorded sleeps; `h.fake.saleOverviews`
edits line items; `clearSyncTables` empties staff too).

### Analytics Service (`src/analytics/`)

The single source of every metric; pages and (later) MCP tools only render its results. Every query
takes `(sql, filter: GlobalFilter)`; sums and averages happen in SQL on `numeric`; money comes back
as exact strings (`"1234.50"`, `Money` in `@/lib/money`), changes are worked out in integer sen.

```ts
getOverviewKpis(sql, filter): Promise<OverviewKpis>
  // { period, previousPeriod, lastYear, total: KpiSet, branches: (KpiSet & { branchId, branchName })[] }
  // KpiSet = { revenue: Kpi<Money>, invoices: Kpi<number>, customers: Kpi<number>, aovPerCustomer: Kpi<Money | null> }
  // Kpi<T> = { value, previousPeriod: { base, change, changePercent }, lastYear: { … } }  (changePercent null when base is 0)
getDataFreshness(sql, { dateFrom?, dateTo?, branchIds? }?): Promise<{ branchId, branchName, dataAsOf: Date | null }[]>
  // latest run that read the branch's whole listing (succeeded, or partial only for missing invoice
  // pages) whose dates include least(dateTo, the day it started);
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
METRIC_DEFINITIONS   // plain-language definitions (also in CONTEXT.md); #17's MCP answers quote them
```

What counts as revenue — and who it is credited to — is decided in ONE place:
`revenueFacts(sql, factsScope(filter))` in `facts.ts`: one row per credited line (plus the pending
rows), columns `sale_date, branch_id, customer_id, invoice_id, revenue, credited_line_id,
invoice_line_id, staff_alias_id, staff_id, credit_group, gross_amount` (see
[Credited lines](#credited-lines-the-revenue-model)). Build every new metric on it (`with facts as
(${revenueFacts(sql, scope)}) …`): `sum(revenue)`, `count(distinct invoice_id)`, `count(distinct
customer_id)`, `count(invoice_line_id)` (item lines), grouped by `staff_id` / `credit_group` /
`branch_id` / `sale_date`. With `doctorIds` (staff ids) it keeps only lines credited to them, so
the Overview's KPIs become "credited to the selected doctors". Doctor metric definitions: AOV per
customer = the doctor's revenue ÷ distinct customers with ≥ 1 line credited to them (per branch when
split); items per invoice = their item lines ÷ their invoices; share = revenue ÷ `totalRevenue`. Comparison periods:
`comparisonPeriods()` (previous = same length immediately before; last year = same dates, 29 Feb →
28 Feb). The Seam 1 test (`overview.test.ts`) documents the hand-computed fixture totals.

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
  option on its `NAV_ITEMS` entry), so clicks don't redirect. To add a settings page (#5 doctors, #9 items — their slots are reserved
  as comments in the list): create `src/app/(dashboard)/settings/<name>/page.tsx` that calls
  `requireRole(...)` and returns `<SettingsSection title description>…</SettingsSection>`
  (`@/components/settings/settings-section`, an `h2` — don't render another `PageShell`), then
  replace your slot's comment with its entry. The tabs and the e2e suite (`e2e/users.spec.ts`
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
  each doctor linked to `/doctors/<staff id>` (a placeholder with the filter bar; #10 builds it).
  Discounts (`/discounts`, #12): totals (discount, rate, invoices discounted), a bar chart of
  discount by doctor, the per-doctor table, the "not in the ranking" groups and the discount types
  (each a `<DataTable>` with CSV); sales with line items not synced yet are named in a note.
  Settings → Doctors (`/settings/doctors`, owner only): every name on lines with its match and
  revenue for the URL's period, a form to credit it to another staff member, and each staff
  member's kind; changes revalidate the whole dashboard.
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
- Set `CREDENTIALS_ENCRYPTION_KEY` (`openssl rand -base64 32`, a fresh one — never reuse a local
  key) as a sensitive, server-only variable. Losing or changing it means re-entering every
  Kreloses password. Never set `KRELOSES_BASE_URL_*` there (the app refuses to start a login with
  them in production).
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
