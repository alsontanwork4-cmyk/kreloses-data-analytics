-- Kreloses connections: the Kreloses logins (one per branch login) the sync reads with.
--
-- Server-only like every app table: RLS on with no policies, API roles revoked. The password is
-- stored only as an AES-256-GCM envelope (src/connections/encryption.ts) and is never selected
-- for display: the app's list query does not read `password_ciphertext`.

create table public.connections (
  id bigint generated always as identity primary key,
  -- What the owner calls this login, e.g. "Branch North". Trimmed, 1-80 characters.
  label text not null
    constraint connections_label_valid check (label = btrim(label) and char_length(label) between 1 and 80),
  -- The Kreloses sign-in email, stored trimmed and lower-cased (so the unique constraint is
  -- case-insensitive): one connection per Kreloses login.
  kreloses_email text not null
    constraint connections_kreloses_email_normalised
      check (kreloses_email = lower(btrim(kreloses_email)) and kreloses_email like '%_@_%'),
  -- "v1.<key id>.<iv>.<tag>.<ciphertext>" (base64url parts).
  password_ciphertext text not null
    constraint connections_password_envelope check (password_ciphertext ~ '^v[0-9]+\.[0-9a-f]+\.'),
  -- Result of the last login test: untested (saved, test not finished), ok, failed.
  status text not null default 'untested'
    constraint connections_status_valid check (status in ('untested', 'ok', 'failed')),
  -- Machine-readable failure (see src/connections/messages.ts) and the message shown to the owner.
  last_error_code text
    constraint connections_last_error_code_valid check (
      last_error_code in (
        'bad_credentials', 'unexpected_step', 'session_expired', 'layout_changed',
        'rate_limited', 'unreachable', 'key_problem', 'internal'
      )
    ),
  last_error text,
  last_tested_at timestamptz,
  -- Kreloses locations (branches) the login could see at the last successful test:
  -- [{"id": "<Kreloses location id>", "name": "…"}]. Empty until then, and after a failed test.
  visible_locations jsonb not null default '[]'::jsonb
    constraint connections_visible_locations_array check (jsonb_typeof(visible_locations) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint connections_kreloses_email_unique unique (kreloses_email),
  constraint connections_error_matches_status
    check ((status = 'failed') = (last_error_code is not null and last_error is not null)),
  constraint connections_tested_at_matches_status check ((status = 'untested') = (last_tested_at is null))
);

-- Two connections with the same name would be indistinguishable on the page.
create unique index connections_label_unique on public.connections (lower(label));

comment on table public.connections is
  'Kreloses logins (one per branch login) that the sync reads with. Password encrypted at rest; never returned to the browser.';
comment on column public.connections.password_ciphertext is
  'AES-256-GCM envelope v1.<key id>.<iv>.<tag>.<ciphertext>; key from CREDENTIALS_ENCRYPTION_KEY.';

create trigger set_updated_at before update on public.connections
  for each row execute function public.set_updated_at();

alter table public.connections enable row level security;
revoke all on table public.connections from anon, authenticated;
