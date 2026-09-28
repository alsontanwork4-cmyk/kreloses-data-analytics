import { createHash, timingSafeEqual } from "node:crypto";

import type { NightlyConnectionResult } from "./nightly";

/**
 * The nightly cron endpoint's own authentication (`GET /api/cron/nightly` is in `PUBLIC_PATHS`, so
 * the proxy does not check a session there). Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`
 * when the project has a `CRON_SECRET` environment variable.
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
export async function handleNightlyCron(
  request: Request,
  deps: { secret: string | undefined; run: () => Promise<NightlyConnectionResult[]> },
): Promise<Response> {
  const noStore = { "Cache-Control": "no-store" };
  if (!deps.secret || deps.secret.length < MIN_CRON_SECRET_LENGTH) {
    console.error(`[cron] CRON_SECRET is not set (or shorter than ${MIN_CRON_SECRET_LENGTH} characters): refusing the nightly sync request`);
  }
  if (!isAuthorizedCronRequest(request.headers.get("authorization"), deps.secret)) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: noStore });
  }
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
