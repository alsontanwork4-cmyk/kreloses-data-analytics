import { describe, expect, it } from "vitest";

import { formatLoginDiagnostic, runLoginDiagnostic } from "./diagnostics";
import { SYNTHETIC_ACCOUNTS, createFakeKreloses, readFixture } from "./testing/fake-kreloses";

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

  it("never prints dictionary keys (names) from the GetFilter JSON shape", async () => {
    const fake = createFakeKreloses();
    fake.intercept((request) =>
      request.url.pathname === "/Report/GetFilter"
        ? Response.json({
            Filters: [{ Name: "Location", Options: [{ Value: "1101", Text: "Branch North" }] }],
            Totals: { "Dr Real Person": 5, "Nurse Someone Else": 2, "owner@clinic.example": 1 },
            // Many plain keys: collapsed too, in case they are names or ids.
            Customers: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`Customer${i}`, { Visits: i }])),
          })
        : undefined,
    );
    const report = formatLoginDiagnostic(await runLoginDiagnostic(both, { reader: { requestDelayMs: 0, transport: fake.transport } }));
    expect(report).toContain("Visible locations: 1");
    expect(report).toContain("Totals: {<3 keys>: number}");
    // A single-key object could be `{"Ong": 1}` as easily as `{"Visits": 1}`, so it is collapsed too.
    expect(report).toContain("Customers: {<30 keys>: {<1 key>: number}}");
    for (const secret of ["Dr Real Person", "Nurse Someone", "owner@clinic.example", "Customer0", "Customer29"]) {
      expect(report).not.toContain(secret);
    }
  });

  it("collapses objects whose values all share one shape, even when their keys look like identifiers", async () => {
    const fake = createFakeKreloses();
    fake.intercept((request) =>
      request.url.pathname === "/Report/GetFilter"
        ? Response.json({
            Filters: [{ Name: "Location", Options: [{ Value: "1101", Text: "Branch North" }] }],
            // Single-word names used as dictionary keys look exactly like schema keys.
            Staff: { Ong: 1 },
            Doctors: { Tan: { Visits: 3, Active: true }, Lim: { Visits: 1, Active: false } },
            Nested: { Ong: { Tan: 5 } },
          })
        : undefined,
    );
    const report = formatLoginDiagnostic(await runLoginDiagnostic(both, { reader: { requestDelayMs: 0, transport: fake.transport } }));
    expect(report).toContain("Staff: {<1 key>: number}");
    expect(report).toContain("Doctors: {<2 keys>: {Visits: number, Active: boolean}}");
    expect(report).toContain("Nested: {<1 key>: {<1 key>: number}}");
    for (const name of ["Ong", "Tan", "Lim"]) expect(report).not.toContain(name);
  });

  it("still collapses a dictionary when some of its values are null", async () => {
    const fake = createFakeKreloses();
    fake.intercept((request) =>
      request.url.pathname === "/Report/GetFilter"
        ? Response.json({
            Filters: [{ Name: "Location", Options: [{ Value: "1101", Text: "Branch North" }] }],
            Staff: { Ong: 1, Tan: null },
            Leads: { Lim: null, Wong: { Visits: 2, Active: true } },
            Absent: { Chua: null },
          })
        : undefined,
    );
    const report = formatLoginDiagnostic(await runLoginDiagnostic(both, { reader: { requestDelayMs: 0, transport: fake.transport } }));
    expect(report).toContain("Staff: {<2 keys>: number}");
    expect(report).toContain("Leads: {<2 keys>: {Visits: number, Active: boolean}}");
    expect(report).toContain("Absent: {<1 key>: null}");
    for (const name of ["Ong", "Tan", "Lim", "Wong", "Chua"]) expect(report).not.toContain(name);
  });

  it("does not leak names through the shape when GetFilter's layout changed", async () => {
    const fake = createFakeKreloses();
    fake.intercept((request) =>
      request.url.pathname === "/Report/GetFilter"
        ? Response.json({ Filters: [{ Name: "Location", Options: { "Happy Paws Clinic North": 1101 } }] })
        : undefined,
    );
    const diagnostic = await runLoginDiagnostic(both, { reader: { requestDelayMs: 0, transport: fake.transport } });
    const report = formatLoginDiagnostic(diagnostic);
    expect(report).toContain("Visible locations: FAILED — LayoutChanged");
    expect(report).toContain("Options: {<1 key>: number}");
    expect(report).not.toContain("Happy Paws");
  });

  it("keeps Kreloses's own login error text out of the report", async () => {
    const fake = createFakeKreloses();
    fake.intercept((request) =>
      request.method === "POST" && request.url.pathname === "/account/login"
        ? new Response(
            readFixture("login-failed.html").replace(
              "<h2>Log in</h2>",
              '<h2>Log in</h2><div class="alert alert-danger">Hello Dr Real Person, your account is locked.</div>',
            ),
            { status: 200, headers: { "Content-Type": "text/html" } },
          )
        : undefined,
    );
    const report = formatLoginDiagnostic(
      await runLoginDiagnostic({ email: both.email, password: "wrong" }, { reader: { requestDelayMs: 0, transport: fake.transport } }),
    );
    expect(report).toContain("Login: FAILED — AuthFailed (bad_credentials)");
    expect(report).not.toContain("Invalid login attempt");
    expect(report).not.toContain("Real Person");
    expect(report).not.toContain("wrong");
  });

  it("masks URL path segments that are not common route words (e.g. a clinic's own slug)", async () => {
    const fake = createFakeKreloses();
    fake.intercept((request) =>
      request.method === "POST" && request.url.pathname === "/account/login"
        ? new Response(null, { status: 302, headers: { Location: "https://sea.kreloses.com/happy-paws-kl/Home/Index/12345" } })
        : undefined,
    );
    const report = formatLoginDiagnostic(await runLoginDiagnostic(both, { reader: { requestDelayMs: 0, transport: fake.transport } }));
    expect(report).toContain("2. POST www.kreloses.com/account/login -> 302 -> sea.kreloses.com/<segment>/Home/Index/<number>");
    expect(report).not.toContain("happy-paws");
    expect(report).not.toContain("12345");
  });

  it("flags OWIN's X-Responded-JSON answer on a hop", async () => {
    const fake = createFakeKreloses();
    let slept = 0;
    const diagnostic = await runLoginDiagnostic(both, {
      reader: { requestDelayMs: 0, transport: fake.transport },
      probeMinutes: 5,
      probeIntervalMinutes: 5,
      sleep: async () => {
        slept += 1;
        fake.expireSessions();
      },
    });
    expect(slept).toBe(1);
    const report = formatLoginDiagnostic(diagnostic);
    expect(report).toMatch(/POST sea\.kreloses\.com\/Report\/GetFilter -> 200 .*\[X-Responded-JSON status 401\]/);
    expect(report).toContain("Session probe: FAILED after 5 min — AuthFailed (session_expired)");
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

  describe("Sale List page (structure only)", () => {
    const SEPTEMBER = { from: "2026-09-01", to: "2026-09-30" };
    // Anything that identifies a sale, a customer, a branch or an amount.
    const DATA = [
      "Customer 0001",
      "Customer 0005",
      "Branch North",
      "Branch South",
      "INV-N-0101",
      "700101",
      "90001",
      "1101",
      "1,250.00",
      "1,200.00",
      "380.50",
      "(120.00)",
      "1788193800000",
    ];

    it("reads one page and prints fields, counts, formats and statuses — never names, amounts or ids", async () => {
      const fake = createFakeKreloses();
      const diagnostic = await runLoginDiagnostic(both, {
        reader: { requestDelayMs: 0, transport: fake.transport },
        saleListRange: SEPTEMBER,
      });
      const report = formatLoginDiagnostic(diagnostic);

      expect(report).toContain("6. POST sea.kreloses.com/Sale/Get -> 200");
      expect(report).toContain("Sale List (POST /Sale/Get, one page of 2026-09-01..2026-09-30, all statuses):");
      expect(report).toContain("  TotalCount: 11; rows on the page: 11");
      expect(report).toContain(
        "  Expected fields present: SaleId, SaleName, Location, LocationId, CustomerId, CustomerName, SaleDate, SaleStatusName, GrossAmount, Discounts, NetAmount, TaxAmount, Total, PaymentStatusName, TotalPayments, TotalRefunds",
      );
      expect(report).toContain("  Expected fields missing: none");
      expect(report).toContain("  Other fields: none");
      expect(report).toContain("  SaleDate formats: /Date(9999999999999)/");
      expect(report).toContain(
        "  Amounts: strings; thousand separators: yes; negatives in parentheses: yes; minus signs: no; currency prefix: no",
      );
      expect(report).toContain("  Sale statuses seen: Active, Cancelled (cancelled sales present: yes)");
      expect(report).toContain("  Payment statuses seen: Paid, Partially paid, Refunded, Unpaid");
      expect(report).toContain("  Filter template: Sale status options Active, Cancelled (selected via option flag Selected); Date filter From/To like 99/99/9999");
      expect(report).toContain("  Reader parse: OK (11 invoices)");
      // Checks of the Reader's own assumptions, as counts only.
      expect(report).toContain(
        "  Sale times by KL hour (as the Reader reads SaleDate): 00-03 1, 03-06 0, 06-09 0, 09-12 4, 12-15 3, 15-18 2, 18-21 0, 21-24 1; unreadable 0",
      );
      expect(report).toContain("  Rows newest first: yes");
      expect(report).toContain("  Rows outside 2026-09-01..2026-09-30: 0");
      for (const secret of [...DATA, ...SECRETS]) expect(report, secret).not.toContain(secret);
    });

    it("shows when the listing is not newest first or ignores the date range", async () => {
      const fake = createFakeKreloses({ saleList: { ignoreDateFilter: true, oldestFirst: true } });
      const diagnostic = await runLoginDiagnostic(both, { reader: { requestDelayMs: 0, transport: fake.transport }, saleListRange: SEPTEMBER });
      const report = formatLoginDiagnostic(diagnostic);
      expect(report).toContain("  TotalCount: 20; rows on the page: 20");
      expect(report).toContain("  Rows newest first: no");
      expect(report).toContain("  Rows outside 2026-09-01..2026-09-30: 9");
      expect(report).toContain(
        "  Sale times by KL hour (as the Reader reads SaleDate): 00-03 2, 03-06 0, 06-09 0, 09-12 7, 12-15 5, 15-18 3, 18-21 1, 21-24 2; unreadable 0",
      );
    });

    it("would expose SaleDate holding KL wall-clock time labelled as UTC (sales at night)", async () => {
      const fake = createFakeKreloses();
      // Every sale's /Date(ms)/ shifted by +8 h, as if KL wall-clock time had been sent as UTC.
      for (const row of fake.saleRows) {
        const ms = Number(/\d+/.exec(String(row.SaleDate))![0]);
        row.SaleDate = `/Date(${ms + 8 * 3_600_000})/`;
      }
      const report = formatLoginDiagnostic(
        await runLoginDiagnostic(both, { reader: { requestDelayMs: 0, transport: fake.transport }, saleListRange: SEPTEMBER }),
      );
      expect(report).toMatch(/Sale times by KL hour \(as the Reader reads SaleDate\): 00-03 [1-9]\d*, 03-06 \d+, 06-09 [1-9]/);
    });

    it("reports a Sale List the Reader cannot parse, still without values", async () => {
      const fake = createFakeKreloses();
      fake.intercept((request) =>
        request.url.pathname === "/Sale/Get"
          ? Response.json({
              Results: [{ SaleId: 700101, Customer: "Customer 0001", SaleDate: "2026-09-01 00:30", Net: "1,200.00", Stamp: "Customer 0001 paid" }],
              TotalCount: 1,
            })
          : undefined,
      );
      const diagnostic = await runLoginDiagnostic(both, { reader: { requestDelayMs: 0, transport: fake.transport }, saleListRange: SEPTEMBER });
      const report = formatLoginDiagnostic(diagnostic);
      expect(report).toContain("  Expected fields missing: SaleName, Location, LocationId");
      expect(report).toContain("  Other fields: Customer, Net, Stamp");
      expect(report).toContain("  SaleDate formats: 9999-99-99 99:99");
      expect(report).toMatch(/ {2}Reader parse: FAILED — LayoutChanged — Sale\/Get row 1: no SaleName/);
      for (const secret of [...DATA, "paid"]) expect(report, secret).not.toContain(secret);
    });

    it("says so when the Sale List request itself fails", async () => {
      const fake = createFakeKreloses();
      fake.intercept((request) => (request.url.pathname === "/Sale/Get" ? new Response("Not found", { status: 404 }) : undefined));
      const report = formatLoginDiagnostic(
        await runLoginDiagnostic(both, { reader: { requestDelayMs: 0, transport: fake.transport }, saleListRange: SEPTEMBER }),
      );
      expect(report).toMatch(/Sale List: FAILED — LayoutChanged — POST sea\.kreloses\.com\/Sale\/Get returned HTTP 404/);
    });
  });
});
