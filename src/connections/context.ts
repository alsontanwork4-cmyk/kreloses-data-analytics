import "server-only";

import { getDb } from "@/db/client";
import { readerOptionsFromEnv } from "@/kreloses";

import { CredentialsKeyError, keyringFromEnv } from "./encryption";
import type { ConnectionsContext } from "./service";

/**
 * The running app's connections context: the app database, the key from
 * `CREDENTIALS_ENCRYPTION_KEY` (read when needed, so a missing key fails the save, not the page),
 * and the Reader pointed at real Kreloses (or, outside production only, at the e2e suite's fake
 * via `KRELOSES_BASE_URL_WWW` / `KRELOSES_BASE_URL_SEA`).
 */
export function connectionsContext(): ConnectionsContext {
  return {
    sql: getDb(),
    keyring: () => keyringFromEnv(process.env),
    reader: readerOptionsFromEnv(process.env),
  };
}

/** Why passwords cannot be stored right now (missing or malformed key), or null if they can. */
export function encryptionKeyProblem(): string | null {
  try {
    keyringFromEnv(process.env);
    return null;
  } catch (error) {
    if (error instanceof CredentialsKeyError) return error.message;
    throw error;
  }
}
