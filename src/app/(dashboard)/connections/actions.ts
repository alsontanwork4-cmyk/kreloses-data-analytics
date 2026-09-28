"use server";

import { revalidatePath } from "next/cache";

import { requireRole } from "@/auth/session";
import { connectionsContext } from "@/connections/context";
import {
  deleteConnection,
  saveConnection,
  testConnection,
  type ConnectionField,
  type ConnectionStatus,
} from "@/connections/service";
import { getDb } from "@/db/client";

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
      connection.status === "ok"
        ? `Saved “${connection.label}”. The login works and can see ${branches} ${branches === 1 ? "branch" : "branches"}.`
        : `Saved “${connection.label}”, but the login test failed: ${connection.lastError ?? "unknown error"}`,
  };
}

export async function retestConnectionAction(formData: FormData): Promise<void> {
  await requireRole("owner");
  await testConnection(connectionsContext(), String(formData.get("id") ?? ""));
  revalidatePath(PATH);
}

export async function deleteConnectionAction(formData: FormData): Promise<void> {
  await requireRole("owner");
  await deleteConnection(getDb(), String(formData.get("id") ?? ""));
  revalidatePath(PATH);
}
