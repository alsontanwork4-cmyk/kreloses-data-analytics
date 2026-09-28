import type { Sql } from "@/db/sql";

import { isValidEmail, normaliseEmail, type Access } from "./allow-list";
import { hasRole, type AppUser, type Role } from "./roles";

/**
 * How the owner manages who may sign in (Settings → Users). Only owners may call these, and the
 * functions check that themselves from `actor` (the caller's allow-list access for this request),
 * so a Server Action or route handler that forgets its own guard still cannot let a manager in.
 *
 * Rules:
 * - An invite only ever adds a **manager**. Inviting an email already on the list changes nothing
 *   (so an owner can never be demoted from here).
 * - Only managers can be removed. The owner cannot remove themselves, the `OWNER_EMAIL` owner, or
 *   any other owner.
 * - A removed manager is refused on their very next request (the proxy re-checks the allow-list;
 *   see docs/adr/0002).
 */

/** Sends someone a sign-in link (a magic link). Never throws on delivery failure; returns it. */
export type SignInLinkSender = (email: string) => Promise<SignInLinkResult>;
export type SignInLinkResult = { ok: true } | { ok: false; message: string };

export interface ManageAccessContext {
  sql: Sql;
  /** Who is asking, as decided by the allow-list for this request (`getAccess()`). */
  actor: Access;
}

export type InviteResult =
  | { status: "invited"; email: string; emailSent: true }
  | { status: "invited"; email: string; emailSent: false; emailError: string }
  | { status: "already-listed"; email: string; role: Role }
  | { status: "invalid-email"; email: string }
  | { status: "forbidden" };

export type RemoveResult =
  | { status: "removed"; email: string }
  | { status: "not-listed"; email: string }
  | { status: "protected"; email: string; reason: "yourself" | "configured-owner" | "owner" }
  | { status: "forbidden" };

/**
 * Puts `rawEmail` on the allow-list as a manager and emails them a sign-in link so they know they
 * have been invited. If the email cannot be sent the invite still stands (they can sign in from
 * the login page); the result says so.
 */
export async function inviteManager(
  { sql, actor, sendSignInLink }: ManageAccessContext & { sendSignInLink: SignInLinkSender },
  rawEmail: unknown,
): Promise<InviteResult> {
  const owner = ownerActor(actor);
  if (!owner) return { status: "forbidden" };

  const email = typeof rawEmail === "string" ? normaliseEmail(rawEmail) : "";
  if (!isValidEmail(email)) return { status: "invalid-email", email };

  const [added] = await sql<{ email: string }[]>`
    insert into app_users (email, role, invited_by)
    values (${email}, 'manager', ${normaliseEmail(owner.email)})
    on conflict (email) do nothing
    returning email
  `;
  if (!added) {
    const [existing] = await sql<{ role: Role }[]>`select role from app_users where email = ${email}`;
    // Removed between the insert and this read: report it as listed anyway; the owner can retry.
    return { status: "already-listed", email, role: existing?.role ?? "manager" };
  }

  let sent: SignInLinkResult;
  try {
    sent = await sendSignInLink(email);
  } catch (error) {
    sent = { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  return sent.ok
    ? { status: "invited", email, emailSent: true }
    : { status: "invited", email, emailSent: false, emailError: sent.message };
}

/** Takes a manager off the allow-list. Owners (including the caller) are never removed. */
export async function removeManager(
  { sql, actor, ownerEmail }: ManageAccessContext & { ownerEmail: string | null | undefined },
  rawEmail: unknown,
): Promise<RemoveResult> {
  const owner = ownerActor(actor);
  if (!owner) return { status: "forbidden" };

  const email = typeof rawEmail === "string" ? normaliseEmail(rawEmail) : "";
  if (email === normaliseEmail(owner.email)) return { status: "protected", email, reason: "yourself" };
  if (ownerEmail && email === normaliseEmail(ownerEmail)) {
    return { status: "protected", email, reason: "configured-owner" };
  }

  // The role condition is what actually keeps owners safe, even if the checks above miss a case.
  const removed = await sql`delete from app_users where email = ${email} and role = 'manager'`;
  if (removed.count > 0) return { status: "removed", email };

  const [existing] = await sql<{ role: Role }[]>`select role from app_users where email = ${email}`;
  return existing ? { status: "protected", email, reason: "owner" } : { status: "not-listed", email };
}

function ownerActor(actor: Access): AppUser | null {
  return actor.status === "allowed" && hasRole(actor.user, "owner") ? actor.user : null;
}
