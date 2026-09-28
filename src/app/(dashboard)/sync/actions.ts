"use server";

import { revalidatePath } from "next/cache";

import { requireRole } from "@/auth/session";
import { getDb } from "@/db/client";
import { pauseBackfill, startBackfill } from "@/sync/backfill-store";

/**
 * "Start backfill" / "Pause backfill" (#8), owner only: each re-checks the role (Server Actions are
 * reachable by direct POST). Starting resumes a paused backfill where it stopped (or starts one that
 * never ran); chunks run at night only, so nothing is read from Kreloses here.
 */
export async function startBackfillAction(formData: FormData): Promise<void> {
  await requireRole("owner");
  await startBackfill(getDb(), String(formData.get("id") ?? ""));
  revalidateBackfillPages();
}

export async function pauseBackfillAction(formData: FormData): Promise<void> {
  await requireRole("owner");
  await pauseBackfill(getDb(), String(formData.get("id") ?? ""));
  revalidateBackfillPages();
}

function revalidateBackfillPages() {
  revalidatePath("/sync");
  revalidatePath("/connections");
}
