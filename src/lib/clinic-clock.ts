import "server-only";

import { isIsoDate } from "@/filters";

/** An instant with an explicit zone: `2026-09-28T02:00:00+08:00`, `2026-09-27T18:00:00Z`. */
const INSTANT = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * "Now", for server code that shows days relative to today at the clinic (the Daily page's
 * default "yesterday"). Outside production, the environment variable `CLINIC_NOW` (an ISO instant
 * WITH its zone, e.g. `2026-09-28T02:00:00+08:00`) freezes it, so the e2e suite does not depend on
 * the machine's clock or on a run crossing midnight in Kuala Lumpur. It is ignored when `NODE_ENV`
 * or `VERCEL_ENV` is `production`; an unreadable value throws (outside production) rather than
 * silently using the real clock.
 */
export function clinicNow(env: Readonly<Record<string, string | undefined>> = process.env): Date {
  const fixed = env.CLINIC_NOW;
  if (!fixed || env.NODE_ENV === "production" || env.VERCEL_ENV === "production") return new Date();
  const match = INSTANT.exec(fixed);
  const instant = new Date(fixed);
  if (!match || !isIsoDate(match[1]) || Number.isNaN(instant.getTime())) {
    throw new Error(`CLINIC_NOW must be an ISO instant with a time zone (e.g. 2026-09-28T02:00:00+08:00), not "${fixed}"`);
  }
  return instant;
}
