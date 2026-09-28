import { afterEach } from "vitest";

/**
 * Vitest setup file (vitest.config.mts; NOT the live config): tests must never contact the real
 * Kreloses. Any `fetch` to kreloses.com or a subdomain — e.g. from a Reader call that forgot to
 * pass the fake's `transport` — throws instead of going out, and the test that tried fails in
 * `afterEach` even if the Reader turned the error into a `Transient`.
 */
const blocked: string[] = [];
const realFetch = globalThis.fetch;

function isKrelosesHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "kreloses.com" || host.endsWith(".kreloses.com");
}

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (isKrelosesHost(url.hostname)) {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    blocked.push(`${method} ${url.origin}${url.pathname}`);
    throw new Error(`Tests must not contact the real Kreloses (${url.host}): pass the fake Kreloses' transport.`);
  }
  return realFetch(input, init);
};

/** The real-Kreloses requests blocked so far in this test (and forgets them). */
export function takeBlockedKrelosesRequests(): string[] {
  return blocked.splice(0, blocked.length);
}

afterEach(() => {
  const attempted = takeBlockedKrelosesRequests();
  if (attempted.length > 0) {
    throw new Error(`This test tried to contact the real Kreloses: ${attempted.join(", ")}. Pass the fake's transport.`);
  }
});
