-- Settings → Users (#16): who invited each manager, and when each person last signed in.
--
-- `created_at` (from the first migration) already records when an email was added to the
-- allow-list, so it doubles as the invite time.

alter table public.app_users
  -- The owner who invited this person (their email, normalised). Null for owners seeded from
  -- OWNER_EMAIL and rows added outside the Users page. Plain text, not a foreign key, so the record
  -- survives if the inviter is ever removed.
  add column invited_by text
    constraint app_users_invited_by_normalised check (invited_by = lower(btrim(invited_by))),
  -- Set each time this email opens a magic link (`/auth/confirm`). Null = never signed in.
  add column last_sign_in_at timestamptz;

comment on column public.app_users.invited_by is
  'Email of the owner who invited this person from Settings → Users; null if seeded or added directly.';
comment on column public.app_users.last_sign_in_at is
  'When this email last opened a magic link; null if never.';
