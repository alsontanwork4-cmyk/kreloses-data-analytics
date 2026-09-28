/**
 * A small RFC 6265 cookie jar for the Reader's HTTP session. It exists because the Kreloses login
 * happens on www.kreloses.com while the app lives on sea.kreloses.com: whether the session cookie
 * reaches sea depends on its Domain attribute, so the jar must honour Domain, host-only cookies,
 * Path, Secure and expiry exactly like a browser does.
 *
 * Cookie values never leave this module except in the `Cookie` request header: `describe()` and
 * the change summaries returned by `store()` carry names and attributes only.
 */

export interface CookieSummary {
  name: string;
  /** Lower-case, no leading dot. For a host-only cookie this is the host that set it. */
  domain: string;
  /** True when the cookie had no Domain attribute: sent back to exactly that host only. */
  hostOnly: boolean;
  path: string;
  /** ISO timestamp, or null for a session cookie (lives until the jar is discarded). */
  expiresAt: string | null;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "strict" | "lax" | "none" | null;
}

export interface CookieChange extends Omit<CookieSummary, "domain" | "hostOnly"> {
  /** `set` (stored or replaced), `deleted` (expired on arrival), `rejected` (Domain not ours). */
  action: "set" | "deleted" | "rejected";
  domain: string | null;
  hostOnly: boolean;
}

interface StoredCookie extends Omit<CookieSummary, "expiresAt"> {
  value: string;
  expiresAtMs: number | null;
}

export class CookieJar {
  readonly #cookies: StoredCookie[] = [];
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Applies a response's `Set-Cookie` headers. Returns what happened to each, without values. */
  store(responseUrl: URL, setCookieHeaders: readonly string[]): CookieChange[] {
    const changes: CookieChange[] = [];
    for (const header of setCookieHeaders) {
      const parsed = parseSetCookie(header, responseUrl, this.#now());
      if (!parsed) continue;
      const { cookie, domainAllowed } = parsed;
      const summary = summarise(cookie);
      if (!domainAllowed) {
        changes.push({ ...summary, action: "rejected" });
        continue;
      }
      const index = this.#cookies.findIndex(
        (existing) =>
          existing.name === cookie.name && existing.domain === cookie.domain && existing.path === cookie.path,
      );
      const expired = cookie.expiresAtMs !== null && cookie.expiresAtMs <= this.#now();
      if (expired) {
        if (index >= 0) this.#cookies.splice(index, 1);
        changes.push({ ...summary, action: "deleted" });
        continue;
      }
      if (index >= 0) this.#cookies[index] = cookie;
      else this.#cookies.push(cookie);
      changes.push({ ...summary, action: "set" });
    }
    return changes;
  }

  /** The `Cookie` header value to send to `url`, or null when no cookie applies. */
  header(url: URL): string | null {
    const host = url.hostname.toLowerCase();
    const path = url.pathname || "/";
    const secureChannel = url.protocol === "https:" || isLoopback(host);
    const now = this.#now();
    const matching = this.#cookies
      .filter((cookie) => cookie.expiresAtMs === null || cookie.expiresAtMs > now)
      .filter((cookie) => (cookie.hostOnly ? host === cookie.domain : domainMatches(host, cookie.domain)))
      .filter((cookie) => pathMatches(path, cookie.path))
      .filter((cookie) => !cookie.secure || secureChannel)
      // Longer paths first (RFC 6265 5.4); the sort is stable, so ties keep creation order.
      .sort((a, b) => b.path.length - a.path.length);
    if (matching.length === 0) return null;
    return matching.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  }

  /** Every live cookie, without values. */
  describe(): CookieSummary[] {
    const now = this.#now();
    return this.#cookies
      .filter((cookie) => cookie.expiresAtMs === null || cookie.expiresAtMs > now)
      .map(summarise);
  }
}

function summarise(cookie: StoredCookie): CookieSummary {
  return {
    name: cookie.name,
    domain: cookie.domain,
    hostOnly: cookie.hostOnly,
    path: cookie.path,
    expiresAt: cookie.expiresAtMs === null ? null : new Date(cookie.expiresAtMs).toISOString(),
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
  };
}

function parseSetCookie(
  header: string,
  responseUrl: URL,
  now: number,
): { cookie: StoredCookie; domainAllowed: boolean } | null {
  const [pair = "", ...attributes] = header.split(";");
  const equals = pair.indexOf("=");
  if (equals <= 0) return null;
  const name = pair.slice(0, equals).trim();
  const value = pair.slice(equals + 1).trim();
  if (!name) return null;

  const host = responseUrl.hostname.toLowerCase();
  let domainAttribute: string | null = null;
  let path: string | null = null;
  let maxAgeMs: number | null = null;
  let expiresMs: number | null = null;
  let secure = false;
  let httpOnly = false;
  let sameSite: CookieSummary["sameSite"] = null;

  for (const attribute of attributes) {
    const eq = attribute.indexOf("=");
    const key = (eq >= 0 ? attribute.slice(0, eq) : attribute).trim().toLowerCase();
    const attrValue = eq >= 0 ? attribute.slice(eq + 1).trim() : "";
    switch (key) {
      case "domain":
        if (attrValue) domainAttribute = attrValue.replace(/^\./, "").toLowerCase();
        break;
      case "path":
        path = attrValue.startsWith("/") ? attrValue : null;
        break;
      case "max-age": {
        if (/^-?\d+$/.test(attrValue)) maxAgeMs = Number(attrValue) * 1000;
        break;
      }
      case "expires": {
        const parsed = Date.parse(attrValue);
        if (!Number.isNaN(parsed)) expiresMs = parsed;
        break;
      }
      case "secure":
        secure = true;
        break;
      case "httponly":
        httpOnly = true;
        break;
      case "samesite": {
        const lowered = attrValue.toLowerCase();
        if (lowered === "strict" || lowered === "lax" || lowered === "none") sameSite = lowered;
        break;
      }
    }
  }

  // A Domain must cover the responding host, and must not be a bare top-level label or an IP.
  const domainAllowed =
    domainAttribute === null ||
    (domainAttribute.includes(".") && !isIpAddress(host) && domainMatches(host, domainAttribute));

  const expiresAtMs = maxAgeMs !== null ? now + maxAgeMs : expiresMs;
  const cookie: StoredCookie = {
    name,
    value,
    domain: domainAttribute ?? host,
    hostOnly: domainAttribute === null,
    path: path ?? defaultPath(responseUrl.pathname),
    expiresAtMs,
    secure,
    httpOnly,
    sameSite,
  };
  return { cookie, domainAllowed };
}

/** RFC 6265 5.1.3: the host is the domain, or a subdomain of it. */
function domainMatches(host: string, domain: string): boolean {
  return host === domain || (host.endsWith(`.${domain}`) && !isIpAddress(host));
}

/** RFC 6265 5.1.4. */
function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath.charAt(cookiePath.length) === "/";
}

/** RFC 6265 5.1.4 default-path: the request path up to (not including) its last slash. */
function defaultPath(requestPath: string): string {
  if (!requestPath.startsWith("/")) return "/";
  const lastSlash = requestPath.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : requestPath.slice(0, lastSlash);
}

function isIpAddress(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || host.startsWith("[");
}

/** Browsers treat loopback as a secure context, so Secure cookies flow to a local test server. */
export function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}
