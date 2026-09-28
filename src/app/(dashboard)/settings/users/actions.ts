"use server";

import { revalidatePath } from "next/cache";

import { signInLinkSenderForInvites } from "@/auth/magic-link";
import { inviteManager, removeManager, type InviteResult, type RemoveResult } from "@/auth/managers";
import { requireRole } from "@/auth/session";
import { getDb } from "@/db/client";

export type InviteState = { status: "idle" } | InviteResult;
export type RemoveState = { status: "idle" } | RemoveResult;

const USERS_PATH = "/settings/users";

/**
 * Owner only. `requireRole` refuses anyone else (these actions are reachable by a direct POST, not
 * just from the page), and `inviteManager` / `removeManager` check the caller's role again.
 */
export async function inviteManagerAction(_previous: InviteState, formData: FormData): Promise<InviteState> {
  const owner = await requireRole("owner");
  const result = await inviteManager(
    { sql: getDb(), actor: { status: "allowed", user: owner }, sendSignInLink: await signInLinkSenderForInvites() },
    formData.get("email"),
  );
  if (result.status === "invited") {
    if (!result.emailSent) console.error(`Invite saved, but the sign-in email failed: ${result.emailError}`);
    revalidatePath(USERS_PATH);
  }
  return result;
}

export async function removeManagerAction(_previous: RemoveState, formData: FormData): Promise<RemoveState> {
  const owner = await requireRole("owner");
  const result = await removeManager(
    { sql: getDb(), actor: { status: "allowed", user: owner }, ownerEmail: process.env.OWNER_EMAIL },
    formData.get("email"),
  );
  if (result.status === "removed") revalidatePath(USERS_PATH);
  return result;
}
