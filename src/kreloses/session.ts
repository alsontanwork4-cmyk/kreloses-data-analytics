import type { ResolvedReaderOptions } from "./config";
import { CookieJar, type CookieChange, type CookieSummary } from "./cookie-jar";
import { AuthFailed, LayoutChanged, PageMissing, RateLimited, Transient } from "./errors";
import { findLoginForm } from "./html";

/**
 * A logged-in (or logging-in) Kreloses browser session: a cookie jar plus the transport, with
 * every request run one at a time and at least `requestDelayMs` after the previous one finished.
 * Redirects are followed by hand so cookies are applied per hop, and only between the two
 * Kreloses hosts: a redirect anywhere else is returned unfollowed, so cookies and the password
 * never leave Kreloses.
 *
 * Callers outside `src/kreloses/` treat a session as opaque: get one from `login()` and pass it
 * to the Reader's functions (`listLocations`, and later `listInvoices` / `getInvoice`).
 */

/** Redacted record of one HTTP exchange, for diagnostics. Never contains values or query strings. */
export interface HopEvent {
  /** 1, 2, 3… within the session. */
  seq: number;
  method: "GET" | "POST";
  /** `host/path`, without the query string. */
  url: string;
  /** Null when the request failed before a response arrived. */
  status: number | null;
  /** Redirect target as `host/path`, when the response was a redirect. */
  location?: string;
  contentType?: string;
  setCookies: CookieChange[];
  /**
   * The `status` inside an `X-Responded-JSON` header, when present: ASP.NET Identity's way of
   * saying 401 ("sign in again") to an AJAX request while answering HTTP 200 with an empty body.
   */
  respondedJsonStatus?: number;
  /** `timeout` or `network`, when there was no response. */
  failure?: "timeout" | "network";
  durationMs: number;
}

export interface SessionRequest {
  method: "GET" | "POST";
  url: URL;
  headers?: Record<string, string>;
  body?: string;
  /** Follow redirects between the Kreloses hosts. API calls pass false to see a login redirect. */
  followRedirects: boolean;
}

export interface SessionResponse {
  status: number;
  /** The URL that produced this response (after any followed redirects). */
  url: URL;
  headers: Headers;
  body: string;
  /** How many redirects were followed to get here. */
  redirects: number;
  /** Every URL requested for this request, in order (the first, then each followed redirect). */
  chain: URL[];
  /** For a 3xx that was not followed: where it pointed (null if nowhere valid). */
  location?: URL | null;
  /** For a 3xx that was not followed: why. */
  unfollowed?: "not_following" | "off_kreloses" | "invalid_location" | "too_many_redirects";
}

/** Redirects followed per request before giving up (a loop, most likely). */
export const MAX_REDIRECTS = 10;

const HTML_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const JSON_ACCEPT = "application/json, text/javascript, */*; q=0.01";

export class KrelosesSession {
  readonly #options: ResolvedReaderOptions;
  readonly #jar: CookieJar;
  #queue: Promise<unknown> = Promise.resolve();
  #lastFinishedAt: number | null = null;
  #seq = 0;

  constructor(options: ResolvedReaderOptions) {
    this.#options = options;
    this.#jar = new CookieJar(options.now);
  }

  /**
   * HTTP requests this session has sent so far (every hop: its login's, redirects followed, and
   * failed attempts included). The Sync Engine counts them against the backfill's request budget.
   */
  get requestCount(): number {
    return this.#seq;
  }

  /** The Kreloses app host this session is for (e.g. `sea.kreloses.com`). */
  get appHost(): string {
    return this.#options.sea.host;
  }

  /** URL on the login host (`www`) or the app host (`sea`). */
  url(host: "www" | "sea", path: string): URL {
    return new URL(path, host === "www" ? this.#options.www : this.#options.sea);
  }

  /** The session's cookies, names and attributes only. */
  describeCookies(): CookieSummary[] {
    return this.#jar.describe();
  }

  /** A top-level page load, as a browser would do it. */
  navigate(request: Omit<SessionRequest, "headers"> & { headers?: Record<string, string> }): Promise<SessionResponse> {
    return this.request({ ...request, headers: { Accept: HTML_ACCEPT, ...request.headers } });
  }

  /**
   * POSTs JSON to an app endpoint (e.g. `/Report/GetFilter`, `/Sale/Get`) the way the Kreloses web
   * UI does (an AJAX call), and returns the parsed JSON. An expired session raises
   * `AuthFailed("session_expired")` (see `#expectAppResponse`); a body that is not JSON raises
   * `LayoutChanged`.
   */
  async postJson(path: string, payload: unknown): Promise<unknown> {
    const url = this.url("sea", path);
    const response = await this.request({
      method: "POST",
      url,
      followRedirects: false,
      body: JSON.stringify(payload),
      headers: {
        Accept: JSON_ACCEPT,
        "Content-Type": "application/json; charset=utf-8",
        "X-Requested-With": "XMLHttpRequest",
        Origin: this.#options.sea.origin,
        Referer: `${this.#options.sea.origin}/`,
      },
    });
    this.#expectAppResponse(response, "POST");
    const contentType = response.headers.get("content-type") ?? "";
    try {
      return JSON.parse(response.body) as unknown;
    } catch {
      throw new LayoutChanged(`POST ${redactUrl(url)} did not return JSON (content type "${contentType || "none"}")`);
    }
  }

  /**
   * GETs an app page (e.g. `/Sale/Overview/{id}`) as a browser page load and returns its HTML. An
   * expired session raises `AuthFailed("session_expired")`; a missing page (404/410) or a redirect
   * anywhere but the login page raises `PageMissing` (a `LayoutChanged`); any other non-200 status
   * raises `LayoutChanged`.
   */
  async getHtml(path: string): Promise<string> {
    const url = this.url("sea", path);
    const response = await this.navigate({ method: "GET", url, followRedirects: false });
    this.#expectAppResponse(response, "GET");
    return response.body;
  }

  /**
   * The checks every app (sea) response goes through. The session has expired when Kreloses
   * redirects to its login page, answers 401/403, answers an AJAX call with HTTP 200 and an
   * `X-Responded-JSON` 401/403 (ASP.NET Identity's cookie middleware), or serves its login form
   * instead of the page. Any other redirect or non-200 status means the endpoint has changed.
   */
  #expectAppResponse(response: SessionResponse, method: "GET" | "POST"): void {
    const where = `${method} ${redactUrl(response.url)}`;
    if (response.status >= 300 && response.status < 400) {
      if (response.location && looksLikeLoginUrl(response.location)) throw new AuthFailed("session_expired");
      const message = `${where} redirected to ${response.location ? redactUrl(response.location) : "nowhere"} instead of answering`;
      // A page load sent elsewhere means that page is not there (e.g. an unknown sale → the list).
      if (method === "GET") throw new PageMissing(message, { reason: "redirected", status: response.status });
      throw new LayoutChanged(message);
    }
    if (response.status === 401 || response.status === 403) throw new AuthFailed("session_expired");
    const responded = respondedJsonStatus(response.headers);
    if (responded === 401 || responded === 403) throw new AuthFailed("session_expired");
    if (method === "GET" && (response.status === 404 || response.status === 410)) {
      throw new PageMissing(`${where} returned HTTP ${response.status}`, { reason: "not_found", status: response.status });
    }
    if (response.status !== 200) throw new LayoutChanged(`${where} returned HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!/json/i.test(contentType) && findLoginForm(response.body)) throw new AuthFailed("session_expired");
  }

  /**
   * Runs one logical request (plus any redirects it follows) after the previous one has finished
   * and the polite delay has passed. Rate limiting (429) raises `RateLimited`; server errors
   * (5xx), timeouts and network failures raise `Transient`. Everything else is returned for the
   * caller to interpret.
   */
  request(request: SessionRequest): Promise<SessionResponse> {
    const run = this.#queue.then(() => this.#run(request));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #run(request: SessionRequest): Promise<SessionResponse> {
    if (this.#lastFinishedAt !== null) {
      const wait = this.#lastFinishedAt + this.#options.requestDelayMs - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }
    try {
      return await this.#follow(request);
    } finally {
      this.#lastFinishedAt = Date.now();
    }
  }

  async #follow(request: SessionRequest): Promise<SessionResponse> {
    let { method, url, body } = request;
    let headers = { ...request.headers };
    const chain: URL[] = [];
    for (let redirects = 0; ; redirects += 1) {
      chain.push(url);
      const response = await this.#exchange(method, url, headers, body);
      if (isRedirect(response.status)) {
        const target = resolveLocation(response.headers.get("location"), url);
        await discardBody(response);
        const unfollowed = !request.followRedirects
          ? "not_following"
          : !target
            ? "invalid_location"
            : !this.#isKrelosesUrl(target)
              ? "off_kreloses"
              : redirects >= MAX_REDIRECTS
                ? "too_many_redirects"
                : null;
        if (unfollowed) {
          return { status: response.status, url, headers: response.headers, body: "", redirects, chain, location: target, unfollowed };
        }
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
          method = "GET";
          body = undefined;
          headers = withoutBodyHeaders(headers);
        }
        url = target!;
        continue;
      }
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        throw new Transient(`the response to ${method} ${redactUrl(url)} was cut off`, { cause: error });
      }
      return { status: response.status, url, headers: response.headers, body: text, redirects, chain };
    }
  }

  async #exchange(
    method: "GET" | "POST",
    url: URL,
    headers: Record<string, string>,
    body: string | undefined,
  ): Promise<Response> {
    const seq = (this.#seq += 1);
    const cookie = this.#jar.header(url);
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await this.#options.transport(url.toString(), {
        method,
        headers: { "User-Agent": this.#options.userAgent, ...headers, ...(cookie ? { Cookie: cookie } : {}) },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(this.#options.timeoutMs),
      });
    } catch (error) {
      const failure = isTimeout(error) ? "timeout" : "network";
      this.#options.observer?.({
        seq,
        method,
        url: redactUrl(url),
        status: null,
        setCookies: [],
        failure,
        durationMs: Date.now() - startedAt,
      });
      const timeout = this.#options.timeoutMs;
      throw new Transient(
        failure === "timeout"
          ? `no answer within ${timeout >= 1000 ? `${Math.round(timeout / 1000)}s` : `${timeout} ms`} to ${method} ${redactUrl(url)}`
          : `network error on ${method} ${redactUrl(url)}`,
        { cause: error, request: `${method} ${redactUrl(url)}` },
      );
    }

    const setCookies = this.#jar.store(url, response.headers.getSetCookie());
    const location = isRedirect(response.status) ? resolveLocation(response.headers.get("location"), url) : null;
    const responded = respondedJsonStatus(response.headers);
    this.#options.observer?.({
      seq,
      method,
      url: redactUrl(url),
      status: response.status,
      ...(location ? { location: redactUrl(location) } : {}),
      ...(response.headers.get("content-type") ? { contentType: response.headers.get("content-type")! } : {}),
      ...(responded !== null ? { respondedJsonStatus: responded } : {}),
      setCookies,
      durationMs: Date.now() - startedAt,
    });

    if (response.status === 429) {
      await discardBody(response);
      const retryAfter = Number(response.headers.get("retry-after"));
      throw new RateLimited(`Kreloses rate-limited ${method} ${redactUrl(url)} (HTTP 429)`, {
        retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      });
    }
    if (response.status >= 500) {
      await discardBody(response);
      throw new Transient(`Kreloses answered HTTP ${response.status} to ${method} ${redactUrl(url)}`, {
        status: response.status,
        request: `${method} ${redactUrl(url)}`,
      });
    }
    return response;
  }

  #isKrelosesUrl(url: URL): boolean {
    const { www, sea } = this.#options;
    return (url.host === www.host && url.protocol === www.protocol) || (url.host === sea.host && url.protocol === sea.protocol);
  }
}

/** `host/path` — never the query string, which can carry tokens or return URLs. */
export function redactUrl(url: URL): string {
  return `${url.host}${url.pathname}`;
}

export function looksLikeLoginUrl(url: URL): boolean {
  return /\/account\/log-?(in|on)\b/i.test(url.pathname);
}

/** The `status` in an `X-Responded-JSON` header (`{"status":401,"headers":{…}}`), or null. */
function respondedJsonStatus(headers: Headers): number | null {
  const header = headers.get("x-responded-json");
  if (!header) return null;
  try {
    const status = (JSON.parse(header) as { status?: unknown }).status;
    return typeof status === "number" ? status : null;
  } catch {
    return null;
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function resolveLocation(location: string | null, base: URL): URL | null {
  if (!location) return null;
  try {
    const url = new URL(location, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function withoutBodyHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!/^(content-type|content-length|origin)$/i.test(name)) result[name] = value;
  }
  return result;
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing to clean up.
  }
}

function isTimeout(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}
