import { afterEach, describe, expect, it, vi } from "vitest";

import { PUBLIC_EXACT_PATHS, isPublicPath } from "@/auth/paths";

import { handleNightlyCron, isAuthorizedCronRequest, MIN_CRON_SECRET_LENGTH } from "./cron";
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
          counts: { pages: 1, invoicesSeen: 3, inserted: 1, updated: 0, unchanged: 2, lineItemsRead: 1, lineItemsFailed: 0, lineItemGaps: 0, lineItemsSwept: 0 },
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
          counts: { pages: 1, invoicesSeen: 3, inserted: 1, updated: 0, unchanged: 2, lineItemsRead: 1, lineItemsFailed: 0, lineItemGaps: 0, lineItemsSwept: 0 },
          error: null,
        },
        { connectionId: "2", connectionLabel: "Branch South", timeBudgetMs: 125_000, status: "busy" },
      ],
    });
  });

  it("is reachable without a session (the proxy lets it through) — exactly that path, nothing under or beside it", () => {
    expect(PUBLIC_EXACT_PATHS).toContain("/api/cron/nightly");
    expect(isPublicPath("/api/cron/nightly")).toBe(true);
    for (const gated of ["/api/cron", "/api/cron/backfill", "/api/cron/nightly/x", "/api/me"]) expect(isPublicPath(gated), gated).toBe(false);
  });
});
