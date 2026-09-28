/** Route constants shared by the proxy, the auth helpers and the login page. Pure; safe anywhere. */

export const LOGIN_PATH = "/login";
export const HOME_PATH = "/overview";
export const FORBIDDEN_PATH = "/forbidden";

/**
 * Paths reachable without an allow-listed session. Each entry also covers its sub-paths.
 * Anything added here MUST authenticate on its own (e.g. `/api/mcp`: bearer token,
 * `src/mcp/auth.ts`; a future `/api/cron` secret) — the proxy will not check it.
 */
export const PUBLIC_PATHS: readonly string[] = ["/login", "/auth", "/api/mcp"];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

export type LoginError = "not-invited" | "access-denied" | "link-invalid";

export const LOGIN_ERROR_MESSAGES: Record<LoginError, string> = {
  "not-invited": "That email is not on the access list. Ask the clinic owner to invite you.",
  "access-denied": "That account does not have access to this app. Sign in with an invited email.",
  "link-invalid": "That sign-in link is invalid or has expired. Request a new one below.",
};

export function isLoginError(value: unknown): value is LoginError {
  return typeof value === "string" && value in LOGIN_ERROR_MESSAGES;
}

// Control characters are stripped by browsers ("/\t/evil" becomes "//evil"); backslashes are
// treated as slashes. Either can turn a path into another origin, so refuse them outright.
const UNSAFE_URL_CHARS = /[\u0000-\u001F\u007F\\]/;
const PARSE_BASE = "http://n.invalid";

/** A single leading slash (not `//`, which is protocol-relative) and no unsafe characters. */
function looksLikeLocalPath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//") && !UNSAFE_URL_CHARS.test(value);
}

/** Resolves `value` against a fixed origin; the same-origin pathname + query, or null. */
function normalisePath(value: string): string | null {
  try {
    const url = new URL(value, PARSE_BASE);
    return url.origin === PARSE_BASE ? `${url.pathname}${url.search}` : null;
  } catch {
    return null;
  }
}

/**
 * A same-origin path (pathname + query) to return to after sign-in, or null if `value` is not
 * one. Never redirect to a user-supplied path without passing it through this.
 *
 * Both the input and the normalised output are checked: dot segments normalise away, so
 * "/..//evil.example" would otherwise come out as the protocol-relative "//evil.example". The
 * output must also be stable (normalising it again changes nothing).
 */
export function safeNextPath(value: unknown): string | null {
  if (typeof value !== "string" || !looksLikeLocalPath(value)) return null;
  const out = normalisePath(value);
  if (out === null || !looksLikeLocalPath(out) || normalisePath(out) !== out) return null;
  if (isPublicPath(out.split("?")[0]!)) return null;
  return out;
}

export function loginPath(params: { next?: string; error?: LoginError } = {}): string {
  const search = new URLSearchParams();
  if (params.error) search.set("error", params.error);
  const next = safeNextPath(params.next);
  if (next && next !== HOME_PATH) search.set("next", next);
  const query = search.toString();
  return query ? `${LOGIN_PATH}?${query}` : LOGIN_PATH;
}
