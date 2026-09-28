"use server";

import { revalidatePath } from "next/cache";

import { requireRole } from "@/auth/session";
import { connectionsContext } from "@/connections/context";
import { ConnectionBusy } from "@/connections/lock";
import {
  deleteConnection,
  saveConnection,
  testConnection,
  type ConnectionField,
  type ConnectionStatus,
} from "@/connections/service";
import { getDb } from "@/db/client";
import { runSync } from "@/sync";
import { syncDeps, syncTimeBudgetMs } from "@/sync/context";
import { describeSyncResult, monthLabel, monthRange } from "@/sync/months";

/**
 * Connections page actions. Each one re-checks that the caller is the owner (Server Actions are
 * reachable by direct POST, not only through the page). Return values carry only what the page
 * shows — never the password, which is not even echoed back on a validation error.
 */

export type SaveConnectionState =
  | { status: "idle" }
  | {
      status: "invalid";
      fieldErrors: Partial<Record<ConnectionField, string>>;
      formError?: string;
      values: { label: string; email: string };
    }
  | { status: "saved"; id: string; label: string; testStatus: ConnectionStatus; message: string };

const PATH = "/connections";

export async function saveConnectionAction(
  _previous: SaveConnectionState,
  formData: FormData,
): Promise<SaveConnectionState> {
  await requireRole("owner");
  const id = formData.get("id");
  const input = {
    id: typeof id === "string" && id !== "" ? id : undefined,
    label: String(formData.get("label") ?? ""),
    email: String(formData.get("email") ?? ""),
    password: String(formData.get("password") ?? ""),
  };

  const result = await saveConnection(connectionsContext(), input);
  if (!result.ok) {
    return {
      status: "invalid",
      fieldErrors: "fieldErrors" in result ? result.fieldErrors : {},
      ...("formError" in result ? { formError: result.formError } : {}),
      values: { label: input.label, email: input.email },
    };
  }
  revalidatePath(PATH);
  const { connection } = result;
  const branches = connection.visibleLocations.length;
  return {
    status: "saved",
    id: connection.id,
    label: connection.label,
    testStatus: connection.status,
    message:
      result.loginTestSkipped === "busy"
        ? `Saved “${connection.label}”. A sync is using this login right now, so it was not tested; use “Test again” when the sync has finished.`
        : connection.status === "ok"
          ? `Saved “${connection.label}”. The login works and can see ${branches} ${branches === 1 ? "branch" : "branches"}.`
          : `Saved “${connection.label}”, but the login test failed: ${connection.lastError ?? "unknown error"}`,
  };
}

/** "Test again". `busy` when a sync is using the login (the app never runs two Kreloses sessions for one login). */
export type RetestState = { status: "idle" } | { status: "busy"; message: string };

export async function retestConnectionAction(_previous: RetestState, formData: FormData): Promise<RetestState> {
  await requireRole("owner");
  try {
    await testConnection(connectionsContext(), String(formData.get("id") ?? ""));
  } catch (error) {
    if (error instanceof ConnectionBusy) return { status: "busy", message: `${error.message} Try again when it has finished.` };
    throw error;
  }
  revalidatePath(PATH);
  return { status: "idle" };
}

export type SyncNowState = { status: "idle" } | { status: "done"; tone: "ok" | "warning" | "error"; message: string };

/**
 * "Sync now": reads one month of this connection's Kreloses sales (the Sync Engine's manual mode).
 * Takes a few seconds per 500 invoices; the page's `maxDuration` allows for the time budget.
 */
export async function syncNowAction(_previous: SyncNowState, formData: FormData): Promise<SyncNowState> {
  await requireRole("owner");
  const month = String(formData.get("month") ?? "");
  const range = monthRange(month);
  if (!range) return { status: "done", tone: "error", message: "Choose a month to sync." };
  const result = await runSync(syncDeps(), String(formData.get("id") ?? ""), "manual", {
    dateRange: range,
    timeBudgetMs: syncTimeBudgetMs(),
  });
  revalidatePath(PATH);
  return { status: "done", ...describeSyncResult(result, monthLabel(month)) };
}

export async function deleteConnectionAction(formData: FormData): Promise<void> {
  await requireRole("owner");
  await deleteConnection(getDb(), String(formData.get("id") ?? ""));
  revalidatePath(PATH);
}
