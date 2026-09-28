import { isLoopback } from "./cookie-jar";
import type { HopEvent } from "./session";
import { fetchTransport, type Transport } from "./transport";

/** Where Kreloses lives. The login form is on www; the app (and every data endpoint) on sea. */
export const KRELOSES_WWW_URL = "https://www.kreloses.com";
export const KRELOSES_SEA_URL = "https://sea.kreloses.com";

/** Pause between two requests of one session (spec: serial requests with a polite delay). */
export const DEFAULT_REQUEST_DELAY_MS = 1_000;
export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (compatible; KrelosesAnalytics/0.1; read-only sales sync for the clinic owner)";

export interface ReaderOptions {
  /** Defaults to the real Kreloses hosts. Tests and the e2e suite point these at a fake. */
  baseUrls?: { www: string; sea: string };
  /** Defaults to global fetch. */
  transport?: Transport;
  /** Minimum pause between two requests of the same session. Default 1s. */
  requestDelayMs?: number;
  /** Per-request timeout. Default 20s. */
  timeoutMs?: number;
  userAgent?: string;
  /** Sees a redacted record of every HTTP exchange (no values, no query strings). */
  observer?: (event: HopEvent) => void;
  /** Clock, for tests. */
  now?: () => number;
}

export interface ResolvedReaderOptions {
  www: URL;
  sea: URL;
  transport: Transport;
  requestDelayMs: number;
  timeoutMs: number;
  userAgent: string;
  observer?: (event: HopEvent) => void;
  now: () => number;
}

export function resolveReaderOptions(options: ReaderOptions = {}): ResolvedReaderOptions {
  return {
    www: new URL(options.baseUrls?.www ?? KRELOSES_WWW_URL),
    sea: new URL(options.baseUrls?.sea ?? KRELOSES_SEA_URL),
    transport: options.transport ?? fetchTransport,
    requestDelayMs: Math.max(0, options.requestDelayMs ?? DEFAULT_REQUEST_DELAY_MS),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
    observer: options.observer,
    now: options.now ?? Date.now,
  };
}

/**
 * Reader options for the running app. Real Kreloses unless BOTH `KRELOSES_BASE_URL_WWW` and
 * `KRELOSES_BASE_URL_SEA` are set, which the e2e suite does to point the app at a local fake
 * Kreloses. The override is refused (throws) when `NODE_ENV` is `production`, and must point at
 * this machine (localhost / 127.0.0.1 / [::1]), so a misconfigured deployment can never send a
 * Kreloses password anywhere else.
 */
export function readerOptionsFromEnv(env: Record<string, string | undefined>): ReaderOptions {
  const www = env.KRELOSES_BASE_URL_WWW?.trim();
  const sea = env.KRELOSES_BASE_URL_SEA?.trim();
  if (!www && !sea) return {};
  if (env.NODE_ENV === "production") {
    throw new Error(
      "KRELOSES_BASE_URL_WWW / KRELOSES_BASE_URL_SEA are for local tests only and are refused in production. Unset them.",
    );
  }
  if (!www || !sea) {
    throw new Error("Set both KRELOSES_BASE_URL_WWW and KRELOSES_BASE_URL_SEA (or neither).");
  }
  return { baseUrls: { www: loopbackOrigin(www, "KRELOSES_BASE_URL_WWW"), sea: loopbackOrigin(sea, "KRELOSES_BASE_URL_SEA") } };
}

function loopbackOrigin(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a URL.`);
  }
  if (!isLoopback(url.hostname) || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new Error(`${name} must be an http(s) URL on a loopback host (localhost, 127.0.0.1 or [::1]).`);
  }
  return url.origin;
}
