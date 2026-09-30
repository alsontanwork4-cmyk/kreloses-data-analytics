import { createHash, timingSafeEqual } from "node:crypto";

import type { BackfillOutcome } from "./backfill";
import type { NightlyConnectionResult } from "./nightly";

/**
 * The cron endpoints' own authentication (`GET /api/cron/nightly` and `GET /api/cron/backfill` are
 * in `PUBLIC_EXACT_PATHS`, so the proxy does not check a session there). Vercel Cron sends
 * `Authorization: Bearer <CRON_SECRET>` when the project has a `CRON_SECRET` environment variable;
 * the backfill workflow (GitHub Actions) sends the same header.
 *
 * Fail closed: with no `CRON_SECRET` (or one shorter than `MIN_CRON_SECRET_LENGTH`) EVERY request
 * is refused. The comparison is constant-time (SHA-256 of both sides, then `timingSafeEqual`, so
 * not even the length leaks).
 */
export const MIN_CRON_SECRET_LENGTH = 16;

export function isAuthorizedCronRequest(authorization: string | null | undefined, secret: string | undefined): boolean {
  if (!secret || secret.length < MIN_CRON_SECRET_LENGTH) return false;
  if (!authorization) return false;
  const given = createHash("sha256").update(authorization, "utf8").digest();
  const expected = createHash("sha256").update(`Bearer ${secret}`, "utf8").digest();
  return timingSafeEqual(given, expected);
}

/**
 * Handles one cron request: 401 unless authorised, else runs the nightly sync and answers with
 * what happened per connection (labels, statuses and counts only — never credentials).
 */
const noStore = { "Cache-Control": "no-store" };

/** 401 (and a server log line when the secret itself is missing) unless the request carries the cron secret; null when it does. */
function refuseUnlessCron(request: Request, secret: string | undefined, what: string): Response | null {
  if (!secret || secret.length < MIN_CRON_SECRET_LENGTH) {
    console.error(`[cron] CRON_SECRET is not set (or shorter than ${MIN_CRON_SECRET_LENGTH} characters): refusing the ${what} request`);
  }
  if (!isAuthorizedCronRequest(request.headers.get("authorization"), secret)) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: noStore });
  }
  return null;
}

export async function handleNightlyCron(
  request: Request,
  deps: { secret: string | undefined; run: () => Promise<NightlyConnectionResult[]> },
): Promise<Response> {
  const refused = refuseUnlessCron(request, deps.secret, "nightly sync");
  if (refused) return refused;
  const results = await deps.run();
  return Response.json(
    {
      ok: true,
      connections: results.map(({ connectionId, connectionLabel, timeBudgetMs, outcome }) => ({
        connectionId,
        connectionLabel,
        timeBudgetMs,
        status: outcome.status,
        ...("runId" in outcome ? { runId: outcome.runId, counts: outcome.counts, error: outcome.error?.message ?? null } : {}),
        ...(outcome.status === "error" ? { error: outcome.message } : {}),
      })),
    },
    { headers: noStore },
  );
}

/**
 * The history backfill endpoint (`GET /api/cron/backfill`, #8), called every 15 minutes during the
 * night window by the GitHub Actions workflow `.github/workflows/backfill.yml` with the same
 * `Authorization: Bearer <CRON_SECRET>` as the nightly cron. 401 unless authorised; otherwise one
 * chunk per connection with an active backfill (`runBackfill`), answered with what happened per
 * connection — statuses and request/month counts only: no credentials, no amounts, no invoice ids.
 * Outside the night window (or with nothing to do) it answers at once.
 */
export async function handleBackfillCron(request: Request, deps: { secret: string | undefined; run: () => Promise<BackfillOutcome> }): Promise<Response> {
  const refused = refuseUnlessCron(request, deps.secret, "history backfill");
  if (refused) return refused;
  const { window, connections } = await deps.run();
  return Response.json(
    {
      ok: true,
      inWindow: window.inWindow,
      window: { start: window.start.toISOString(), end: window.end.toISOString(), nextStart: window.nextStart.toISOString() },
      connections: connections.map(({ connectionId, connectionLabel, result }) => ({
        connectionId,
        connectionLabel,
        status: result.status,
        ...(result.status === "idle"
          ? { reason: result.reason }
          : {
              stoppedBy: result.stoppedBy,
              requests: result.requests,
              monthsCompleted: result.monthsCompleted,
              months: result.runs.map((run) => ({ month: run.month, runId: run.runId, status: run.status })),
              error: result.error ?? null,
            }),
      })),
    },
    { headers: noStore },
  );
}
