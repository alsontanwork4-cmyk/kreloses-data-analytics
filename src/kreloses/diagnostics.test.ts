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
    expect(report).toContain("Customers: {<30 keys>: {Visits: number}}");
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
            NestedStaff: { Ong: { Tan: 5 } },
          })
        : undefined,
    );
    const report = formatLoginDiagnostic(await runLoginDiagnostic(both, { reader: { requestDelayMs: 0, transport: fake.transport } }));
    expect(report).toContain("Staff: {<1 key>: number}");
    expect(report).toContain("Doctors: {<2 keys>: {Visits: number, Active: boolean}}");
    expect(report).toContain("NestedStaff: {<1 key>: {<1 key>: number}}");
    for (const name of ["Ong", "Tan", "Lim"]) expect(report).not.toContain(name);
  });

  it("still collapses a dictionary when some of its values are null", async () => {
    const fake = createFakeKreloses();
    fake.intercept((request) =>
      request.url.pathname === "/Report/GetFilter"
        ? Response.json({
            Filters: [{ Name: "Location", Options: [{ Value: "1101", Text: "Branch North" }] }],
            Staff: { Ong: 1, Tan: null },
            LeadStaff: { Lim: null, Wong: { Visits: 2, Active: true } },
            AbsentStaff: { Chua: null },
          })
        : undefined,
    );
    const report = formatLoginDiagnostic(await runLoginDiagnostic(both, { reader: { requestDelayMs: 0, transport: fake.transport } }));
    expect(report).toContain("Staff: {<2 keys>: number}");
    expect(report).toContain("LeadStaff: {<2 keys>: {Visits: number, Active: boolean}}");
    expect(report).toContain("AbsentStaff: {<1 key>: null}");
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
      // The hint says what that shift looks like: clinic hours (09-21 KL) read 8 hours late, at 17-05.
      expect(report).toContain(
        "(clinic hours are about 09-21; most sales at 17-05 instead would mean SaleDate holds KL wall-clock time labelled as UTC, read 8 hours late)",
      );
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

  describe("Sale Overview pages and staff list (structure only, #5)", () => {
    const SEPTEMBER = { from: "2026-09-01", to: "2026-09-30" };
    // Anything that identifies a sale, a line, a person or an amount. The pages opened: 700105 (the
    // first active sale), 700104 (the first with a discount), 700202 (the first with a refund).
    const DATA = [
      "700105",
      "700104",
      "700202",
      "7001051",
      "INV-N-0105",
      "INV-N-0104",
      "INV-S-0202",
      "Synthetic partial refund",
      "100.00",
      "1,100.00",
      "Nail clipping",
      "Ear cleaner",
      "Charlie",
      "Customer 0002",
      "000-000",
      "45.00",
      "54.90",
      "99.90",
      "Dr Alpha",
      "Dr Bravo",
      "Branch North General",
      "Hospitalisation",
      "Dental scaling",
      "10% DISCOUNT",
      "RM60 VOUCHER",
      "1,050.00",
      "2,300.00",
    ];
    const report = async (fake = createFakeKreloses()) =>
      formatLoginDiagnostic(await runLoginDiagnostic(both, { reader: { requestDelayMs: 0, transport: fake.transport }, saleListRange: SEPTEMBER }));

    it("opens three sales' pages (first active, first discounted, first refunded) and prints their structure as counts — never names, amounts or ids", async () => {
      const text = await report();
      expect(text).toMatch(/7\. GET sea\.kreloses\.com\/Sale\/Overview\/<number> -> 200/);
      expect(text).toMatch(/9\. GET sea\.kreloses\.com\/Sale\/Overview\/<number> -> 200/);
      expect(text).toContain("Staff filter (report 14): 5 staff members (names not shown)");
      expect(text).toContain("Sale Overview pages (GET /Sale/Overview/<sale>, structure only):");
      expect(text).toContain("  Pages opened: 3 (first active sale, first sale with a discount, first sale with a refund or a negative net)");
      expect(text).toContain("  var model found: 3 of 3 pages");
      expect(text).toContain(
        "  Model shape (first page): {Sale: {SaleId: number, SaleName: string, SaleDate: string, LocationId: number, Location: string, SaleStatusName: string, InvoiceCategory: string, Notes: null}, " +
          "Customer: {CustomerId: number, Name: string, Phone: string, Email: null}, " +
          "Items: [{SaleItemId: number, Name: string, Quantity: string, UnitPrice: string, Amount: string, StaffName: string, ItemType: number, DiscountName: null, DiscountAmount: string}] (2), " +
          "Totals: {GrossAmount: string, Discounts: string, NetAmount: string, TaxAmount: string, Total: string, TotalPayments: string, TotalRefunds: string, Balance: string}, " +
          "Transactions: [], RefundInfo: null, CreditNoteInfo: null}",
      );
      expect(text).toContain("  Same top-level model keys on every page: yes");
      expect(text).toContain("  Line items: 9 on 3 pages");
      expect(text).toContain("  Expected item fields present: Name, Quantity, UnitPrice, Amount, StaffName, ItemType, DiscountName, DiscountAmount");
      expect(text).toContain("  Expected item fields missing: none");
      expect(text).toContain("  Other item fields: SaleItemId");
      expect(text).toContain("  ItemType values (count of lines): 4 × 5, 1 × 3, 55 × 1");
      expect(text).toContain(
        "  Numbers: strings, empty; thousand separators: yes; negatives in parentheses: yes; minus signs: no; currency prefix: no; fractional quantities: yes",
      );
      expect(text).toContain("  StaffName: on 6 of 9 lines (names not shown)");
      expect(text).toContain("  Item-level discounts (DiscountAmount not zero): 2 of 9 lines");
      expect(text).toContain("  Sold lines with Amount = Quantity × UnitPrice − DiscountAmount: 8 of 8");
      expect(text).toContain("  Discount lines (ItemType 55) Amount sign: negative 1, positive 0, zero 0, unreadable 0");
      expect(text).toContain("  Pages whose line Amounts add up to Totals.NetAmount: 3 of 3");
      expect(text).toContain("  Pages whose line Amounts add up to the Sale List's NetAmount: 3 of 3");
      expect(text).toContain("  Pages whose Totals.NetAmount equals the Sale List's NetAmount: 3 of 3");
      expect(text).toContain("  Pages whose Sale.SaleId is the sale asked for: 3 of 3");
      expect(text).toContain("  RefundInfo: on 1 of 3 pages; shape {RefundId: number, Amount: string, Reason: string, RefundDate: string}");
      expect(text).toContain("  CreditNoteInfo: on 0 of 3 pages");
      expect(text).toContain("  Reader parse: OK on 3 of 3 pages");
      for (const secret of [...DATA, ...SECRETS]) expect(text, secret).not.toContain(secret);
    });

    it("counts pages whose lines do not add up (the gap monitor) and totals that differ from the Sale List", async () => {
      const fake = createFakeKreloses();
      const refunded = fake.saleOverviews["700202"] as { Items: Record<string, unknown>[] };
      refunded.Items.push({ ...refunded.Items[1]!, Quantity: "1", UnitPrice: "50.00", Amount: "50.00" });
      (fake.saleOverviews["700105"] as { Totals: Record<string, string> }).Totals.NetAmount = "90.00";
      const text = await report(fake);
      expect(text).toContain("  Pages whose line Amounts add up to Totals.NetAmount: 1 of 3");
      expect(text).toContain("  Pages whose line Amounts add up to the Sale List's NetAmount: 2 of 3");
      expect(text).toContain("  Pages whose Totals.NetAmount equals the Sale List's NetAmount: 2 of 3");
      for (const secret of [...DATA, ...SECRETS, "90.00", "50.00"]) expect(text, secret).not.toContain(secret);
    });

    it("never prints a sale id, even when a page is missing or sent elsewhere", async () => {
      const fake = createFakeKreloses();
      fake.intercept((request) => {
        if (request.url.pathname === "/Sale/Overview/700105") return new Response("not here 700105", { status: 404, headers: { "Content-Type": "text/html" } });
        if (request.url.pathname === "/Sale/Overview/700104") return new Response(null, { status: 302, headers: { Location: "/Sale/Detail/700104" } });
        return undefined;
      });
      const text = await report(fake);
      expect(text).toContain(
        '  Page "first active sale": FAILED — PageMissing — GET sea.kreloses.com/Sale/Overview/<sale> returned HTTP 404',
      );
      expect(text).toContain(
        '  Page "first sale with a discount": FAILED — PageMissing — GET sea.kreloses.com/Sale/Overview/<sale> redirected to sea.kreloses.com/Sale/Detail/<sale> instead of answering',
      );
      expect(text).toContain("  var model found: 1 of 1 page");
      expect(text).toContain("  Reader parse: OK on 1 of 1 page");
      for (const secret of [...DATA, ...SECRETS]) expect(text, secret).not.toContain(secret);
    });

    it("says so when a page has no model or the Reader cannot parse it, still without values", async () => {
      const fake = createFakeKreloses();
      fake.intercept((request) =>
        request.url.pathname === "/Sale/Overview/700105"
          ? new Response(readFixture("sale-overview-no-model.html"), { headers: { "Content-Type": "text/html" } })
          : request.url.pathname === "/Sale/Overview/700104"
            ? new Response(readFixture("sale-overview-changed.html").replace("700101", "700104"), { headers: { "Content-Type": "text/html" } })
            : undefined,
      );
      const text = await report(fake);
      expect(text).toContain("  var model found: 2 of 3 pages");
      expect(text).toContain(
        '  Reader parse: OK on 1 of 3 pages; page "first active sale": FAILED — LayoutChanged — Sale/Overview: no `var model = {…}` in the page; ' +
          'page "first sale with a discount": FAILED — LayoutChanged — Sale/Overview: no Items list in the page model',
      );
      for (const secret of [...DATA, "Consultation", "150.00"]) expect(text, secret).not.toContain(secret);
    });
  });
});
