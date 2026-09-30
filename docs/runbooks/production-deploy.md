# Runbook: production deploy (Vercel + Supabase)

Issue #7. The owner does every production step; `scripts/deploy-wizard.sh` walks through them in
order, checks what is already done, and asks before changing anything. This page is the same
procedure as a checklist, plus troubleshooting. Run the wizard from the main checkout:

```bash
git switch main && git pull --ff-only
scripts/deploy-wizard.sh --dry-run    # optional first: changes nothing, prints every command it would run
scripts/deploy-wizard.sh              # the real run (re-run it any time: finished stages are skipped)
scripts/deploy-wizard.sh --check https://<production-domain>   # just the post-deploy checks, any time
scripts/deploy-wizard.sh --migrate    # just the database migrations (after merging new ones: see below)
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
| Database password | your password manager (or reset it in Project Settings → Database) | percent-encoded inside `DATABASE_URL`; `PGPASSWORD` for migrations |
| Owner email | the email you sign in with | `OWNER_EMAIL` |
| GitHub account that owns the repository | `gh auth status` | runs the `gh secret` / `gh variable` commands |

The Supabase **secret key** (`sb_secret_…`) is not needed: the app never uses it (README,
"Environment variables"). The generated secrets are never read from your shell.

Any value above can be exported before running the wizard instead of typed (names in `--help`).
Export a secret without typing it on a command line (that would land in your shell history), in zsh:

```bash
read -rs "SUPABASE_DB_PASSWORD?Database password: "; echo; export SUPABASE_DB_PASSWORD
scripts/deploy-wizard.sh
unset SUPABASE_DB_PASSWORD
```

## Checklist (the wizard's 13 stages)

1. **Preflight.** Tools installed; the checkout is a clean, up-to-date `main`; every environment
   variable the code reads is on the wizard's list (it stops otherwise). Optionally `npm ci`,
   `npm run typecheck` and `npm test` (the tests need the local Supabase stack).
2. **Vercel login.** `vercel whoami --global-config ~/.vercel-alsontanwork4`. If it fails, run
   `vercel login --global-config ~/.vercel-alsontanwork4` in another terminal. Then choose the team.
3. **Vercel project.** `vercel link --yes --project kreloses-data-analytics --scope <team>` creates
   the project (Next.js is detected) and connects the GitHub repository. `vercel link` also writes a
   short-lived `VERCEL_OIDC_TOKEN` into the checkout's `.env.local`, which `.gitignore` and
   `.vercelignore` both keep out. Confirm in the project's Settings:
   - **Git**: the repository is connected (the wizard runs `vercel git connect` if not). Only
     `main` builds from Git: `vercel.json`'s `git.deploymentEnabled` (`{"main": true, "**": false}`)
     turns off preview builds of every other branch. On Hobby those would each take the one build
     slot and count against the daily build limit, queueing production behind previews that
     cannot run anyway (they get no environment variables).
   - **Functions → Fluid Compute: enabled.** The nightly sync and the backfill run up to 300 s
     (`maxDuration = 300`); on Hobby that needs Fluid compute.
   - **Deployment Protection**: leave it on Standard Protection.
4. **Secrets.** `CREDENTIALS_ENCRYPTION_KEY` (`openssl rand -base64 32`), `CRON_SECRET`
   (`openssl rand -hex 32`) and `MCP_BEARER_TOKEN` (`openssl rand -base64 32`) are generated on your
   machine, unless Vercel already has them. **An existing `CREDENTIALS_ENCRYPTION_KEY` is never
   replaced**: a new key makes every stored Kreloses password unreadable. If `vercel env list` comes
   back in a shape the wizard does not recognise, it stops rather than assume nothing is set. The
   wizard offers to save a copy to `~/.config/kreloses-data-analytics/production.env`: outside the
   repository, `chmod 600`. You need the MCP token later to connect Claude. Move the file into a
   password manager when done.
5. **Supabase values.** The values in the table above. The wizard builds
   `DATABASE_URL` = the transaction pooler string with the password **percent-encoded** (`@` → `%40`,
   `/` → `%2F`, `:` → `%3A`, space → `%20`; a raw `@` would split the URL in the wrong place) and
   `?sslmode=require`, and sets `DATABASE_PREPARE=false`. It checks that the URL and the connection
   string belong to the same project, and that `vercel.json`'s `"regions"` (`["sin1"]`, Singapore)
   sits next to the database's region (`ap-southeast-1`); it warns if they differ. Hobby allows one
   region. After the deploy, Settings → Functions shows `sin1`.
6. **Environment variables** (Vercel → Production only; previews get none, so they can never touch
   production data), each via `vercel env add NAME production` with the value on stdin:

   | Variable | Stored as |
   | --- | --- |
   | `DATABASE_URL` | sensitive |
   | `DATABASE_PREPARE` = `false` | plain |
   | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | plain |
   | `OWNER_EMAIL` | plain |
   | `CREDENTIALS_ENCRYPTION_KEY`, `CRON_SECRET`, `MCP_BEARER_TOKEN` | sensitive |

   Variables already set are kept. Local/test-only variables (`KRELOSES_BASE_URL_*`, `KRELOSES_TEST_*`,
   `CLINIC_NOW`, `DATABASE_ADMIN_URL`, `E2E_*`, …) must not be in production; the wizard offers to
   remove them. The optional tuning variables (`DATABASE_POOL_MAX`, `SYNC_*`, `BACKFILL_*`) keep their
   defaults.
7. **Migrations** (this writes to the production database):
   `PGPASSWORD=… supabase db push --db-url postgresql://postgres.<ref>@<host>:5432/postgres --dry-run`
   lists what would be applied. The password travels in `PGPASSWORD`, never on the command line.
   After you confirm, it runs the same without `--dry-run`. "Remote database is up to date" means
   nothing to do. Never `supabase db reset`, `db pull` or `config push` against production.
8. **Deploy.** `vercel deploy --prod` from the clean `main`. `.vercelignore` keeps `.env*` files and
   `.claude/` (agent worktrees) out of the upload: the CLI does not read `.gitignore`. Note the
   production domain (Settings → Domains), not the deployment's own URL. Later merges to `main`
   deploy by themselves (but see "After merging new migrations").
9. **Supabase Auth** (dashboard, by hand):
   - URL Configuration: **Site URL** = `https://<production-domain>`; **Redirect URLs** = exactly
     `https://<production-domain>/auth/confirm`. Remove localhost entries. Never a wildcard such as
     `https://*.vercel.app/**`, and no preview URLs.
   - Sign In / Providers → Email: **Confirm email ON**, **Allow new users to sign up ON** (the
     app's allow-list decides who gets in).
   - Emails → Templates: **Magic Link** and **Confirm signup** both get subject "Your sign-in link" and
     the body of `supabase/templates/magic_link.html` (link
     `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=email`).
   - Emails → SMTP Settings: **custom SMTP**, strongly recommended. Supabase's built-in email only
     reaches the project's team members and sends a few emails an hour. Then raise Rate Limits →
     emails sent per hour: a low default applies with custom SMTP too.
   - Never `supabase config push`: the local `supabase/config.toml` must not reach production.
10. **Post-deploy checks** (`--check` runs the same): plain HTTP redirects to HTTPS; `/login` renders;
    a signed-out visitor is sent to `/login`; `/api/cron/nightly` and `/api/cron/backfill` answer 401
    without the secret; `/api/mcp` answers 401 without the token (503 would mean `MCP_BEARER_TOKEN`
    is missing). Vercel → Settings → Cron Jobs lists `/api/cron/nightly` (`vercel crons list`).
    Then **sign in** at `/login` with the owner email via the magic link.
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
12. **History backfill** (GitHub Actions trigger, `.github/workflows/backfill.yml`). The switch is the
    repository variable `BACKFILL_ENABLED`, and the wizard never changes it without asking:
    - **Not set yet:** before turning it on, check README's "UNVERIFIED until the live check" items
      against the live reports:
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
      repository owner (`GH_TOKEN=$(gh auth token --user <owner>)`), it sets the secrets `APP_URL`
      and `CRON_SECRET` (the app's value) and the variable `BACKFILL_ENABLED=true`.
    - **`false` (you switched it off):** the wizard asks "Switch it back on?" and otherwise leaves it off.
    - **Whatever the switch says**, when the app gets a new `CRON_SECRET` (e.g.
      `--rotate CRON_SECRET`), a copy GitHub already has is updated at once. Otherwise every backfill
      run gets 401.

    Off by hand: `gh variable set BACKFILL_ENABLED --body false`.
13. **Summary.** What is done, what is left, how to connect Claude (README, "Connect Claude to the
    MCP server"), and the rotation notes below.

## After merging new migrations

Once GitHub is connected, **every merge to `main` deploys the code by itself, but migrations are
never applied automatically.** After merging anything under `supabase/migrations/`, run
`scripts/deploy-wizard.sh --migrate` straight away. It checks the checkout, asks for the connection
strings and the password, shows what would be applied, and applies it after you confirm. The new
code goes live when Vercel's build finishes, a minute or two after the merge. Until the migration is
applied, anything that uses the new tables or columns fails. Migrations here only add (tables,
columns, rules), so applying them while the old code still runs is safe. When a change's code must
not run before its migration, run `--migrate` as soon as the merge lands. The wizard applies only
what is on `main`.

## Rotating secrets

- `scripts/deploy-wizard.sh --rotate MCP_BEARER_TOKEN` (or `CRON_SECRET`; repeatable) generates a new
  value, replaces it in Vercel in place (`vercel env update`, value on stdin, so there is no moment
  without the variable) and offers the redeploy. For `CRON_SECRET` it also updates GitHub's copy,
  without touching the backfill switch. Then give Claude the new MCP token (README, "Connect Claude").
- Keep **Deployment Protection** on (Standard). Older deployments keep the environment they were
  built with, so their own URLs would still accept the old token; protection keeps those URLs private.
- The database password: reset it in Supabase, then `vercel env rm DATABASE_URL production` and run
  the wizard again (it asks for the new password), and let it redeploy.
- `CREDENTIALS_ENCRYPTION_KEY` is never rotated by the wizard. A new key means re-entering every
  Kreloses password on the Connections page.

## Troubleshooting

- **The magic link never arrives.** Supabase's built-in email only sends to the project's team
  members, and only a few emails an hour. Set up custom SMTP and raise the email rate limit
  (stage 9). Also check spam, and the Auth logs in the Supabase dashboard.
- **The link opens but says it is invalid or expired**, or lands on localhost. The Redirect URL must
  be exactly `https://<production-domain>/auth/confirm`, the Site URL the production domain, and both
  templates must use the `token_hash` link. A link can be used once, within an hour.
- **"Signups not allowed for otp".** Turn "Allow new users to sign up" back on. The allow-list still
  decides who gets in.
- **`/api/cron/nightly` answers 401 to Vercel Cron** (Vercel → Logs; nothing syncs overnight).
  `CRON_SECRET` is missing, shorter than 16 characters, or was added after the last deployment:
  redeploy. The endpoint also answers 401 to anyone without the secret; that is correct.
- **The backfill workflow fails with 401.** GitHub's `CRON_SECRET` differs from the app's. Vercel
  keeps the app's copy write-only, so run `scripts/deploy-wizard.sh --rotate CRON_SECRET`: it sets a
  new secret in Vercel and GitHub together and redeploys.
- **Pages fail right after a merge** (e.g. `column … does not exist`). The merge added a migration
  that is not applied yet: `scripts/deploy-wizard.sh --migrate`.
- **`prepared statement "…" does not exist` / `already exists`.** `DATABASE_URL` uses the transaction
  pooler (6543), which cannot keep prepared statements: set `DATABASE_PREPARE=false` and redeploy.
- **Migration out of order** ("Found local migration files to be inserted before the last migration
  on remote database", or "Remote migration versions not found in local migrations directory").
  The production history and `supabase/migrations` disagree. Compare them with
  `PGPASSWORD=… supabase migration list --db-url <session pooler URL without the password>`. Never
  edit a migration already on `main`. Use `--include-all` only when you understand why an older
  migration was never applied. If the project holds migrations from something else, stop: it is the
  wrong project.
- **`password authentication failed`** during migrations. Wrong password, or the wrong project's
  connection string. Paste the password raw: the wizard hands it to the Supabase CLI as it is, and
  percent-encodes it only for `DATABASE_URL`.
- **Functions time out, or every sync ends "at its time limit".** Fluid compute is off (Settings →
  Functions), or the functions run far from the database (check `"regions"` in `vercel.json`). Keep
  `SYNC_TIME_BUDGET_SECONDS` well under 300.
- **`/login` answers 401 or 403.** You are on a deployment URL behind Deployment Protection: use the
  production domain.
- **`/api/mcp` answers 503.** `MCP_BEARER_TOKEN` is not set (or shorter than 32 characters) in
  Production: set it and redeploy.
- **The wizard stops: "the code reads environment variables this wizard does not know".** A new
  variable was added without updating the lists at the top of `scripts/deploy-wizard.sh`. Add it
  there, to `.env.example` and to README "Environment variables".
- **The wizard stops: it "did not recognise the list of environment variables".** A newer Vercel CLI
  changed `vercel env list --format json`. Nothing was generated or changed. Check the variables in
  the dashboard and update `load_vercel_env` in the wizard.
- **`vercel link` did not connect GitHub.** Vercel's GitHub app needs access to the repository:
  Vercel → the project → Settings → Git → Connect, then grant access.

## What the wizard never does

- Print a secret, or put one on a command line. Secrets reach `vercel` and `gh` on stdin, and the
  database password reaches the Supabase CLI in `PGPASSWORD`.
- Write a secret inside the repository, or put any value in this public repository.
- Replace `CREDENTIALS_ENCRYPTION_KEY`, read a generated secret from your shell environment, or
  switch the history backfill on or back on without asking.
- Push `supabase/config.toml` to production, or touch another Vercel CLI login.
