import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PUBLIC_EXACT_PATHS, isPublicPath } from "@/auth/paths";

import type { BackfillOutcome } from "./backfill";
import { handleBackfillCron, handleNightlyCron, isAuthorizedCronRequest, MIN_CRON_SECRET_LENGTH } from "./cron";
import type { NightlyConnectionResult } from "./nightly";

/**
 * The nightly cron endpoint authenticates itself (it is a public path: Vercel Cron has no session)
 * with `Authorization: Bearer <CRON_SECRET>`, failing closed.
 */
const SECRET = "synthetic-cron-secret-0123456789";

const request = (authorization?: string) =>
  new Request("http://localhost/api/cron/nightly", { headers: authorization === undefined ? {} : { Authorization: authorization } });

describe("nightly cron authentication", () => {
  afterEach(() => vi.restoreAllMocks());

  it("accepts exactly `Bearer <CRON_SECRET>`", () => {
    expect(isAuthorizedCronRequest(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it("refuses a missing, wrong or differently written bearer", () => {
    for (const header of [null, undefined, "", SECRET, `Bearer ${SECRET}x`, `Bearer ${SECRET.slice(0, -1)}`, `bearer ${SECRET}`, `Bearer  ${SECRET}`, `Basic ${SECRET}`]) {
      expect(isAuthorizedCronRequest(header, SECRET), String(header)).toBe(false);
    }
  });

  it("fails closed: with no CRON_SECRET (or a short one) nothing is accepted", () => {
    for (const secret of [undefined, "", "short"]) {
      for (const header of [undefined, "Bearer ", "Bearer undefined", `Bearer ${secret}`, "Bearer short"]) {
        expect(isAuthorizedCronRequest(header, secret), `${secret} / ${header}`).toBe(false);
      }
    }
    expect(isAuthorizedCronRequest(`Bearer ${"x".repeat(MIN_CRON_SECRET_LENGTH)}`, "x".repeat(MIN_CRON_SECRET_LENGTH))).toBe(true);
  });

  it("answers 401 and runs nothing without the right secret", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const run = vi.fn(async (): Promise<NightlyConnectionResult[]> => []);
    for (const [secret, header] of [
      [undefined, undefined],
      [undefined, "Bearer undefined"],
      ["", "Bearer "],
      [SECRET, undefined],
      [SECRET, "Bearer wrong-secret-0123456789"],
    ] as const) {
      const response = await handleNightlyCron(request(header), { secret, run });
      expect(response.status, `${secret} / ${header}`).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("runs the nightly sync with the right secret and reports each connection (no credentials)", async () => {
    const run = vi.fn(async (): Promise<NightlyConnectionResult[]> => [
      {
        connectionId: "1",
        connectionLabel: "Branch North",
        timeBudgetMs: 125_000,
        outcome: {
          status: "succeeded",
          runId: "7",
          counts: { pages: 1, invoicesSeen: 3, inserted: 1, updated: 0, unchanged: 2, lineItemsRead: 1, lineItemsFailed: 0, lineItemGaps: 0, lineItemsSwept: 0, lineItemsUnreadable: 0, requests: 0 },
          warnings: [],
        },
      },
      { connectionId: "2", connectionLabel: "Branch South", timeBudgetMs: 125_000, outcome: { status: "busy", heldFor: "sync", until: new Date("2026-10-01T03:00:00Z") } },
    ]);
    const response = await handleNightlyCron(request(`Bearer ${SECRET}`), { secret: SECRET, run });
    expect(response.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
    expect(await response.json()).toEqual({
      ok: true,
      connections: [
        {
          connectionId: "1",
          connectionLabel: "Branch North",
          timeBudgetMs: 125_000,
          status: "succeeded",
          runId: "7",
          counts: { pages: 1, invoicesSeen: 3, inserted: 1, updated: 0, unchanged: 2, lineItemsRead: 1, lineItemsFailed: 0, lineItemGaps: 0, lineItemsSwept: 0, lineItemsUnreadable: 0, requests: 0 },
          error: null,
        },
        { connectionId: "2", connectionLabel: "Branch South", timeBudgetMs: 125_000, status: "busy" },
      ],
    });
  });

  it("is reachable without a session (the proxy lets it through) — exactly that path, nothing under or beside it", () => {
    expect(PUBLIC_EXACT_PATHS).toContain("/api/cron/nightly");
    expect(isPublicPath("/api/cron/nightly")).toBe(true);
    for (const gated of ["/api/cron", "/api/cron/nightly/x", "/api/cron/backfill/x", "/api/cron/other", "/api/me"]) expect(isPublicPath(gated), gated).toBe(false);
  });
});

describe("history backfill endpoint (/api/cron/backfill, #8)", () => {
  afterEach(() => vi.restoreAllMocks());
  const backfillRequest = (authorization?: string) =>
    new Request("http://localhost/api/cron/backfill", { headers: authorization === undefined ? {} : { Authorization: authorization } });
  const WINDOW = { start: new Date("2026-10-01T16:00:00Z"), end: new Date("2026-10-01T22:00:00Z"), nextStart: new Date("2026-10-01T16:00:00Z") };

  it("answers 401 and runs nothing without the right secret (the same CRON_SECRET, failing closed)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const run = vi.fn(async (): Promise<BackfillOutcome> => ({ window: { ...WINDOW, inWindow: true }, connections: [] }));
    for (const [secret, header] of [
      [undefined, undefined],
      [undefined, "Bearer undefined"],
      ["", "Bearer "],
      [SECRET, undefined],
      [SECRET, "Bearer wrong-secret-0123456789"],
      [SECRET, `bearer ${SECRET}`],
    ] as const) {
      const response = await handleBackfillCron(backfillRequest(header), { secret, run });
      expect(response.status, `${secret} / ${header}`).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("runs one chunk with the right secret and reports each connection by status and counts only", async () => {
    const run = vi.fn(async (): Promise<BackfillOutcome> => ({
      window: { ...WINDOW, inWindow: true },
      connections: [
        {
          connectionId: "1",
          connectionLabel: "Branch North",
          result: {
            status: "ran",
            runs: [
              {
                month: "2026-10",
                runId: "9",
                status: "succeeded",
                counts: { pages: 1, invoicesSeen: 0, inserted: 0, updated: 0, unchanged: 0, lineItemsRead: 0, lineItemsFailed: 0, lineItemGaps: 0, lineItemsSwept: 0, lineItemsUnreadable: 0, requests: 6 },
              },
            ],
            requests: 6,
            monthsCompleted: 1,
            stoppedBy: "time_limit",
          },
        },
        { connectionId: "2", connectionLabel: "Branch South", result: { status: "idle", reason: "budget_spent" } },
      ],
    }));
    const response = await handleBackfillCron(backfillRequest(`Bearer ${SECRET}`), { secret: SECRET, run });
    expect(response.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ok: true,
      inWindow: true,
      window: { start: "2026-10-01T16:00:00.000Z", end: "2026-10-01T22:00:00.000Z", nextStart: "2026-10-01T16:00:00.000Z" },
      connections: [
        {
          connectionId: "1",
          connectionLabel: "Branch North",
          status: "ran",
          stoppedBy: "time_limit",
          requests: 6,
          monthsCompleted: 1,
          months: [{ month: "2026-10", runId: "9", status: "succeeded" }],
          error: null,
        },
        { connectionId: "2", connectionLabel: "Branch South", status: "idle", reason: "budget_spent" },
      ],
    });
  });

  it("is reachable without a session — exactly that path — and the route has no sub-routes", () => {
    expect(PUBLIC_EXACT_PATHS).toContain("/api/cron/backfill");
    expect(isPublicPath("/api/cron/backfill")).toBe(true);
    const route = fileURLToPath(new URL("../app/api/cron/backfill", import.meta.url));
    expect(readdirSync(route, { withFileTypes: true }).filter((entry) => entry.isDirectory())).toEqual([]);
  });
});
