/**
 * Typed errors raised by the Kreloses Reader. Every failure that reaches a caller is one of these
 * four (anything else is a bug), so the Sync Engine and the Connections page can decide what to do
 * from the type alone:
 *
 * - `AuthFailed`     — the login did not produce a usable session (`reason` says why). Retrying
 *                      without the owner changing something will not help.
 * - `LayoutChanged`  — Kreloses answered, but not in a shape the Reader understands. Needs a code fix.
 * - `RateLimited`    — Kreloses asked us to slow down (HTTP 429). Retry later.
 * - `Transient`      — network failure, timeout or a Kreloses server error. Retry later.
 *
 * Messages and details never contain passwords, cookie values, anti-forgery tokens or query
 * strings, so they are safe to log and to store.
 */

export type KrelosesErrorCode = "auth_failed" | "layout_changed" | "rate_limited" | "transient";

export abstract class KrelosesError extends Error {
  abstract readonly code: KrelosesErrorCode;
}

/**
 * - `bad_credentials`  — Kreloses re-showed its login form: wrong email or password (or a locked account).
 * - `unexpected_step`  — anything else between the login form and the app: a one-time code / 2FA page,
 *                        being sent back to the login page, a redirect off Kreloses, an unknown page.
 * - `session_expired`  — a request made with an established session was answered with the login page.
 */
export type AuthFailedReason = "bad_credentials" | "unexpected_step" | "session_expired";

/** What the unexpected step was, when `reason` is `unexpected_step`. */
export type UnexpectedLoginStep =
  | "one_time_code"
  | "returned_to_login"
  | "redirected_elsewhere"
  | "too_many_redirects"
  | "unrecognised_page";

export class AuthFailed extends KrelosesError {
  readonly code = "auth_failed" as const;
  readonly reason: AuthFailedReason;
  readonly step?: UnexpectedLoginStep;
  /** Safe, human-readable specifics (e.g. Kreloses's own validation message, or where the login ended). */
  readonly detail?: string;

  constructor(reason: AuthFailedReason, options: { step?: UnexpectedLoginStep; detail?: string } = {}) {
    super(`Kreloses login failed: ${reason}${options.step ? ` (${options.step})` : ""}${options.detail ? `: ${options.detail}` : ""}`);
    this.name = "AuthFailed";
    this.reason = reason;
    this.step = options.step;
    this.detail = options.detail;
  }
}

export class LayoutChanged extends KrelosesError {
  readonly code = "layout_changed" as const;
  /** For JSON responses: the keys and value types that were received (never the values). */
  readonly shape?: string;

  constructor(message: string, options: { shape?: string } = {}) {
    super(message);
    this.name = "LayoutChanged";
    this.shape = options.shape;
  }
}

/**
 * A page load (`session.getHtml`, e.g. one invoice's Sale Overview) found nothing there: HTTP
 * 404/410, or a redirect somewhere other than the login page. Still a `LayoutChanged` (anything
 * that treats it as one stays correct), but callers reading many pages — the Sync Engine opening
 * invoice pages — can tell one missing page (skip it, try again next time) from a page whose
 * content changed (fatal). Messages never carry a query string.
 */
export class PageMissing extends LayoutChanged {
  readonly reason: "not_found" | "redirected";
  /** The HTTP status Kreloses answered with. */
  readonly status: number;

  constructor(message: string, options: { reason: "not_found" | "redirected"; status: number }) {
    super(message);
    this.name = "PageMissing";
    this.reason = options.reason;
    this.status = options.status;
  }
}

export class RateLimited extends KrelosesError {
  readonly code = "rate_limited" as const;
  /** From Kreloses's `Retry-After` header, when it sent one. */
  readonly retryAfterSeconds?: number;

  constructor(message: string, options: { retryAfterSeconds?: number } = {}) {
    super(message);
    this.name = "RateLimited";
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export class Transient extends KrelosesError {
  readonly code = "transient" as const;
  /** The HTTP status when Kreloses answered with a server error; absent for network failures and timeouts. */
  readonly status?: number;
  /** The request that failed, as `METHOD host/path` (no query string). */
  readonly request?: string;

  constructor(message: string, options: { cause?: unknown; status?: number; request?: string } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "Transient";
    this.status = options.status;
    this.request = options.request;
  }
}

export function isKrelosesError(error: unknown): error is KrelosesError {
  return error instanceof KrelosesError;
}
