import { AuthFailed, isKrelosesError } from "@/kreloses";

import { CredentialsKeyError, DecryptionError } from "./encryption";

/** Why a connection's last login test failed (stored in `connections.last_error_code`). */
export type ConnectionErrorCode =
  | "bad_credentials"
  | "unexpected_step"
  | "session_expired"
  | "layout_changed"
  | "rate_limited"
  | "unreachable"
  | "key_problem"
  | "internal";

/**
 * Turns a failed login test into the message shown to the owner on the Connections page: what
 * went wrong in plain words, and what to do. Wrong password, an extra login step (such as a
 * one-time code) and "Kreloses unreachable" are deliberately distinct.
 */
export function describeTestFailure(error: unknown): { code: ConnectionErrorCode; message: string } {
  if (error instanceof AuthFailed) {
    switch (error.reason) {
      case "bad_credentials":
        return {
          code: "bad_credentials",
          message: `Kreloses rejected this email or password.${error.detail ? ` Kreloses said: “${error.detail}”` : ""} Check them and save again.`,
        };
      case "session_expired":
        return {
          code: "session_expired",
          message: "Kreloses ended the session straight after logging in. Use “Test again”; if it keeps happening, the app needs an update.",
        };
      case "unexpected_step":
        return { code: "unexpected_step", message: unexpectedStepMessage(error) };
    }
  }
  if (isKrelosesError(error)) {
    switch (error.code) {
      case "layout_changed":
        return {
          code: "layout_changed",
          message: `Kreloses answered in a way the app does not recognise, so its pages may have changed (${error.message}). The app needs an update before it can use this login.`,
        };
      case "rate_limited":
        return {
          code: "rate_limited",
          message: "Kreloses is limiting requests right now. Wait a few minutes, then use “Test again”.",
        };
      case "transient":
        return {
          code: "unreachable",
          message: `Couldn't reach Kreloses (${error.message}). Check the internet connection or try again in a few minutes.`,
        };
    }
  }
  if (error instanceof CredentialsKeyError || error instanceof DecryptionError) {
    return { code: "key_problem", message: error.message };
  }
  return {
    code: "internal",
    message: "Something went wrong while testing this login. Try again; if it keeps failing, check the server logs.",
  };
}

function unexpectedStepMessage(error: AuthFailed): string {
  switch (error.step) {
    case "one_time_code":
      return "Kreloses asked for a one-time code (two-step verification) after the password, which the app cannot enter. Turn off two-step verification for this Kreloses login, or use a login without it.";
    case "returned_to_login":
      return `Kreloses accepted the password but then sent the app back to its login page, so the session did not work. ${error.detail ?? ""}`.trim();
    default:
      return `Kreloses showed an unexpected page after the password, so the app could not finish logging in.${error.detail ? ` (${error.detail})` : ""}`;
  }
}
