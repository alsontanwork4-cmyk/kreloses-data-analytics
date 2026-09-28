import { describe, expect, it } from "vitest";

import { formatLoginDiagnostic, runLoginDiagnostic } from "./diagnostics";

/**
 * OPT-IN live smoke test against the REAL Kreloses (`npm run test:live`). Skipped unless
 * KRELOSES_TEST_EMAIL and KRELOSES_TEST_PASSWORD are set; never part of `npm test`.
 *
 * It logs in once, lists the locations the login can see, and prints a redacted diagnostic of the
 * login flow (hop status codes and hosts, cookie names/scopes/lifetimes, one-time-code step,
 * which host the session works on, the number of locations) that is safe to paste into the public
 * ticket. Optionally, KRELOSES_TEST_SESSION_PROBE_MINUTES=<n> re-checks the session every 5
 * minutes for n minutes (one tiny request each time) to measure how long a session lasts.
 */
const email = process.env.KRELOSES_TEST_EMAIL?.trim();
const password = process.env.KRELOSES_TEST_PASSWORD;
const probeMinutes = Math.max(0, Number(process.env.KRELOSES_TEST_SESSION_PROBE_MINUTES) || 0);

describe.skipIf(!email || !password)("live Kreloses login (opt-in)", () => {
  it(
    "logs in to the real Kreloses, lists the visible locations, and prints a redacted diagnostic",
    async () => {
      const diagnostic = await runLoginDiagnostic({ email: email!, password: password! }, { probeMinutes });
      console.log(`\n${formatLoginDiagnostic(diagnostic)}\n`);

      expect(diagnostic.login.ok, "login should succeed (see the diagnostic above)").toBe(true);
      expect(diagnostic.sessionWorksOn).toBe("sea.kreloses.com");
      expect(diagnostic.locations).toMatchObject({ ok: true });
    },
    (probeMinutes + 3) * 60_000,
  );
});
