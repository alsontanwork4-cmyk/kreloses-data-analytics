import { describe, expect, it } from "vitest";

import { formatLoginDiagnostic, runLoginDiagnostic } from "./diagnostics";
import { SYNTHETIC_ACCOUNTS, createFakeKreloses } from "./testing/fake-kreloses";

/**
 * The live smoke test prints this report so the owner can paste it into the ticket (a public
 * repo), so it must say what the login flow does without revealing anything secret or personal.
 */
const { both, oneTimeCode } = SYNTHETIC_ACCOUNTS;
const SECRETS = [
  both.password,
  both.email,
  "SYNTHETIC-AUTH-",
  "SYNTHETIC-COOKIE-TOKEN",
  "SYNTHETIC-FORM-TOKEN",
  "ReturnUrl",
  "Branch North",
  "Branch South",
];

describe("live login diagnostic (redacted)", () => {
  it("describes a successful login hop by hop, with cookie names and scopes but no values", async () => {
    const fake = createFakeKreloses();
    const diagnostic = await runLoginDiagnostic(both, { reader: { requestDelayMs: 0, transport: fake.transport } });
    const report = formatLoginDiagnostic(diagnostic);

    expect(diagnostic.login).toMatchObject({ ok: true });
    expect(diagnostic.oneTimeCodeStep).toBe(false);
    expect(diagnostic.sessionWorksOn).toBe("sea.kreloses.com");
    expect(diagnostic.locations).toEqual({ ok: true, count: 2 });

    expect(report).toContain("1. GET www.kreloses.com/account/login -> 200");
    expect(report).toContain("2. POST www.kreloses.com/account/login -> 302 -> sea.kreloses.com/");
    expect(report).toContain("3. GET sea.kreloses.com/ -> 302 -> sea.kreloses.com/Home/Index");
    expect(report).toContain("4. GET sea.kreloses.com/Home/Index -> 200");
    expect(report).toContain("5. POST sea.kreloses.com/Report/GetFilter -> 200");
    expect(report).toContain(
      "set .AspNet.ApplicationCookie (Domain=kreloses.com, Path=/, session cookie, Secure, HttpOnly, SameSite=lax)",
    );
    expect(report).toContain("set __RequestVerificationToken (host-only www.kreloses.com, Path=/, session cookie, HttpOnly)");
    expect(report).toContain("Login: OK");
    expect(report).toContain("One-time code / 2FA step detected: no");
    expect(report).toContain("Session works on: sea.kreloses.com");
    expect(report).toContain("Visible locations: 2");
    expect(report).toMatch(/GetFilter \(report 14\) JSON shape: \{ReportId: number, ReportName: string, Filters: \[/);
    for (const secret of SECRETS) expect(report).not.toContain(secret);
  });

  it("reports a one-time-code step and where the login stopped", async () => {
    const fake = createFakeKreloses();
    const diagnostic = await runLoginDiagnostic(oneTimeCode, { reader: { requestDelayMs: 0, transport: fake.transport } });
    const report = formatLoginDiagnostic(diagnostic);

    expect(diagnostic.oneTimeCodeStep).toBe(true);
    expect(diagnostic.sessionWorksOn).toBeNull();
    expect(report).toContain("Login: FAILED — AuthFailed (unexpected_step: one_time_code)");
    expect(report).toContain("One-time code / 2FA step detected: YES");
    expect(report).toContain("Visible locations: not checked (login failed)");
    for (const secret of [oneTimeCode.password, oneTimeCode.email, "SYNTHETIC-AUTH-", "Provider="]) {
      expect(report).not.toContain(secret);
    }
  });

  it("optionally probes how long the session stays valid", async () => {
    const fake = createFakeKreloses();
    let slept = 0;
    const diagnostic = await runLoginDiagnostic(both, {
      reader: { requestDelayMs: 0, transport: fake.transport },
      probeMinutes: 30,
      probeIntervalMinutes: 10,
      sleep: async () => {
        slept += 1;
        if (slept === 2) fake.expireSessions();
      },
    });
    expect(diagnostic.probes).toEqual([
      { afterMinutes: 10, ok: true },
      { afterMinutes: 20, ok: false, error: "AuthFailed (session_expired)" },
    ]);
    const report = formatLoginDiagnostic(diagnostic);
    expect(report).toContain("Session probe: still valid after 10 min");
    expect(report).toContain("Session probe: FAILED after 20 min — AuthFailed (session_expired)");
  });
});
