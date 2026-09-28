import { describe, expect, it } from "vitest";

import { AuthFailed, getInvoice, LayoutChanged, listLocations, listStaff, login, PageMissing, type KrelosesInvoiceDetail } from "./index";
import { extractPageModel } from "./sale-overview";
import { SYNTHETIC_ACCOUNTS, createFakeKreloses, readFixture, readSaleOverviewModels, type FakeKreloses } from "./testing/fake-kreloses";

/**
 * Seam 2: an invoice's line items (GET /Sale/Overview/{SaleId}: HTML embedding `var model = {…}`)
 * and the staff list (the Sale List filter's Staff options), read through the Reader from the fake
 * Kreloses serving the synthetic fixtures (`__fixtures__/sale-overviews.json`, `report-14-filter.json`).
 */
const fast = { requestDelayMs: 0 };
const { both } = SYNTHETIC_ACCOUNTS;

async function signedIn(fake: FakeKreloses = createFakeKreloses()) {
  const session = await login(both, { ...fast, transport: fake.transport });
  return { fake, session };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

/** Serves `html` for the overview of `saleId`. */
function answerOverview(fake: FakeKreloses, saleId: string, html: string) {
  fake.intercept((request) =>
    request.url.pathname === `/Sale/Overview/${saleId}` ? new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }) : undefined,
  );
}

/** The fixture page with a model of our own (as raw JS/JSON text). */
function pageWithModel(modelSource: string): string {
  return readFixture("sale-overview-page.html").replace("{{MODEL}}", modelSource);
}

/** A copy of a fixture model, changed by `change`, as JSON. */
type TestModel = { Items: Record<string, unknown>[]; Sale: Record<string, unknown>; Totals: Record<string, unknown> };
function changedModel(saleId: string, change: (model: TestModel) => void): string {
  const model = structuredClone(readSaleOverviewModels()[saleId]!) as TestModel;
  change(model);
  return JSON.stringify(model);
}

const NOTHING_PERSONAL = ["Customer 0001", "000-000", "Dr Alpha", "Consultation", "150.00", "1,200.00", "INV-N-0101"];

describe("Kreloses Reader: getInvoice", () => {
  it("reads an invoice's lines: single doctor, a discount line (ItemType 55) with negatives in parentheses", async () => {
    const { session } = await signedIn();
    const invoice = await getInvoice(session, "700101");
    expect(invoice.header).toEqual({
      saleId: "700101",
      grossSen: 125_000,
      discountsSen: 5_000,
      netSen: 120_000,
      taxSen: 0,
      totalSen: 120_000,
      totalPaymentsSen: 120_000,
      totalRefundsSen: 0,
    });
    expect(invoice.lines).toEqual([
      { lineNo: 1, name: "Consultation", itemType: 4, quantity: "1", unitPriceSen: 15_000, amountSen: 15_000, staffName: "Dr Alpha", discountName: null, discountAmountSen: 0 },
      { lineNo: 2, name: "Surgery - Spay", itemType: 4, quantity: "1", unitPriceSen: 90_000, amountSen: 90_000, staffName: "Dr Alpha", discountName: null, discountAmountSen: 0 },
      {
        lineNo: 3,
        name: 'Antibiotic tablets "Amoxi" {250mg}',
        itemType: 1,
        quantity: "10",
        unitPriceSen: 2_000,
        amountSen: 20_000,
        staffName: "Dr Alpha",
        discountName: null,
        discountAmountSen: 0,
      },
      { lineNo: 4, name: "RM50 LOYALTY", itemType: 55, quantity: "1", unitPriceSen: -5_000, amountSen: -5_000, staffName: null, discountName: "RM50 LOYALTY", discountAmountSen: 5_000 },
    ]);
    // What is kept of the page besides the lines: never the customer.
    expect(Object.keys(invoice.raw)).toEqual(["Sale", "Totals", "Transactions", "RefundInfo", "CreditNoteInfo"]);
    expect(JSON.stringify(invoice.raw)).not.toContain("Customer 0001");
  });

  it("reads thousand separators, fractional quantities, item-level discounts, no-staff lines and an empty discount line", async () => {
    const { session } = await signedIn();
    const invoice = await getInvoice(session, "700104");
    expect(invoice.header).toMatchObject({ grossSen: 248_000, discountsSen: 18_000, netSen: 230_000, taxSen: 13_800, totalSen: 243_800 });
    expect(invoice.lines).toEqual([
      { lineNo: 1, name: "Hospitalisation (per day)", itemType: 4, quantity: "3", unitPriceSen: 35_000, amountSen: 105_000, staffName: "Dr Bravo", discountName: null, discountAmountSen: 0 },
      { lineNo: 2, name: "Dental scaling", itemType: 4, quantity: "1", unitPriceSen: 120_000, amountSen: 108_000, staffName: "Dr Bravo", discountName: "10% DISCOUNT", discountAmountSen: 12_000 },
      { lineNo: 3, name: "Prescription diet 2kg", itemType: 1, quantity: "1", unitPriceSen: 18_000, amountSen: 18_000, staffName: null, discountName: null, discountAmountSen: 0 },
      // ItemType sent as a string "1"; quantity 0.5.
      { lineNo: 4, name: "IV fluids", itemType: 1, quantity: "0.5", unitPriceSen: 10_000, amountSen: 5_000, staffName: "North General", discountName: null, discountAmountSen: 0 },
      { lineNo: 5, name: "RM60 VOUCHER", itemType: 55, quantity: null, unitPriceSen: null, amountSen: -6_000, staffName: null, discountName: "RM60 VOUCHER", discountAmountSen: 6_000 },
    ]);

    const two = await getInvoice(session, "700102");
    expect(two.lines.map((line) => [line.staffName, line.quantity, line.amountSen])).toEqual([
      ["Dr Bravo", "1", 8_000], // Quantity sent as the JSON number 1
      ["Dr Alpha", "1", 12_000],
      ["Dr Alpha", "2.5", 18_050],
    ]);
    const blankDiscount = await getInvoice(session, "700201");
    expect(blankDiscount.lines[2]).toEqual({
      lineNo: 3,
      name: "RM40 OFF",
      itemType: 55,
      quantity: null,
      unitPriceSen: null,
      amountSen: -4_000,
      staffName: null,
      discountName: "RM40 OFF",
      discountAmountSen: 4_000,
    });
  });

  it("reads a return (negative quantity and amount in parentheses), a refunded and a cancelled invoice", async () => {
    const { session } = await signedIn();
    const returned = await getInvoice(session, "700206");
    expect(returned.header).toMatchObject({ netSen: -12_000, totalRefundsSen: 12_000 });
    expect(returned.lines).toEqual([
      { lineNo: 1, name: "Prescription diet 2kg", itemType: 1, quantity: "-1", unitPriceSen: 12_000, amountSen: -12_000, staffName: "Dr Delta", discountName: null, discountAmountSen: 0 },
    ]);
    expect(returned.raw.CreditNoteInfo).toMatchObject({ Amount: "120.00" });

    const refunded = await getInvoice(session, "700202");
    expect(refunded.header).toMatchObject({ netSen: 110_000, totalRefundsSen: 10_000 });
    expect(refunded.raw.RefundInfo).toMatchObject({ Amount: "100.00" });

    const cancelled = await getInvoice(session, "700103");
    expect(cancelled.lines).toHaveLength(1);
    expect(cancelled.raw.Sale).toMatchObject({ SaleStatusName: "Cancelled" });
  });

  it("parses every synthetic Sale Overview page", async () => {
    const { session } = await signedIn();
    const models = readSaleOverviewModels();
    for (const [saleId, model] of Object.entries(models)) {
      const invoice: KrelosesInvoiceDetail = await getInvoice(session, saleId);
      expect(invoice.header.saleId).toBe(saleId);
      expect(invoice.lines).toHaveLength((model as { Items: unknown[] }).Items.length);
    }
  });

  it("finds the model however it is written: braces and quotes in strings, escapes, whitespace, decoys", () => {
    const html = `
      <script>var modelTemplates = {"a": "}"};</script>
      <script>
        var   model=
          {"Items": [{"Name": "Tab \\"x\\" {1} \\u003c/script\\u003e", "Note": 'it\\'s } fine'}], "Sale": {"SaleId": 1}};
        var after = { "b": 1 };
      </script>`;
    expect(() => extractPageModel(html)).toThrow(LayoutChanged); // single-quoted strings are JS, not JSON
    const json = html.replace(`'it\\'s } fine'`, `"it's } fine"`);
    expect(extractPageModel(json)).toEqual({ Items: [{ Name: 'Tab "x" {1} </script>', Note: "it's } fine" }], Sale: { SaleId: 1 } });
  });

  describe("fails loudly (LayoutChanged), never guessing and never echoing values", () => {
    const cases: [string, string, RegExp][] = [
      ["the page has no `var model`", readFixture("sale-overview-no-model.html"), /Sale\/Overview: no `var model = \{…\}` in the page/],
      ["the model's line items moved/renamed", readFixture("sale-overview-changed.html"), /Sale\/Overview: no Items list in the page model/],
      ["the model is a JS literal, not JSON", pageWithModel(`{Items: [], Sale: {SaleId: 700101}}`), /Sale\/Overview: the page model is not JSON/],
      [
        "the model is cut off",
        readFixture("sale-overview-page.html").replace(/\{\{MODEL\}\}[\s\S]*$/, `{"Items": [{"Name": "Consultation"`),
        /Sale\/Overview: the page model never ends/,
      ],
      ["the model is not an object", pageWithModel(`[1, 2]`), /Sale\/Overview: no `var model = \{…\}` in the page/],
      ["a line lacks a field", pageWithModel(changedModel("700101", (model) => delete model.Items[1].StaffName)), /Items\[2\]: no StaffName/],
      ["an amount is unreadable", pageWithModel(changedModel("700101", (model) => (model.Items[0].Amount = "1.2.3"))), /Items\[1\]: Amount is not an amount/],
      ["ItemType is not a number", pageWithModel(changedModel("700101", (model) => (model.Items[0].ItemType = "Service"))), /Items\[1\]: ItemType is not a whole number/],
      ["a quantity has too many decimals", pageWithModel(changedModel("700101", (model) => (model.Items[0].Quantity = "0.12345"))), /Items\[1\]: Quantity is not a quantity/],
      ["a sold line has no quantity", pageWithModel(changedModel("700101", (model) => (model.Items[0].Quantity = ""))), /Items\[1\]: no Quantity on a line that is not a discount/],
      ["a sold line has no amount", pageWithModel(changedModel("700101", (model) => (model.Items[0].Amount = null))), /Items\[1\]: no Amount on a line that is not a discount/],
      ["the page is for another sale", pageWithModel(changedModel("700101", (model) => (model.Sale.SaleId = 700102))), /Sale\/Overview: the page is for another sale/],
      ["a total is unreadable", pageWithModel(changedModel("700101", (model) => (model.Totals.NetAmount = "12 hundred"))), /Totals\.NetAmount is not an amount/],
    ];
    it.each(cases)("%s", async (_label, html, message) => {
      const { fake, session } = await signedIn();
      answerOverview(fake, "700101", html);
      const error = await failure(getInvoice(session, "700101"));
      expect(error).toBeInstanceOf(LayoutChanged);
      expect((error as LayoutChanged).message).toMatch(message);
      const told = `${(error as LayoutChanged).message} ${(error as LayoutChanged).shape ?? ""}`;
      for (const value of NOTHING_PERSONAL) expect(told, value).not.toContain(value);
    });

  });

  describe("a page that is not there is told apart (PageMissing, a kind of LayoutChanged) so the sync can carry on", () => {
    it("an unknown sale (HTTP 404)", async () => {
      const { session } = await signedIn();
      const error = await failure(getInvoice(session, "999999"));
      expect(error).toBeInstanceOf(PageMissing);
      expect(error).toBeInstanceOf(LayoutChanged);
      expect(error).toMatchObject({ reason: "not_found", status: 404 });
      expect((error as Error).message).toMatch(/GET sea\.kreloses\.com\/Sale\/Overview\/999999 returned HTTP 404/);
    });

    it("a redirect somewhere other than the login page (e.g. back to the sale list)", async () => {
      const { fake, session } = await signedIn();
      fake.intercept((request) =>
        request.url.pathname === "/Sale/Overview/700101" ? new Response(null, { status: 302, headers: { Location: "/Sale/List" } }) : undefined,
      );
      const error = await failure(getInvoice(session, "700101"));
      expect(error).toBeInstanceOf(PageMissing);
      expect(error).toMatchObject({ reason: "redirected" });
    });

    it("but a redirect to the login page is still an expired session, and a changed page still a plain LayoutChanged", async () => {
      const { fake, session } = await signedIn();
      fake.intercept((request) =>
        request.url.pathname === "/Sale/Overview/700101"
          ? new Response(null, { status: 302, headers: { Location: "https://www.kreloses.com/account/login?ReturnUrl=x" } })
          : undefined,
      );
      expect(await failure(getInvoice(session, "700101"))).toBeInstanceOf(AuthFailed);
      answerOverview(fake, "700102", readFixture("sale-overview-no-model.html"));
      const changed = await failure(getInvoice(session, "700102"));
      expect(changed).toBeInstanceOf(LayoutChanged);
      expect(changed).not.toBeInstanceOf(PageMissing);
    });
  });

  it("raises AuthFailed(session_expired) when the session has expired", async () => {
    const { fake, session } = await signedIn();
    fake.expireSessions();
    const error = await failure(getInvoice(session, "700101"));
    expect(error).toBeInstanceOf(AuthFailed);
    expect((error as AuthFailed).reason).toBe("session_expired");
  });

  it("refuses a sale id that is not an id (a caller bug)", async () => {
    const { session } = await signedIn();
    for (const bad of ["", "../Account/LogOff", "70 01", "a".repeat(65)]) {
      await expect(getInvoice(session, bad)).rejects.toThrow(RangeError);
    }
  });
});

describe("Kreloses Reader: listStaff", () => {
  it("lists the staff from the Sale List filter's Staff options (full names), sharing the template with listLocations", async () => {
    const { fake, session } = await signedIn();
    await listLocations(session);
    expect(await listStaff(session)).toEqual([
      { id: "501", name: "Dr Alpha Anderson" },
      { id: "502", name: "Dr Bravo Brown" },
      { id: "503", name: "Branch North General" },
      { id: "504", name: "Charlie Chen" },
      { id: "506", name: "Branch South General" },
    ]);
    expect(fake.requests.filter((request) => request.url.pathname === "/Report/GetFilter")).toHaveLength(1);
  });

  it("skips an 'All' pseudo-option and duplicates; an empty Staff filter (e.g. loaded on demand) lists nobody", async () => {
    const fake = createFakeKreloses();
    fake.intercept((request) =>
      request.url.pathname === "/Report/GetFilter"
        ? Response.json({
            Filters: [
              { Name: "Location", Options: [{ Value: "1101", Text: "Branch North" }] },
              {
                Name: "Staff",
                Options: [
                  { Value: "", Text: "All staff" },
                  { Value: 501, Text: " Dr Alpha Anderson " },
                  { Value: "501", Text: "Dr Alpha Anderson" },
                ],
              },
            ],
          })
        : undefined,
    );
    const { session } = await signedIn(fake);
    expect(await listStaff(session)).toEqual([{ id: "501", name: "Dr Alpha Anderson" }]);

    const lookup = createFakeKreloses();
    lookup.intercept((request) =>
      request.url.pathname === "/Report/GetFilter" ? Response.json({ Filters: [{ Name: "Location", Options: [] }, { Name: "Staff", Type: "Lookup" }] }) : undefined,
    );
    expect(await listStaff((await signedIn(lookup)).session)).toEqual([]);
  });

  it("fails loudly when the template has no Staff filter or an option has no name", async () => {
    const fake = createFakeKreloses();
    fake.intercept((request) =>
      request.url.pathname === "/Report/GetFilter" ? new Response(readFixture("report-14-filter-lowercase.json"), { headers: { "Content-Type": "application/json" } }) : undefined,
    );
    const error = await failure(listStaff((await signedIn(fake)).session));
    expect(error).toBeInstanceOf(LayoutChanged);
    expect((error as Error).message).toMatch(/GetFilter: no Staff filter/);

    const nameless = createFakeKreloses();
    nameless.intercept((request) =>
      request.url.pathname === "/Report/GetFilter" ? Response.json({ Filters: [{ Name: "Staff", Options: [{ Value: "501", Text: "" }] }] }) : undefined,
    );
    expect(await failure(listStaff((await signedIn(nameless)).session))).toBeInstanceOf(LayoutChanged);
  });
});
