import type { Sql } from "@/db/sql";

import type { AppUser, Role } from "./roles";

/**
 * The sign-in allow-list (`app_users`). Supabase Auth only proves who someone is; this decides
 * whether they may use the app and with which role. Functions take the connection explicitly so
 * tests can run them against a throwaway database.
 */

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A plausible email address (checked after `normaliseEmail`). Supabase Auth has the final say. */
export function isValidEmail(email: string): boolean {
  return email.length <= 254 && EMAIL.test(email);
}

export type Access =
  | { status: "anonymous" }
  | { status: "denied"; email: string }
  | { status: "allowed"; user: AppUser };

/** Decides access for the (already authenticated) email, or `anonymous` when there is none. */
export async function checkAccess(sql: Sql, email: string | null | undefined): Promise<Access> {
  if (!email) return { status: "anonymous" };
  const user = await findAppUser(sql, email);
  return user ? { status: "allowed", user } : { status: "denied", email: normaliseEmail(email) };
}

export async function findAppUser(sql: Sql, email: string): Promise<AppUser | null> {
  const [row] = await sql<AppUser[]>`
    select email, role from app_users where email = ${normaliseEmail(email)}
  `;
  return row ?? null;
}

/** Adds an email to the allow-list, or changes its role if it is already there. */
export async function addAppUser(sql: Sql, email: string, role: Role): Promise<AppUser> {
  const [row] = await sql<AppUser[]>`
    insert into app_users (email, role) values (${normaliseEmail(email)}, ${role})
    on conflict (email) do update set role = excluded.role
    returning email, role
  `;
  return row!;
}

/** Removes an email from the allow-list. Their next request is refused. */
export async function removeAppUser(sql: Sql, email: string): Promise<boolean> {
  const rows = await sql`delete from app_users where email = ${normaliseEmail(email)}`;
  return rows.count > 0;
}

/** One row of the allow-list as the owner sees it on Settings → Users. */
export interface AllowListEntry extends AppUser {
  /** When the email was added to the allow-list (for a manager: when they were invited). */
  addedAt: Date;
  /** The owner who invited them from Settings → Users; null for seeded owners. */
  invitedBy: string | null;
  /** When they last opened a magic link; null if never. */
  lastSignInAt: Date | null;
}

/** Everyone on the allow-list: owners first, then managers, each in the order they were added. */
export async function listAllowList(sql: Sql): Promise<AllowListEntry[]> {
  return sql<AllowListEntry[]>`
    select email, role, created_at as added_at, invited_by, last_sign_in_at
    from app_users
    order by role = 'owner' desc, created_at, email
  `;
}

/** Notes that `email` just signed in (opened a magic link). No-op for emails not on the list. */
export async function recordSignIn(sql: Sql, email: string): Promise<void> {
  await sql`update app_users set last_sign_in_at = now() where email = ${normaliseEmail(email)}`;
}

/** Ensures `email` is on the list as an owner (promoting a manager). Never demotes anyone. */
export async function upsertOwner(sql: Sql, email: string): Promise<AppUser> {
  await sql`
    insert into app_users (email, role) values (${normaliseEmail(email)}, 'owner')
    on conflict (email) do update set role = 'owner' where app_users.role <> 'owner'
  `;
  return { email: normaliseEmail(email), role: "owner" };
}
