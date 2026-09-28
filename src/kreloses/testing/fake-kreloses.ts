import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { KRELOSES_SEA_URL, KRELOSES_WWW_URL } from "../config";
import type { Transport, TransportRequest } from "../transport";

import { SYNTHETIC_ACCOUNTS, type FakeAccount } from "./synthetic-accounts";

/**
 * A fake Kreloses for tests: a `Transport` that answers like www.kreloses.com and
 * sea.kreloses.com, built from the synthetic fixtures in `../__fixtures__` (see the README there).
 * Unit tests hand `fake.transport` to the Reader; the e2e suite serves the same fake over HTTP
 * (`e2e/support/fake-kreloses-server.ts`), so real Kreloses is never contacted by any test.
 *
 * It behaves like the real ASP.NET MVC site where it matters to the Reader: the anti-forgery
 * token must come back in both the form and its cookie (otherwise HTTP 500, as MVC does), the auth
 * cookie is scoped to the parent domain, and EVERY sea path needs a signed-in session — without
 * one, a page load is redirected to the www login page and an AJAX call (X-Requested-With) gets
 * ASP.NET Identity's HTTP 200 + `X-Responded-JSON` 401.
 *
 * Extending it (tickets #4, #5): add a route to `BUILT_IN_ROUTES` below (or `fake.addRoute(…)` in
 * a test), backed by fixture files; sea routes get the login check for free. Use `intercept()` in
 * a test to inject one-off responses (errors, odd shapes) and `expireSessions()` for expiry.
 */

export const FIXTURES_DIR = fileURLToPath(new URL("../__fixtures__/", import.meta.url));

export { SYNTHETIC_ACCOUNTS, type FakeAccount } from "./synthetic-accounts";

export interface RecordedRequest {
  method: string;
  url: URL;
  /** Lower-case header names. */
  headers: Record<string, string>;
  body: string | undefined;
}

export type Interceptor = (request: RecordedRequest) => Response | undefined | Promise<Response | undefined>;

export interface FakeRouteContext {
  request: RecordedRequest;
  /** The signed-in account. Always set for sea routes (unless the route is `public`). */
  account: FakeAccount | undefined;
  /** `fixtureResponse(name, variables)` with the fake's hosts. */
  fixture(name: string, variables?: Record<string, string>): Response;
}

export interface FakeRoute {
  host: "www" | "sea";
  method: "GET" | "POST";
  /** A string matches the path exactly, ignoring case and a trailing slash; or a RegExp. */
  path: string | RegExp;
  /** www routes are always public. A sea route answers only signed-in requests unless `public`. */
  public?: boolean;
  handler(context: FakeRouteContext): Response | Promise<Response>;
}

export interface FakeKrelosesOptions {
  accounts?: readonly FakeAccount[];
  baseUrls?: { www: string; sea: string };
  /**
   * How sea answers an AJAX call without a valid session: `x-responded-json` (default; what
   * ASP.NET Identity's cookie middleware does) or `redirect` (a plain 302 to the login page).
   */
  ajaxAuthFailure?: "x-responded-json" | "redirect";
  /** The Sale List (`POST /Sale/Get`). */
  saleList?: {
    /** The rows to serve (default: `__fixtures__/sale-list-rows.json`). */
    rows?: SaleListRow[];
    /** Behave as if Kreloses ignored the filter's Date range (tests the Reader's own date check). */
    ignoreDateFilter?: boolean;
  };
}

/** One raw Sale List row, as `/Sale/Get` returns it (see `__fixtures__/sale-list-rows.json`). */
export type SaleListRow = Record<string, unknown>;

/** The synthetic Sale List rows in `__fixtures__/sale-list-rows.json` (a fresh copy each call). */
export function readSaleListRows(): SaleListRow[] {
  return (JSON.parse(readFixture("sale-list-rows.json")) as { rows: SaleListRow[] }).rows;
}

export interface FakeKreloses {
  transport: Transport;
  /** Every request received, in order. */
  requests: RecordedRequest[];
  /** Adds a handler that runs before any route; return a Response to answer, or undefined. */
  intercept(interceptor: Interceptor): void;
  /** Adds a route (checked before the built-in ones). Sea routes get the login check. */
  addRoute(route: FakeRoute): void;
  /** Invalidates every auth ticket, as if every session had expired. */
  expireSessions(): void;
  /**
   * The Sale List rows this fake serves. Mutable: change a row (e.g. cancel a sale) or push one,
   * and the next `/Sale/Get` sees it.
   */
  saleRows: SaleListRow[];
}

/** The anti-forgery pair in the fixtures (the form value is HTML-encoded there: `&#x2B;` is `+`). */
const FORM_TOKEN = "SYNTHETIC-FORM-TOKEN-7f3a9c1e2b4d+Qw==";
const COOKIE_TOKEN = "SYNTHETIC-COOKIE-TOKEN-51c0ffee";
const AUTH_COOKIE = ".AspNet.ApplicationCookie";

export function createFakeKreloses(options: FakeKrelosesOptions = {}): FakeKreloses {
  const accounts: readonly FakeAccount[] = options.accounts ?? Object.values(SYNTHETIC_ACCOUNTS);
  const www = new URL(options.baseUrls?.www ?? KRELOSES_WWW_URL);
  const sea = new URL(options.baseUrls?.sea ?? KRELOSES_SEA_URL);
  const hosts = { www, sea };
  const requests: RecordedRequest[] = [];
  const interceptors: Interceptor[] = [];
  const addedRoutes: FakeRoute[] = [];
  const sessions = new Map<string, FakeAccount>();
  const saleRows: SaleListRow[] = options.saleList?.rows ?? readSaleListRows();

  function postLogin({ request, fixture }: FakeRouteContext): Response {
    const form = new URLSearchParams(request.body ?? "");
    if (form.get("__RequestVerificationToken") !== FORM_TOKEN || readCookie(request.headers.cookie, "__RequestVerificationToken") !== COOKIE_TOKEN) {
      return new Response(
        "<html><body><h1>Server Error in '/' Application.</h1><p>The required anti-forgery form field \"__RequestVerificationToken\" is not present.</p></body></html>",
        { status: 500, headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    }
    const email = (form.get("Email") ?? "").trim().toLowerCase();
    const account = accounts.find((candidate) => candidate.email.toLowerCase() === email && candidate.password === form.get("Password"));
    if (!account) return fixture("post-login-bad-credentials");

    switch (account.behaviour ?? "ok") {
      case "kreloses_down":
        return new Response("<html><body><h1>Service Unavailable</h1></body></html>", {
          status: 503,
          headers: { "Content-Type": "text/html" },
        });
      case "rate_limited":
        return new Response("Too Many Requests", { status: 429, headers: { "Retry-After": "120" } });
      case "one_time_code":
        return fixture("post-login-one-time-code", { AUTH_TICKET: newTicket() });
      case "host_only_cookie": {
        const ticket = newTicket();
        sessions.set(ticket, account);
        return fixtureResponse("post-login-success", { AUTH_TICKET: ticket }, hosts, { hostOnlyCookies: true });
      }
      default: {
        const ticket = newTicket();
        sessions.set(ticket, account);
        return fixture("post-login-success", { AUTH_TICKET: ticket });
      }
    }
  }

  function getFilter({ request, account, fixture }: FakeRouteContext): Response {
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
        filter.Options = filter.Options.filter((option) => option.Value === "" || account!.locationIds.includes(option.Value));
      }
    }
    const response = fixture("post-get-filter");
    return new Response(JSON.stringify(template), { status: response.status, headers: response.headers });
  }

  /**
   * `POST /Sale/Get`: the Sale List, as Kreloses would answer it. The `filter` (the report-14
   * template with selections) narrows the rows by Sale status (selected option texts), Location
   * (selected option values; always only the login's own locations) and Date (`From`/`To`, as
   * dd/MM/yyyy or ISO); no `filter` means the template's defaults (Active only, its default dates).
   * Rows come newest first, paged by `RequestingPage` / `PageSize`.
   */
  function saleGet({ request, account, fixture }: FakeRouteContext): Response {
    let body: { request?: Record<string, unknown>; filter?: unknown };
    try {
      body = JSON.parse(request.body ?? "") as typeof body;
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
    const pageSize = Number(body.request?.PageSize);
    const page = Number(body.request?.RequestingPage);
    if (!Number.isInteger(pageSize) || pageSize < 1 || !Number.isInteger(page) || page < 1) {
      return new Response("Bad Request", { status: 400 });
    }
    const template = (body.filter ?? JSON.parse(readFixture("report-14-filter.json"))) as { Filters?: FakeFilter[] };
    const filters = template.Filters ?? [];
    const selected = (name: string) =>
      (filters.find((filter) => filter.Name === name)?.Options ?? []).filter((option) => option.Selected && option.Value !== "");
    const statuses = selected("Sale status").map((option) => option.Text.toLowerCase());
    const locations = selected("Location").map((option) => option.Value);
    const date = filters.find((filter) => filter.Name === "Date");
    const from = options.saleList?.ignoreDateFilter ? null : fakeFilterDate(date?.From);
    const to = options.saleList?.ignoreDateFilter ? null : fakeFilterDate(date?.To);

    const rows = saleRows
      .filter((row) => {
        const locationId = String(row.LocationId);
        if (!account!.locationIds.includes(locationId)) return false;
        if (locations.length > 0 && !locations.includes(locationId)) return false;
        if (statuses.length > 0 && !statuses.includes(String(row.SaleStatusName).toLowerCase())) return false;
        const day = fakeSaleDay(row.SaleDate);
        return !day || ((!from || day >= from) && (!to || day <= to));
      })
      .sort((a, b) => fakeSaleTime(b.SaleDate) - fakeSaleTime(a.SaleDate) || Number(b.SaleId) - Number(a.SaleId));
    const response = fixture("post-sale-get");
    return new Response(
      JSON.stringify({
        Columns: SALE_LIST_COLUMNS,
        Results: rows.slice((page - 1) * pageSize, page * pageSize),
        TotalCount: rows.length,
      }),
      { status: response.status, headers: response.headers },
    );
  }

  const BUILT_IN_ROUTES: FakeRoute[] = [
    {
      host: "www",
      method: "GET",
      path: "/account/login",
      handler: ({ fixture }) => fixture("get-login", { ASPNET_SESSION: randomBytes(12).toString("hex") }),
    },
    { host: "www", method: "POST", path: "/account/login", handler: postLogin },
    { host: "www", method: "GET", path: "/account/verifycode", handler: ({ fixture }) => fixture("get-verify-code") },
    { host: "sea", method: "GET", path: "/", handler: ({ fixture }) => fixture("get-sea-root") },
    { host: "sea", method: "GET", path: "/home/index", handler: ({ fixture }) => fixture("get-sea-home") },
    { host: "sea", method: "POST", path: "/report/getfilter", handler: getFilter },
    { host: "sea", method: "POST", path: "/sale/get", handler: saleGet },
  ];

  function matches(route: FakeRoute, request: RecordedRequest): boolean {
    const onHost = request.url.host === (route.host === "www" ? www.host : sea.host);
    if (!onHost || route.method !== request.method) return false;
    if (route.path instanceof RegExp) return route.path.test(request.url.pathname);
    const normalise = (value: string) => value.toLowerCase().replace(/\/+$/, "") || "/";
    return normalise(route.path) === normalise(request.url.pathname);
  }

  function route(request: RecordedRequest): Response | Promise<Response> {
    if (request.url.pathname === "/__health") return new Response("ok");
    const ticket = readCookie(request.headers.cookie, AUTH_COOKIE);
    const account = ticket ? sessions.get(ticket) : undefined;
    const fixture = (name: string, variables: Record<string, string> = {}) => fixtureResponse(name, variables, hosts);
    const context: FakeRouteContext = { request, account, fixture };

    const found = [...addedRoutes, ...BUILT_IN_ROUTES].find((candidate) => matches(candidate, request));
    // Every sea path, known or not, needs a signed-in session first.
    const needsSession = found ? found.host === "sea" && !found.public : request.url.host === sea.host;
    if (needsSession && !account) {
      const ajax = request.headers["x-requested-with"]?.toLowerCase() === "xmlhttprequest";
      const answer = ajax && (options.ajaxAuthFailure ?? "x-responded-json") === "x-responded-json";
      return fixture(answer ? "sea-ajax-not-signed-in" : "sea-not-signed-in");
    }
    if (found) return found.handler(context);
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
    addRoute: (added) => void addedRoutes.push(added),
    expireSessions: () => sessions.clear(),
    saleRows,
  };
}

interface FakeFilter {
  Name: string;
  Options?: { Value: string; Text: string; Selected?: boolean }[];
  From?: string;
  To?: string;
}

/** Synthetic grid columns (the Reader does not use them). */
const SALE_LIST_COLUMNS = [
  { Field: "SaleName", Title: "Sale", Sortable: true },
  { Field: "SaleDate", Title: "Date", Sortable: true },
  { Field: "Location", Title: "Location", Sortable: true },
  { Field: "CustomerName", Title: "Customer", Sortable: true },
  { Field: "SaleStatusName", Title: "Status", Sortable: true },
  { Field: "Total", Title: "Total", Sortable: false },
];

const KL_OFFSET_MS = 8 * 60 * 60 * 1000;

/** A row's `/Date(ms)/` as ms (0 if it is in another format). */
function fakeSaleTime(value: unknown): number {
  const match = /^\/Date\((-?\d+)/.exec(String(value));
  return match ? Number(match[1]) : 0;
}

/** A row's clinic (UTC+8) date, or null if its SaleDate is not `/Date(ms)/`. */
function fakeSaleDay(value: unknown): string | null {
  const ms = fakeSaleTime(value);
  return ms ? new Date(ms + KL_OFFSET_MS).toISOString().slice(0, 10) : null;
}

/** A filter date (`dd/MM/yyyy` or ISO) as `YYYY-MM-DD`, or null. */
function fakeFilterDate(value: string | undefined): string | null {
  const dayFirst = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value ?? "");
  if (dayFirst) return `${dayFirst[3]}-${dayFirst[2]}-${dayFirst[1]}`;
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(value ?? "");
  return iso ? iso[1]! : null;
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
