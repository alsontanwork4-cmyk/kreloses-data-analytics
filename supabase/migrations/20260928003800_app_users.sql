-- App foundation: shared trigger function + the sign-in allow-list.
--
-- Migration rules (see README "Database"): plain Postgres only. Never reference the `auth`,
-- `storage` or `extensions` schemas, because tests apply every migration to a fresh, plain
-- database on the local cluster. App tables are server-only: enable RLS, add no policies, and
-- revoke the Supabase API roles.

-- Keeps `updated_at` current. Reuse it on any table with an `updated_at` column:
--   create trigger set_updated_at before update on <table>
--     for each row execute function public.set_updated_at();
create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Who may sign in. Supabase Auth proves the email; this table decides access and role.
create table public.app_users (
  id uuid primary key default gen_random_uuid(),
  -- Stored trimmed and lower-cased, which makes the unique constraint case-insensitive.
  email text not null unique
    constraint app_users_email_normalised check (email = lower(btrim(email)) and email like '%_@_%'),
  role text not null
    constraint app_users_role_valid check (role in ('owner', 'manager')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.app_users is
  'Sign-in allow-list. Only emails listed here can use the app; role is owner or manager.';

create trigger set_updated_at before update on public.app_users
  for each row execute function public.set_updated_at();

alter table public.app_users enable row level security;
revoke all on table public.app_users from anon, authenticated;
