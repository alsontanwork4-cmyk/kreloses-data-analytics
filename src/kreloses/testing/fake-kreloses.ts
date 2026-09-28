import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { KRELOSES_SEA_URL, KRELOSES_WWW_URL } from "../config";
import type { Transport, TransportRequest } from "../transport";

/**
 * A fake Kreloses for tests: a `Transport` that answers like www.kreloses.com and
 * sea.kreloses.com, built from the synthetic fixtures in `../__fixtures__` (see the README there).
 * Unit tests hand `fake.transport` to the Reader; the e2e suite serves the same fake over HTTP
 * (`e2e/support/fake-kreloses-server.ts`), so real Kreloses is never contacted by any test.
 *
 * It behaves like the real ASP.NET MVC site where it matters to the Reader: the anti-forgery
 * token must come back in both the form and its cookie (otherwise HTTP 500, as MVC does), the auth
 * cookie is scoped to the parent domain, and sea redirects to the www login page without it.
 *
 * Extending it (tickets #4, #5): add a route in `route()` backed by a new fixture file, and use
 * `intercept()` in a test to inject one-off responses (errors, odd shapes).
 */

export const FIXTURES_DIR = path.join(process.cwd(), "src", "kreloses", "__fixtures__");

export interface FakeAccount {
  email: string;
  password: string;
  /** Location ids (from `report-14-filter.json`) this login can see. */
  locationIds: string[];
  /**
   * `ok` (default); `one_time_code` (redirects to a code page after the password);
   * `host_only_cookie` (auth cookie without Domain, so it never reaches sea);
   * `kreloses_down` (HTTP 503 on the login POST); `rate_limited` (HTTP 429 on the login POST).
   */
  behaviour?: "ok" | "one_time_code" | "host_only_cookie" | "kreloses_down" | "rate_limited";
}

/** Synthetic logins used by tests and the e2e fake server. None of these exist anywhere. */
export const SYNTHETIC_ACCOUNTS = {
  north: { email: "north.branch@clinic.example", password: "north-pass-1101", locationIds: ["1101"] },
  south: { email: "south.branch@clinic.example", password: "south-pass-1102", locationIds: ["1102"] },
  both: { email: "both.branches@clinic.example", password: "both-pass-1101-1102", locationIds: ["1101", "1102"] },
  oneTimeCode: {
    email: "two.step@clinic.example",
    password: "two-step-pass",
    locationIds: ["1101"],
    behaviour: "one_time_code",
  },
  hostOnlyCookie: {
    email: "host.only@clinic.example",
    password: "host-only-pass",
    locationIds: ["1101"],
    behaviour: "host_only_cookie",
  },
  down: { email: "kreloses.down@clinic.example", password: "down-pass", locationIds: [], behaviour: "kreloses_down" },
  rateLimited: {
    email: "rate.limited@clinic.example",
    password: "rate-limited-pass",
    locationIds: [],
    behaviour: "rate_limited",
  },
} as const satisfies Record<string, FakeAccount>;

export interface RecordedRequest {
  method: string;
  url: URL;
  /** Lower-case header names. */
  headers: Record<string, string>;
  body: string | undefined;
}

export type Interceptor = (request: RecordedRequest) => Response | undefined | Promise<Response | undefined>;

export interface FakeKreloses {
  transport: Transport;
  /** Every request received, in order. */
  requests: RecordedRequest[];
  /** Adds a handler that runs before the built-in routes; return a Response to answer, or undefined. */
  intercept(interceptor: Interceptor): void;
  /** Invalidates every auth ticket, as if every session had expired. */
  expireSessions(): void;
}

/** The anti-forgery pair in the fixtures (the form value is HTML-encoded there: `&#x2B;` is `+`). */
const FORM_TOKEN = "SYNTHETIC-FORM-TOKEN-7f3a9c1e2b4d+Qw==";
const COOKIE_TOKEN = "SYNTHETIC-COOKIE-TOKEN-51c0ffee";
const AUTH_COOKIE = ".AspNet.ApplicationCookie";

export function createFakeKreloses(
  options: { accounts?: readonly FakeAccount[]; baseUrls?: { www: string; sea: string } } = {},
): FakeKreloses {
  const accounts: readonly FakeAccount[] = options.accounts ?? Object.values(SYNTHETIC_ACCOUNTS);
  const www = new URL(options.baseUrls?.www ?? KRELOSES_WWW_URL);
  const sea = new URL(options.baseUrls?.sea ?? KRELOSES_SEA_URL);
  const hosts = { www, sea };
  const requests: RecordedRequest[] = [];
  const interceptors: Interceptor[] = [];
  const sessions = new Map<string, FakeAccount>();

  function signedInAccount(request: RecordedRequest): FakeAccount | undefined {
    const ticket = readCookie(request.headers.cookie, AUTH_COOKIE);
    return ticket ? sessions.get(ticket) : undefined;
  }

  function postLogin(request: RecordedRequest): Response {
    const form = new URLSearchParams(request.body ?? "");
    if (form.get("__RequestVerificationToken") !== FORM_TOKEN || readCookie(request.headers.cookie, "__RequestVerificationToken") !== COOKIE_TOKEN) {
      return new Response(
        "<html><body><h1>Server Error in '/' Application.</h1><p>The required anti-forgery form field \"__RequestVerificationToken\" is not present.</p></body></html>",
        { status: 500, headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    }
    const email = (form.get("Email") ?? "").trim().toLowerCase();
    const account = accounts.find((candidate) => candidate.email.toLowerCase() === email && candidate.password === form.get("Password"));
    if (!account) return fixtureResponse("post-login-bad-credentials", {}, hosts);

    switch (account.behaviour ?? "ok") {
      case "kreloses_down":
        return new Response("<html><body><h1>Service Unavailable</h1></body></html>", {
          status: 503,
          headers: { "Content-Type": "text/html" },
        });
      case "rate_limited":
        return new Response("Too Many Requests", { status: 429, headers: { "Retry-After": "120" } });
      case "one_time_code":
        return fixtureResponse("post-login-one-time-code", { AUTH_TICKET: newTicket() }, hosts);
      case "host_only_cookie": {
        const ticket = newTicket();
        sessions.set(ticket, account);
        return fixtureResponse("post-login-success", { AUTH_TICKET: ticket }, hosts, { hostOnlyCookies: true });
      }
      default: {
        const ticket = newTicket();
        sessions.set(ticket, account);
        return fixtureResponse("post-login-success", { AUTH_TICKET: ticket }, hosts);
      }
    }
  }

  function getFilter(request: RecordedRequest, account: FakeAccount): Response {
    let report: unknown;
    try {
      report = (JSON.parse(request.body ?? "") as { report?: unknown }).report;
    } catch {
      report = undefined;
    }
    if (report !== 14) return new Response("Not found", { status: 404 });
    const template = JSON.parse(readFixture("report-14-filter.json")) as {
      Filters: { Name: string; Options?: { Value: string }[] }[];
    };
    for (const filter of template.Filters) {
      if (filter.Name === "Location" && filter.Options) {
        filter.Options = filter.Options.filter((option) => option.Value === "" || account.locationIds.includes(option.Value));
      }
    }
    const response = fixtureResponse("post-get-filter", {}, hosts);
    return new Response(JSON.stringify(template), { status: response.status, headers: response.headers });
  }

  function route(request: RecordedRequest): Response {
    const { method, url } = request;
    const routePath = url.pathname.toLowerCase().replace(/\/+$/, "") || "/";
    if (routePath === "/__health") return new Response("ok");

    if (url.host === www.host) {
      if (routePath === "/account/login" && method === "GET") {
        return fixtureResponse("get-login", { ASPNET_SESSION: randomBytes(12).toString("hex") }, hosts);
      }
      if (routePath === "/account/login" && method === "POST") return postLogin(request);
      if (routePath === "/account/verifycode" && method === "GET") return fixtureResponse("get-verify-code", {}, hosts);
    }
    if (url.host === sea.host) {
      const account = signedInAccount(request);
      const isSeaRoute = ["/", "/home/index", "/report/getfilter"].includes(routePath);
      if (isSeaRoute && !account) return fixtureResponse("sea-not-signed-in", {}, hosts);
      if (account && routePath === "/" && method === "GET") return fixtureResponse("get-sea-root", {}, hosts);
      if (account && routePath === "/home/index" && method === "GET") return fixtureResponse("get-sea-home", {}, hosts);
      if (account && routePath === "/report/getfilter" && method === "POST") return getFilter(request, account);
    }
    return new Response("<html><body><h1>404 - Not found</h1></body></html>", {
      status: 404,
      headers: { "Content-Type": "text/html" },
    });
  }

  const transport: Transport = async (url: string, init: TransportRequest) => {
    const request: RecordedRequest = {
      method: init.method,
      url: new URL(url),
      headers: Object.fromEntries(Object.entries(init.headers).map(([name, value]) => [name.toLowerCase(), value])),
      body: init.body,
    };
    requests.push(request);
    for (const interceptor of interceptors) {
      const response = await interceptor(request);
      if (response) return response;
    }
    return route(request);
  };

  return {
    transport,
    requests,
    intercept: (interceptor) => void interceptors.push(interceptor),
    expireSessions: () => sessions.clear(),
  };
}

export function readFixture(name: string): string {
  return readFileSync(path.join(FIXTURES_DIR, name), "utf8");
}

interface ResponseFixture {
  status: number;
  headers: Record<string, string>;
  setCookie: string[];
  body?: string;
  bodyFile?: string;
}

/**
 * Builds a Response from `<name>.response.json`, with `{{VAR}}` placeholders filled in and the
 * real Kreloses hosts swapped for the fake's. The auth cookie's `domain=.kreloses.com` becomes the
 * fake hosts' shared parent domain, or is dropped when they have none (e.g. both 127.0.0.1).
 */
export function fixtureResponse(
  name: string,
  variables: Record<string, string>,
  hosts: { www: URL; sea: URL },
  options: { hostOnlyCookies?: boolean } = {},
): Response {
  const fixture = JSON.parse(readFixture(`${name}.response.json`)) as ResponseFixture;
  const fill = (text: string) =>
    text
      .replace(/\{\{(\w+)\}\}/g, (_match, key: string) => variables[key] ?? "")
      .replaceAll(KRELOSES_WWW_URL, hosts.www.origin)
      .replaceAll(KRELOSES_SEA_URL, hosts.sea.origin);
  const cookieDomain = sharedParentDomain(hosts.www.hostname, hosts.sea.hostname);

  const headers = new Headers();
  for (const [header, value] of Object.entries(fixture.headers)) headers.set(header, fill(value));
  for (const cookie of fixture.setCookie) {
    const filled = fill(cookie);
    headers.append(
      "Set-Cookie",
      options.hostOnlyCookies || !cookieDomain
        ? filled.replace(/;\s*domain=[^;]*/i, "")
        : filled.replace(/;\s*domain=[^;]*/i, `; domain=.${cookieDomain}`),
    );
  }
  const body = fixture.bodyFile ? fill(readFixture(fixture.bodyFile)) : fill(fixture.body ?? "");
  const isRedirect = fixture.status >= 300 && fixture.status < 400;
  return new Response(isRedirect && !body ? null : body, { status: fixture.status, headers });
}

/** `kreloses.com` for www.kreloses.com + sea.kreloses.com; null for identical hosts or IPs. */
function sharedParentDomain(a: string, b: string): string | null {
  if (a === b || /^[\d.]+$/.test(a) || a.includes(":")) return null;
  const partsA = a.split(".").reverse();
  const partsB = b.split(".").reverse();
  const shared: string[] = [];
  for (let i = 0; i < Math.min(partsA.length, partsB.length) && partsA[i] === partsB[i]; i += 1) shared.push(partsA[i]!);
  return shared.length >= 2 ? shared.reverse().join(".") : null;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

function newTicket(): string {
  return `SYNTHETIC-AUTH-${randomBytes(16).toString("hex")}`;
}
