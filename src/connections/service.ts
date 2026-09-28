import { normaliseEmail } from "@/auth/allow-list";
import type { Sql } from "@/db/sql";
import { listLocations, login, type KrelosesSession, type ReaderOptions } from "@/kreloses";

import { CredentialsKeyError, decryptSecret, encryptSecret, type Keyring } from "./encryption";
import { describeTestFailure } from "./messages";
import {
  deleteConnectionRow,
  insertConnection,
  isConnectionId,
  readCredentials,
  recordTestOutcome,
  updateConnectionDetails,
  type ConnectionSummary,
  type TestOutcome,
} from "./store";

export { listConnections, type ConnectionSummary, type ConnectionStatus, type VisibleLocation } from "./store";

/**
 * Kreloses connections: one Kreloses login per branch login, stored with an encrypted password
 * and tested by logging in for real (through the Kreloses Reader) whenever it is saved.
 *
 * The plaintext password exists only inside `saveConnection` (to encrypt it) and `testConnection`
 * (decrypted just for the Reader call). Nothing here returns or logs it.
 */
export interface ConnectionsContext {
  sql: Sql;
  /** The encryption keyring; throws `CredentialsKeyError` when the key is missing (fail closed). */
  keyring: () => Keyring;
  reader: ReaderOptions;
}

export interface ConnectionInput {
  /** Present when editing. */
  id?: string;
  label: string;
  email: string;
  /** Required for a new connection; blank on edit keeps the stored password. */
  password: string;
}

export type ConnectionField = "label" | "email" | "password";

export type SaveResult =
  | { ok: true; connection: ConnectionSummary }
  | { ok: false; fieldErrors: Partial<Record<ConnectionField, string>> }
  | { ok: false; formError: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_LABEL = 80;
const MAX_EMAIL = 254;
const MAX_PASSWORD = 256;

/** Validates, encrypts and stores a connection, then runs its live login test. */
export async function saveConnection(context: ConnectionsContext, input: ConnectionInput): Promise<SaveResult> {
  const editing = input.id !== undefined;
  if (editing && !isConnectionId(input.id)) return { ok: false, formError: "That connection no longer exists. Reload the page." };

  const label = input.label.trim();
  const email = normaliseEmail(input.email);
  const fieldErrors: Partial<Record<ConnectionField, string>> = {};
  if (!label) fieldErrors.label = "Enter a name for this connection.";
  else if (label.length > MAX_LABEL) fieldErrors.label = `Keep the name to ${MAX_LABEL} characters or fewer.`;
  if (!EMAIL.test(email) || email.length > MAX_EMAIL) fieldErrors.email = "Enter the email address you sign in to Kreloses with.";
  if (!editing && input.password.length === 0) fieldErrors.password = "Enter the Kreloses password.";
  else if (input.password.length > MAX_PASSWORD) fieldErrors.password = "That password is too long.";
  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };

  let keyring: Keyring;
  try {
    keyring = context.keyring();
  } catch (error) {
    if (error instanceof CredentialsKeyError) return { ok: false, formError: error.message };
    throw error;
  }
  const passwordCiphertext = input.password.length > 0 ? encryptSecret(input.password, keyring) : null;

  let id: string;
  try {
    if (editing) {
      id = input.id!;
      const updated = await updateConnectionDetails(context.sql, id, { label, email, passwordCiphertext });
      if (!updated) return { ok: false, formError: "That connection no longer exists. Reload the page." };
    } else {
      id = await insertConnection(context.sql, { label, email, passwordCiphertext: passwordCiphertext! });
    }
  } catch (error) {
    const duplicate = duplicateField(error);
    if (duplicate === "email") {
      return { ok: false, fieldErrors: { email: "There is already a connection for this Kreloses login." } };
    }
    if (duplicate === "label") return { ok: false, fieldErrors: { label: "There is already a connection with this name." } };
    throw error;
  }

  const tested = await runLoginTest(context, id);
  if (!tested) return { ok: false, formError: "That connection no longer exists. Reload the page." };
  return { ok: true, connection: tested };
}

/** Logs in with a saved connection again and stores the result. Null if it no longer exists. */
export async function testConnection(context: ConnectionsContext, id: string): Promise<ConnectionSummary | null> {
  return runLoginTest(context, id);
}

export async function deleteConnection(sql: Sql, id: string): Promise<boolean> {
  return deleteConnectionRow(sql, id);
}

/** A saved connection that does not exist (deleted meanwhile, or a bad id). */
export class ConnectionNotFound extends Error {
  constructor(id: string) {
    super(`Kreloses connection ${id} does not exist`);
    this.name = "ConnectionNotFound";
  }
}

/**
 * Logs in to Kreloses as a saved connection: decrypts its password (server only, never logged or
 * returned) and hands it to the Reader. Used by the login test here, and meant for the Sync
 * Engine. Throws `ConnectionNotFound`, `CredentialsKeyError` / `DecryptionError` (key missing or
 * changed), or one of the Reader's typed errors.
 */
export async function loginAsConnection(context: ConnectionsContext, id: string): Promise<KrelosesSession> {
  const stored = await readCredentials(context.sql, id);
  if (!stored) throw new ConnectionNotFound(id);
  const password = decryptSecret(stored.passwordCiphertext, context.keyring());
  return login({ email: stored.email, password }, context.reader);
}

async function runLoginTest(context: ConnectionsContext, id: string): Promise<ConnectionSummary | null> {
  let outcome: TestOutcome;
  try {
    const session = await loginAsConnection(context, id);
    outcome = { status: "ok", visibleLocations: await listLocations(session) };
  } catch (error) {
    if (error instanceof ConnectionNotFound) return null;
    const failure = failed(error);
    outcome = failure;
    if (failure.code === "internal") {
      // Not a Kreloses answer: a bug or misconfiguration. Log the error type and message only.
      console.error(`[connections] login test for connection ${id} failed unexpectedly: ${errorSummary(error)}`);
    }
  }
  return recordTestOutcome(context.sql, id, outcome);
}

function failed(error: unknown): TestOutcome & { status: "failed" } {
  return { status: "failed", ...describeTestFailure(error) };
}

function duplicateField(error: unknown): "email" | "label" | null {
  const { code, constraint_name: constraint } = (error ?? {}) as { code?: string; constraint_name?: string };
  if (code !== "23505") return null;
  if (constraint === "connections_kreloses_email_unique") return "email";
  if (constraint === "connections_label_unique") return "label";
  return null;
}

function errorSummary(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : typeof error;
}
