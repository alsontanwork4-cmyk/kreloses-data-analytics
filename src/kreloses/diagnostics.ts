import type { ReaderOptions } from "./config";
import type { CookieChange, CookieSummary } from "./cookie-jar";
import { AuthFailed, LayoutChanged } from "./errors";
import { describeJsonShape, fetchFilterTemplate, parseLocations, SALE_LIST_REPORT } from "./locations";
import { login, type KrelosesCredentials } from "./login";
import type { InvoiceDateRange } from "./sale-list";
import { formatSaleOverviewDiagnostic, probeSaleOverview, type SaleOverviewDiagnostic } from "./sale-overview-diagnostic";
import { parseStaff } from "./staff";
import {
  defaultDiagnosticRange,
  describeDiagnosticError,
  formatSaleListDiagnostic,
  probeSaleList,
  type SaleListDiagnostic,
} from "./sale-list-diagnostic";
import type { HopEvent, KrelosesSession } from "./session";

/**
 * A redacted account of one real login, for the opt-in live smoke test (`npm run test:live`).
 * It answers the spec's open questions about server-side login — is there a one-time-code step,
 * which host does the session cookie work on, what are the cookies' scopes and lifetimes, how
 * long does a session last — and reads one Sale List page to check the Reader's assumptions about
 * its structure (`./sale-list-diagnostic.ts`), without recording anything secret or personal: no
 * email, password, cookie values, tokens, query strings, names, amounts or ids. It also opens ONE
 * invoice's Sale Overview page (`./sale-overview-diagnostic.ts`, #5) and counts the staff the Sale
 * List filter lists. The owner pastes it into a public ticket.
 */
export interface LoginDiagnostic {
  hops: HopEvent[];
  login: { ok: true; durationMs: number } | { ok: false; durationMs: number; error: string };
  oneTimeCodeStep: boolean;
  /** The host an authenticated request succeeded on, or null. */
  sessionWorksOn: string | null;
  /** Null when the login failed (not checked). */
  locations: { ok: true; count: number } | { ok: false; error: string } | null;
  filterShape: string | null;
  /** One page of the Sale List, structure only. Null when the login or GetFilter failed. */
  saleList: SaleListDiagnostic | null;
  /** How many staff the Sale List filter lists (never their names). Null when not checked. */
  staff: { ok: true; count: number } | { ok: false; error: string } | null;
  /** ONE invoice's Sale Overview page, structure only. Null when the Sale List was not read. */
  saleOverview: SaleOverviewDiagnostic | null;
  cookies: CookieSummary[];
  probes: { afterMinutes: number; ok: boolean; error?: string }[];
}

export interface DiagnosticOptions {
  reader?: ReaderOptions;
  /** Keep re-checking the session for this many minutes (0 = don't). */
  probeMinutes?: number;
  probeIntervalMinutes?: number;
  sleep?: (ms: number) => Promise<void>;
  /** The clinic days of the Sale List page to read. Default: the previous month up to today. */
  saleListRange?: InvoiceDateRange;
}

export async function runLoginDiagnostic(
  credentials: KrelosesCredentials,
  options: DiagnosticOptions = {},
): Promise<LoginDiagnostic> {
  const hops: HopEvent[] = [];
  const reader: ReaderOptions = {
    ...options.reader,
    observer: (hop) => {
      hops.push(hop);
      options.reader?.observer?.(hop);
    },
  };
  const diagnostic: LoginDiagnostic = {
    hops,
    login: { ok: true, durationMs: 0 },
    oneTimeCodeStep: false,
    sessionWorksOn: null,
    locations: null,
    filterShape: null,
    saleList: null,
    staff: null,
    saleOverview: null,
    cookies: [],
    probes: [],
  };

  const startedAt = Date.now();
  let session: KrelosesSession;
  try {
    session = await login(credentials, reader);
    diagnostic.login = { ok: true, durationMs: Date.now() - startedAt };
  } catch (error) {
    diagnostic.login = { ok: false, durationMs: Date.now() - startedAt, error: describeError(error) };
    diagnostic.oneTimeCodeStep = error instanceof AuthFailed && error.step === "one_time_code";
    return diagnostic;
  }

  let template: unknown = undefined;
  try {
    template = await fetchFilterTemplate(session, SALE_LIST_REPORT);
    diagnostic.sessionWorksOn = session.appHost;
    diagnostic.filterShape = describeJsonShape(template);
    diagnostic.locations = { ok: true, count: parseLocations(template).length };
  } catch (error) {
    diagnostic.locations = { ok: false, error: describeError(error) };
    if (error instanceof LayoutChanged) diagnostic.filterShape = error.shape ?? null;
  }
  if (diagnostic.sessionWorksOn) {
    try {
      diagnostic.staff = { ok: true, count: parseStaff(template).length };
    } catch (error) {
      diagnostic.staff = { ok: false, error: describeError(error) };
    }
    diagnostic.saleList = await probeSaleList(session, template, options.saleListRange ?? defaultDiagnosticRange());
    diagnostic.saleOverview = await probeSaleOverview(session, diagnostic.saleList.sample ?? null);
  }

  const probeMinutes = options.probeMinutes ?? 0;
  const interval = options.probeIntervalMinutes ?? 5;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (diagnostic.sessionWorksOn) {
    for (let minutes = interval; minutes <= probeMinutes; minutes += interval) {
      await sleep(interval * 60_000);
      try {
        await fetchFilterTemplate(session, SALE_LIST_REPORT);
        diagnostic.probes.push({ afterMinutes: minutes, ok: true });
      } catch (error) {
        diagnostic.probes.push({ afterMinutes: minutes, ok: false, error: describeError(error) });
        break;
      }
    }
  }

  diagnostic.cookies = session.describeCookies();
  return diagnostic;
}

export function formatLoginDiagnostic(diagnostic: LoginDiagnostic): string {
  const lines = [
    "Kreloses live check (redacted: no email, password, cookie values, tokens, query strings, names, amounts or ids)",
    "",
  ];
  lines.push("HTTP exchanges:");
  for (const hop of diagnostic.hops) {
    const outcome = hop.status === null ? `no response (${hop.failure})` : String(hop.status);
    const extras = [
      hop.location ? `-> ${hop.location}` : null,
      hop.contentType ? `[${hop.contentType}]` : null,
      hop.respondedJsonStatus !== undefined ? `[X-Responded-JSON status ${hop.respondedJsonStatus}]` : null,
    ];
    lines.push(`  ${hop.seq}. ${hop.method} ${hop.url} -> ${outcome}${extras.filter(Boolean).map((x) => ` ${x}`).join("")} (${hop.durationMs} ms)`);
    for (const change of hop.setCookies) lines.push(`       ${describeCookieChange(change)}`);
  }
  lines.push("");
  lines.push(
    diagnostic.login.ok
      ? `Login: OK (${(diagnostic.login.durationMs / 1000).toFixed(1)} s incl. polite delays)`
      : `Login: FAILED — ${diagnostic.login.error}`,
  );
  lines.push(`One-time code / 2FA step detected: ${diagnostic.oneTimeCodeStep ? "YES" : "no"}`);
  lines.push(`Session works on: ${diagnostic.sessionWorksOn ?? "not established"}`);
  if (diagnostic.locations === null) lines.push("Visible locations: not checked (login failed)");
  else if (diagnostic.locations.ok) lines.push(`Visible locations: ${diagnostic.locations.count}`);
  else lines.push(`Visible locations: FAILED — ${diagnostic.locations.error}`);
  if (diagnostic.filterShape) lines.push(`GetFilter (report 14) JSON shape: ${diagnostic.filterShape}`);
  if (diagnostic.staff) {
    lines.push(
      diagnostic.staff.ok
        ? `Staff filter (report 14): ${diagnostic.staff.count} staff members (names not shown)`
        : `Staff filter (report 14): FAILED — ${diagnostic.staff.error}`,
    );
  }
  if (diagnostic.saleList) lines.push(...formatSaleListDiagnostic(diagnostic.saleList));
  if (diagnostic.saleOverview) lines.push(...formatSaleOverviewDiagnostic(diagnostic.saleOverview));
  for (const probe of diagnostic.probes) {
    lines.push(
      probe.ok
        ? `Session probe: still valid after ${probe.afterMinutes} min`
        : `Session probe: FAILED after ${probe.afterMinutes} min — ${probe.error}`,
    );
  }
  if (diagnostic.cookies.length > 0) {
    lines.push("Cookies held at the end:");
    for (const cookie of diagnostic.cookies) lines.push(`  ${describeCookie(cookie)}`);
  }
  return maskUrlPaths(lines.join("\n"), diagnostic);
}

/**
 * Generic route words kept as-is in URL paths; any other path segment could be data (a clinic's
 * own slug, a name) and is printed as `<segment>`, numbers as `<number>`.
 */
const ROUTE_WORDS = new Set(
  [
    "account", "login", "logon", "logoff", "logout", "signin", "signout", "register", "confirm", "lockout",
    "forgotpassword", "resetpassword", "verifycode", "sendcode", "twofactor", "externallogin",
    "externallogincallback", "accessdenied", "authorize", "oauth", "connect", "callback", "home", "index",
    "default", "dashboard", "app", "api", "report", "reports", "getfilter", "sale", "sales", "get", "list",
    "overview", "detail", "details", "invoice", "invoices", "customer", "customers", "staff", "settings",
    "profile", "manage", "select", "selectlocation", "location", "locations", "branch", "branches", "clinic",
    "region", "error", "errors", "content", "scripts", "bundles",
  ],
);

function maskPath(hostAndPath: string): string {
  const slash = hostAndPath.indexOf("/");
  if (slash < 0) return hostAndPath;
  const segments = hostAndPath
    .slice(slash + 1)
    .split("/")
    .map((segment) =>
      segment === "" ? "" : /^\d+$/.test(segment) ? "<number>" : ROUTE_WORDS.has(segment.toLowerCase()) ? segment : "<segment>",
    );
  return `${hostAndPath.slice(0, slash)}/${segments.join("/")}`;
}

/** Replaces every URL path seen in the hops (wherever it appears in the report) by its masked form. */
function maskUrlPaths(report: string, diagnostic: LoginDiagnostic): string {
  const urls = new Set<string>();
  for (const hop of diagnostic.hops) {
    urls.add(hop.url);
    if (hop.location) urls.add(hop.location);
  }
  let masked = report;
  for (const url of [...urls].sort((a, b) => b.length - a.length)) {
    const replacement = maskPath(url);
    if (replacement !== url) masked = masked.replaceAll(url, replacement);
  }
  return masked;
}

const describeError = describeDiagnosticError;

function describeCookieChange(change: CookieChange): string {
  if (change.action === "rejected") return `rejected ${change.name} (Domain=${change.domain} does not cover this host)`;
  return `${change.action} ${describeCookie(change as CookieSummary)}`;
}

function describeCookie(cookie: CookieSummary): string {
  const flags = [
    cookie.hostOnly ? `host-only ${cookie.domain}` : `Domain=${cookie.domain}`,
    `Path=${maskPath(`x${cookie.path}`).slice(1)}`,
    cookie.expiresAt ? `expires ${cookie.expiresAt}` : "session cookie",
    cookie.secure ? "Secure" : null,
    cookie.httpOnly ? "HttpOnly" : null,
    cookie.sameSite ? `SameSite=${cookie.sameSite}` : null,
  ];
  return `${cookie.name} (${flags.filter(Boolean).join(", ")})`;
}
