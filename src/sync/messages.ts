import { CredentialsKeyError, DecryptionError } from "@/connections/encryption";
import { describeTestFailure } from "@/connections/messages";
import { AuthFailed, LayoutChanged, RateLimited, Transient } from "@/kreloses";

import type { SyncErrorCode } from "./runs";

export interface SyncFailure {
  code: SyncErrorCode;
  /** Shown on the Sync status page (to the owner and managers): what happened and what happens next. */
  message: string;
}

/**
 * Why a sync run failed, in plain words, from the error that stopped it. Kreloses errors never
 * carry passwords, cookies, tokens or query strings, so their messages are safe to store and show.
 */
export function describeSyncFailure(error: unknown): SyncFailure {
  if (error instanceof AuthFailed) {
    return { code: "auth_failed", message: `The Kreloses login failed. ${describeTestFailure(error).message}` };
  }
  if (error instanceof LayoutChanged) {
    return {
      code: "layout_changed",
      message: `Kreloses answered in a way the app does not recognise (${error.message}). Its pages may have changed: the app needs an update before this sync can work, so no numbers were guessed.`,
    };
  }
  if (error instanceof RateLimited) {
    return {
      code: "rate_limited",
      message: `Kreloses asked the app to slow down (${error.message}). The next sync will try again.`,
    };
  }
  if (error instanceof Transient) {
    return {
      code: "transient",
      message: `Kreloses could not be reached or had a problem (${error.message}). The next sync will try again.`,
    };
  }
  if (error instanceof CredentialsKeyError || error instanceof DecryptionError) {
    return { code: "key_problem", message: describeTestFailure(error).message };
  }
  return {
    code: "internal",
    message: `Something went wrong in the app during the sync (${error instanceof Error ? error.name : "unknown error"}). Try again; if it keeps failing, check the server logs.`,
  };
}

/** Errors that say the connection's login no longer works (shown on the Connections page too). */
export function isLoginFailure(error: unknown): boolean {
  return error instanceof AuthFailed || error instanceof CredentialsKeyError || error instanceof DecryptionError;
}
