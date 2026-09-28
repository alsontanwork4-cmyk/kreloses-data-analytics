import "server-only";

import { redirect } from "next/navigation";
import { cache } from "react";

import { lookupAccess } from "./access";
import type { Access } from "./allow-list";
import { FORBIDDEN_PATH, loginPath } from "./paths";
import { hasRole, type AppUser, type Role } from "./roles";
import { createSupabaseServerClient, sessionEmail } from "./supabase";

/**
 * Who is making this request: `anonymous`, `denied` (signed in but not on the allow-list) or
 * `allowed` with their role. Memoised per request.
 */
export const getAccess = cache(async (): Promise<Access> => {
  const supabase = await createSupabaseServerClient();
  return lookupAccess(await sessionEmail(supabase));
});

/** The signed-in, allow-listed user, or null. */
export async function getCurrentUser(): Promise<AppUser | null> {
  const access = await getAccess();
  return access.status === "allowed" ? access.user : null;
}

/**
 * For Server Components, layouts and Server Actions. Returns the allow-listed user, or redirects
 * to the login page (anonymous, or signed in but not on the allow-list). Call it at the top of
 * EVERY page and server action, even though the proxy already gates requests.
 */
export async function requireUser(): Promise<AppUser> {
  const access = await getAccess();
  if (access.status === "anonymous") redirect(loginPath());
  if (access.status === "denied") redirect(loginPath({ error: "access-denied" }));
  return access.user;
}

/** Like `requireUser`, but also requires `role` (owners pass every check); otherwise shows /forbidden. */
export async function requireRole(role: Role): Promise<AppUser> {
  const user = await requireUser();
  if (!hasRole(user, role)) redirect(FORBIDDEN_PATH);
  return user;
}
