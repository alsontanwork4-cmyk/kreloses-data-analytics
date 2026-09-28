"use server";

import { revalidatePath } from "next/cache";

import { requireRole } from "@/auth/session";
import { getDb } from "@/db/client";
import { remapAlias, setStaffKind, type StaffChange } from "@/staff/store";

export type StaffChangeState = { status: "idle" } | { status: "saved" | "error"; message: string };

/**
 * Settings → Doctors actions. Owner only: `requireRole` refuses anyone else (Server Actions are
 * reachable by a direct POST, not only through the page). A change takes effect in every figure
 * at once (names and kinds are resolved when figures are computed), so the whole dashboard is
 * revalidated; nothing is re-synced.
 */
export async function remapAliasAction(_previous: StaffChangeState, formData: FormData): Promise<StaffChangeState> {
  await requireRole("owner");
  const result = await remapAlias(getDb(), String(formData.get("aliasId") ?? ""), String(formData.get("staffId") ?? ""));
  return done(result, "Saved: lines with this name are now credited to the staff member you chose.");
}

export async function setStaffKindAction(_previous: StaffChangeState, formData: FormData): Promise<StaffChangeState> {
  await requireRole("owner");
  const result = await setStaffKind(getDb(), String(formData.get("staffId") ?? ""), formData.get("kind"));
  return done(result, "Saved: the doctor ranking and the staff groups use this kind now.");
}

function done(result: StaffChange, message: string): StaffChangeState {
  if (result.status === "saved") {
    revalidatePath("/", "layout");
    return { status: "saved", message };
  }
  return {
    status: "error",
    message: result.status === "not_found" ? "That name or staff member no longer exists. Reload the page." : "Choose a staff member or kind from the list.",
  };
}
