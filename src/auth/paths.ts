/** Route constants shared by the proxy, the auth helpers and the login page. Pure; safe anywhere. */

export const LOGIN_PATH = "/login";
export const HOME_PATH = "/overview";
export const FORBIDDEN_PATH = "/forbidden";

/**
 * Paths reachable without an allow-listed session. Each entry also covers its sub-paths.
 * Anything added here MUST authenticate on its own (e.g. a future `/api/mcp` bearer token or
 * `/api/cron` secret) — the proxy will not check it.
 */
export const PUBLIC_PATHS: readonly string[] = ["/login", "/auth"];

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

/** A same-origin path to return to after sign-in, or null if `value` is not one. */
export function safeNextPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return null;
  if (value.includes("\\") || isPublicPath(value.split("?")[0]!)) return null;
  return value;
}

export function loginPath(params: { next?: string; error?: LoginError } = {}): string {
  const search = new URLSearchParams();
  if (params.error) search.set("error", params.error);
  const next = safeNextPath(params.next);
  if (next && next !== HOME_PATH) search.set("next", next);
  const query = search.toString();
  return query ? `${LOGIN_PATH}?${query}` : LOGIN_PATH;
}
