import { describe, expect, it } from "vitest";

import { endOfMonth, isIsoDate } from "../filters/dates";

import { formatLoginDiagnostic, runLoginDiagnostic } from "./diagnostics";

/**
 * OPT-IN live smoke test against the REAL Kreloses (`npm run test:live`). Skipped unless
 * KRELOSES_TEST_EMAIL and KRELOSES_TEST_PASSWORD are set; never part of `npm test`.
 *
 * It logs in once, lists the locations the login can see, reads ONE page of the Sale List
 * (previous month up to today, all statuses) and ONE invoice's Sale Overview page (its line
 * items), counts the staff in the Sale List filter, and prints a redacted diagnostic that is safe to
 * paste into the public ticket: the login flow (hop status codes and hosts, cookie
 * names/scopes/lifetimes, one-time-code step, which host the session works on, the number of
 * locations) and the Sale List's structure (field names, TotalCount, the SaleDate pattern, how
 * amounts are formatted, the status labels, whether the Reader parses it) — never names, amounts
 * or ids. Optionally, KRELOSES_TEST_SESSION_PROBE_MINUTES=<n> re-checks the session every 5
 * minutes for n minutes (one tiny request each time) to measure how long a session lasts.
 */
const email = process.env.KRELOSES_TEST_EMAIL?.trim();
const password = process.env.KRELOSES_TEST_PASSWORD;
const probeMinutes = Math.max(0, Number(process.env.KRELOSES_TEST_SESSION_PROBE_MINUTES) || 0);
// Optional: KRELOSES_TEST_MONTH=2024-03 reads that month's Sale List page (and its invoice pages)
// instead of the previous month — e.g. to check old invoice pages before enabling the backfill (#8).
const month = /^\d{4}-\d{2}$/.test(process.env.KRELOSES_TEST_MONTH ?? "") && isIsoDate(`${process.env.KRELOSES_TEST_MONTH}-01`) ? process.env.KRELOSES_TEST_MONTH! : null;
const saleListRange = month ? { from: `${month}-01`, to: endOfMonth(`${month}-01`) } : undefined;

describe.skipIf(!email || !password)("live Kreloses login (opt-in)", () => {
  it(
    "logs in to the real Kreloses, lists the visible locations, reads one Sale List page and one invoice page, and prints a redacted diagnostic",
    async () => {
      const diagnostic = await runLoginDiagnostic({ email: email!, password: password! }, { probeMinutes, ...(saleListRange ? { saleListRange } : {}) });
      console.log(`\n${formatLoginDiagnostic(diagnostic)}\n`);

      expect(diagnostic.login.ok, "login should succeed (see the diagnostic above)").toBe(true);
      expect(diagnostic.sessionWorksOn).toBe("sea.kreloses.com");
      expect(diagnostic.locations).toMatchObject({ ok: true });
      expect(diagnostic.saleList?.page?.parse, "the Reader should parse the Sale List (see above)").toMatch(/^OK/);
      expect(diagnostic.staff, "the Sale List filter should have a Staff filter (see above)").toMatchObject({ ok: true });
      expect(diagnostic.saleOverview?.structure?.parseFailures, "the Reader should parse the invoice pages (see above)").toEqual([]);
    },
    (probeMinutes + 3) * 60_000,
  );
});
