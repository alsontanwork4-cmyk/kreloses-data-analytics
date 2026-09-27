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

/** Ensures `email` is on the list as an owner (promoting a manager). Never demotes anyone. */
export async function upsertOwner(sql: Sql, email: string): Promise<AppUser> {
  await sql`
    insert into app_users (email, role) values (${normaliseEmail(email)}, 'owner')
    on conflict (email) do update set role = 'owner' where app_users.role <> 'owner'
  `;
  return { email: normaliseEmail(email), role: "owner" };
}
