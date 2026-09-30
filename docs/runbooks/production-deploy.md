# Runbook: production deploy (Vercel + Supabase)

Issue #7. The owner does every production step; `scripts/deploy-wizard.sh` walks through them in
order, checks what is already done, and asks before changing anything. This page is the same
procedure as a checklist, plus troubleshooting. Run the wizard from the main checkout:

```bash
git switch main && git pull --ff-only
scripts/deploy-wizard.sh --dry-run    # optional first: changes nothing, prints every command it would run
scripts/deploy-wizard.sh              # the real run (re-run it any time: finished stages are skipped)
scripts/deploy-wizard.sh --check https://<production-domain>   # just the post-deploy checks, any time
```

The wizard runs on macOS's own bash. It needs `node` (22+), `npm`, `git`, `supabase`, `vercel`, `gh`,
`openssl`, `curl` and `jq`. `--help` lists every option.

## What you need before you start

| Value | Where it comes from | Where it goes |
| --- | --- | --- |
| Vercel login | `vercel login --global-config ~/.vercel-alsontanwork4` (a separate CLI login; set `VERCEL_GLOBAL_CONFIG` to use another folder) | stays in that folder |
| Vercel team slug | your personal Hobby team (`vercel teams ls --global-config …`) | `--scope` of every command |
| Supabase Project URL | Project Settings → Data API (`https://<ref>.supabase.co`) | `NEXT_PUBLIC_SUPABASE_URL` |
| Publishable key | Project Settings → API Keys (`sb_publishable_…`) | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` |
| Transaction pooler string | Connect → Connection String → Transaction pooler (port 6543), password NOT revealed | `DATABASE_URL` (with the password) |
| Session pooler string | the same dialog, Session pooler (port 5432) | migrations only |
| Database password | your password manager (or reset it in Project Settings → Database) | inside the two URLs, percent-encoded |
| Owner email | the email you sign in with | `OWNER_EMAIL` |
| GitHub account that owns the repository | `gh auth status` | runs the `gh secret` / `gh variable` commands |

The Supabase **secret key** (`sb_secret_…`) is not needed: the app never uses it (README,
"Environment variables"). You can export any value above before running the wizard instead of
typing it (names in `--help`). The generated secrets are never read from your shell.

## Checklist (the wizard's 13 stages)

1. **Preflight.** Tools installed; the checkout is a clean, up-to-date `main`; every environment
   variable the code reads is on the wizard's list (it stops otherwise). Optionally `npm ci`,
   `npm run typecheck` and `npm test` (the tests need the local Supabase stack).
2. **Vercel login.** `vercel whoami --global-config ~/.vercel-alsontanwork4`. If it fails, run
   `vercel login --global-config ~/.vercel-alsontanwork4` in another terminal. Then choose the team.
3. **Vercel project.** `vercel link --yes --project kreloses-data-analytics --scope <team>` creates
   the project (Next.js is detected) and connects the GitHub repository, so pushes to `main` deploy
   to production. Confirm in the project's Settings:
   - **Git**: the repository is connected (the wizard runs `vercel git connect` if not).
   - **Functions → Fluid Compute: enabled.** The nightly sync and the backfill run up to 300 s
     (`maxDuration = 300`); on Hobby that needs Fluid compute.
   - **Deployment Protection**: leave it on Standard Protection.
4. **Secrets.** `CREDENTIALS_ENCRYPTION_KEY` (`openssl rand -base64 32`), `CRON_SECRET`
   (`openssl rand -hex 32`) and `MCP_BEARER_TOKEN` (`openssl rand -base64 32`) are generated on your
   machine, unless Vercel already has them. **An existing `CREDENTIALS_ENCRYPTION_KEY` is never
   replaced**: a new key makes every stored Kreloses password unreadable. The wizard offers to save
   a copy to `~/.config/kreloses-data-analytics/production.env`: outside the repository, `chmod 600`.
   You need the MCP token later to connect Claude. Move the file into a password manager when done.
5. **Supabase values.** The values in the table above. The wizard builds
   `DATABASE_URL` = the transaction pooler string with the password **percent-encoded** (`@` → `%40`,
   `/` → `%2F`, `:` → `%3A`, space → `%20`; a raw `@` would split the URL in the wrong place) and
   `?sslmode=require`, and sets `DATABASE_PREPARE=false`. It checks that the URL and the connection
   string belong to the same project. It also tells you which Vercel **Function Region** sits next
   to the database (e.g. `ap-southeast-1` → `sin1`, Singapore). Set it in Settings → Functions.
6. **Environment variables** (Vercel → Production only; previews get none, so they can never touch
   production data), each via `vercel env add NAME production` with the value on stdin:

   | Variable | Stored as |
   | --- | --- |
   | `DATABASE_URL` | sensitive |
   | `DATABASE_PREPARE` = `false` | plain |
   | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | plain |
   | `OWNER_EMAIL` | plain |
   | `CREDENTIALS_ENCRYPTION_KEY`, `CRON_SECRET`, `MCP_BEARER_TOKEN` | sensitive |

   Variables already set are kept. Local/test-only variables (`KRELOSES_BASE_URL_*`, `CLINIC_NOW`,
   `DATABASE_ADMIN_URL`, `E2E_*`, …) must not be in production; the wizard offers to remove them. The
   optional tuning variables (`DATABASE_POOL_MAX`, `SYNC_*`, `BACKFILL_*`) keep their defaults.
7. **Migrations** (this writes to the production database):
   `supabase db push --db-url <session pooler URL> --dry-run` lists what would be applied. After you
   confirm, it runs the same without `--dry-run`. "Remote database is up to date" means nothing to do.
   Never `supabase db reset`, `db pull` or `config push` against production.
8. **Deploy.** `vercel deploy --prod` from the clean `main`. `.vercelignore` keeps `.env*` files and
   `.claude/` (agent worktrees) out of the upload: the CLI does not read `.gitignore`. Note the
   production domain (Settings → Domains), not the deployment's own URL. Later pushes to `main`
   deploy by themselves.
9. **Supabase Auth** (dashboard, by hand):
   - URL Configuration: **Site URL** = `https://<production-domain>`; **Redirect URLs** = exactly
     `https://<production-domain>/auth/confirm`. Remove localhost entries. Never a wildcard such as
     `https://*.vercel.app/**`.
   - Sign In / Providers → Email: **Confirm email ON**, **Allow new users to sign up ON** (the
     app's allow-list decides who gets in).
   - Emails → Templates: **Magic Link** and **Confirm signup** both get subject "Your sign-in link" and
     the body of `supabase/templates/magic_link.html` (link
     `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=email`).
   - Emails → SMTP Settings: **custom SMTP**, strongly recommended. Supabase's built-in email only
     reaches the project's team members and sends a few emails an hour.
   - Never `supabase config push`: the local `supabase/config.toml` must not reach production.
10. **Post-deploy checks** (`--check` runs the same): plain HTTP redirects to HTTPS; `/login` renders;
    a signed-out visitor is sent to `/login`; `/api/cron/nightly` (and `/api/cron/backfill` once #8
    is merged) answer 401 without the secret; `/api/mcp` answers 401 without the token (503 would mean
    `MCP_BEARER_TOKEN` is missing). Vercel → Settings → Cron Jobs lists `/api/cron/nightly`
    (`vercel crons list`). Then **sign in** at `/login` with the owner email via the magic link.
11. **Kreloses.** First the live check (issue #3), from the checkout, in zsh:

    ```bash
    read -r "KRELOSES_TEST_EMAIL?Kreloses email: "; read -rs "KRELOSES_TEST_PASSWORD?Kreloses password: "; echo
    export KRELOSES_TEST_EMAIL KRELOSES_TEST_PASSWORD
    npm run test:live
    KRELOSES_TEST_MONTH=2024-03 npm run test:live   # an old month: its Sale List page and a few invoice pages
    unset KRELOSES_TEST_EMAIL KRELOSES_TEST_PASSWORD
    ```

    Look the redacted reports over, then paste them into issue #3. Then add one connection per branch
    login at `/connections`, run **Sync now** for the current month and compare a day or two with
    Kreloses. After any migration that changes item-group seed rules, press **Sync now** once so
    items are re-classified (README, "Item groups").
12. **History backfill** (only once #8 is on `main`). Before turning it on, check README's
    "UNVERIFIED until the live check" items against the live report:
    - the Sale List date filter is honoured server-side ("rows outside the requested range" is 0);
    - SaleDate's time zone (the KL hour-of-day histogram);
    - `Amount` is after the item discount;
    - the sign of discount lines;
    - the `RefundInfo` / `CreditNoteInfo` shapes;
    - how a walk-in customer is represented;
    - whether item lines also carry an invoice-level `DiscountName`;
    - old invoice pages parse like recent ones (`KRELOSES_TEST_MONTH=2024-03 npm run test:live`;
      otherwise the backfill skips them as unreadable).

    Also Sync now a 2024 month and compare a few of its invoices with Kreloses. Then, as the
    repository owner (`GH_TOKEN=$(gh auth token --user <owner>)`): `gh secret set APP_URL`,
    `gh secret set CRON_SECRET` (the app's value) and `gh variable set BACKFILL_ENABLED --body true`.
    To stop it: `gh variable set BACKFILL_ENABLED --body false`.
13. **Summary.** What is done, what is left, how to connect Claude (README, "Connect Claude to the
    MCP server"), and the rotation notes below.

## Rotating secrets

- `scripts/deploy-wizard.sh --rotate MCP_BEARER_TOKEN` (or `CRON_SECRET`; repeatable) generates a new
  value, replaces it in Vercel, offers the redeploy and updates GitHub's `CRON_SECRET`. Then give
  Claude the new MCP token (README, "Connect Claude").
- Keep **Deployment Protection** on (Standard). Older deployments keep the environment they were
  built with, so their own URLs would still accept the old token; protection keeps those URLs private.
- The database password: reset it in Supabase, then `vercel env rm DATABASE_URL production` and run
  the wizard again (it asks for the new password), and let it redeploy.
- `CREDENTIALS_ENCRYPTION_KEY` is never rotated by the wizard. A new key means re-entering every
  Kreloses password on the Connections page.

## Troubleshooting

- **The magic link never arrives.** Supabase's built-in email only sends to the project's team
  members, and only a few emails an hour. Set up custom SMTP (stage 9). Also check spam, and the
  Auth logs in the Supabase dashboard.
- **The link opens but says it is invalid or expired**, or lands on localhost. The Redirect URL must
  be exactly `https://<production-domain>/auth/confirm`, the Site URL the production domain, and both
  templates must use the `token_hash` link. A link can be used once, within an hour.
- **"Signups not allowed for otp".** Turn "Allow new users to sign up" back on. The allow-list still
  decides who gets in.
- **`/api/cron/nightly` answers 401 to Vercel Cron** (Vercel → Logs; nothing syncs overnight).
  `CRON_SECRET` is missing, shorter than 16 characters, or was added after the last deployment:
  redeploy. The endpoint also answers 401 to anyone without the secret; that is correct.
- **The backfill workflow fails with 401.** GitHub's `CRON_SECRET` differs from the app's. Run
  stage 12 again, or `--rotate CRON_SECRET`, which updates both.
- **`prepared statement "…" does not exist` / `already exists`.** `DATABASE_URL` uses the transaction
  pooler (6543), which cannot keep prepared statements: set `DATABASE_PREPARE=false` and redeploy.
- **Migration out of order** ("Found local migration files to be inserted before the last migration
  on remote database", or "Remote migration versions not found in local migrations directory").
  The production history and `supabase/migrations` disagree. Compare them with
  `supabase migration list --db-url <session pooler URL>`. Never edit a migration already on `main`.
  Use `--include-all` only when you understand why an older migration was never applied. If the
  project holds migrations from something else, stop: it is the wrong project.
- **`password authentication failed`** during migrations. Wrong password, or the wrong project's
  connection string. The wizard percent-encodes the password itself, so paste it raw.
- **Functions time out, or every sync ends "at its time limit".** Fluid compute is off (Settings →
  Functions), or the Function Region is far from the database. Keep `SYNC_TIME_BUDGET_SECONDS` well
  under 300.
- **`/login` answers 401 or 403.** You are on a deployment URL behind Deployment Protection: use the
  production domain.
- **`/api/mcp` answers 503.** `MCP_BEARER_TOKEN` is not set (or shorter than 32 characters) in
  Production: set it and redeploy.
- **The wizard stops: "the code reads environment variables this wizard does not know".** A new
  variable was added without updating the lists at the top of `scripts/deploy-wizard.sh`. Add it
  there, to `.env.example` and to README "Environment variables".
- **`vercel link` did not connect GitHub.** Vercel's GitHub app needs access to the repository:
  Vercel → the project → Settings → Git → Connect, then grant access.

## What the wizard never does

- Print a secret. Secrets reach `vercel` and `gh` on stdin, never as arguments. The one exception
  is the migration's `--db-url`, which the Supabase CLI only takes as an argument; the wizard
  prints it with the password hidden.
- Write a secret inside the repository, or put any value in this public repository.
- Replace `CREDENTIALS_ENCRYPTION_KEY`, or read a generated secret from your shell environment.
- Push `supabase/config.toml` to production, or touch another Vercel CLI login.
