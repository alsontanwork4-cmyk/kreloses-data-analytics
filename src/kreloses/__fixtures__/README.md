# Kreloses fixtures — SYNTHETIC

Every file here is **made up**. None was recorded from the real Kreloses: no agent working on this
repo has Kreloses credentials, and the repo is public. They imitate the shapes described in the
spec (issue #1, "Data source") and the usual ASP.NET MVC 5 / ASP.NET Identity output, so the
Reader can be built and tested before real traffic is seen. Names, emails, tokens and ids are
synthetic ("Branch North", "Dr Alpha Anderson", `SYNTHETIC-…` tokens, `@clinic.example` emails).

The fake Kreloses (`../testing/fake-kreloses.ts`) serves them to the unit tests (Seam 2) and,
over HTTP, to the e2e suite. It swaps `https://www.kreloses.com` / `https://sea.kreloses.com` for
its own hosts and fills `{{VAR}}` placeholders (per-login auth tickets).

| File | Imitates |
| --- | --- |
| `get-login.response.json` + `login-page.html` | `GET www…/account/login`: the login form with the hidden `__RequestVerificationToken` (HTML-encoded `+`), plus the anti-forgery and `ASP.NET_SessionId` cookies (host-only) |
| `post-login-bad-credentials.response.json` + `login-failed.html` | Wrong email/password: the form re-rendered (HTTP 200) with `validation-summary-errors` "Invalid login attempt." |
| `post-login-success.response.json` | Good credentials: `302` to `https://sea.kreloses.com/` and `.AspNet.ApplicationCookie` with `domain=.kreloses.com` |
| `get-sea-root.response.json` | `GET sea…/` signed in: relative `302` to `/Home/Index` |
| `get-sea-home.response.json` + `sea-app-home.html` | The signed-in app shell on sea (a logout form, no password field) |
| `sea-not-signed-in.response.json` | A sea page load without a valid auth cookie: `302` to `https://www.kreloses.com/account/login?ReturnUrl=…` (the "login redirect") |
| `sea-ajax-not-signed-in.response.json` | A sea AJAX call (`X-Requested-With: XMLHttpRequest`) without a valid auth cookie: ASP.NET Identity's HTTP 200, empty body, `X-Responded-JSON: {"status":401,…}` |
| `post-login-one-time-code.response.json` + `get-verify-code.response.json` + `login-verify-code.html` | An OTP / two-factor step: `302` to `/Account/VerifyCode`, a form with a `Code` field |
| `post-get-filter.response.json` + `report-14-filter.json` | `POST sea…/Report/GetFilter {"report":14}`: the Sale List filter template (Location, Sale status, Payment, Customer, Staff, Invoice category, Date). The fake narrows Location to the signed-in login's locations |
| `report-14-filter-lowercase.json` | The same data in camelCase, wrapped in `{success, data}`, numeric ids and a duplicate — spellings the parser also accepts |
| `report-14-filter-changed.json` | A GetFilter body the Reader must reject with `LayoutChanged` |
| `sale-list-rows.json` + `post-sale-get.response.json` | The Sale List: 20 synthetic sales ("Customer 0001"…, two branches, Aug–Sep 2026 and Sep–Oct 2025; active, cancelled, a partial refund, a walk-in without a customer, a negative "return" sale in parentheses, amounts with thousand separators, `SaleDate` as `/Date(ms)/` around KL month ends). The fake answers `POST sea…/Sale/Get` from them: it applies the request's `filter` (Sale status, Location — only the login's own —, Date `From`/`To`), sorts newest first and pages by `RequestingPage`/`PageSize`, returning `{Columns, Results, TotalCount}`. `fake.saleRows` is the live, mutable copy |
| `sale-get-formats.json` | One `/Sale/Get` page using every other date and number format the Reader accepts (ISO with/without zone, `/Date(ms+0800)/`, `dd/MM/yyyy hh:mm AM`, `1 Sep 2026`, `15-Sep-2026 14:05`; JSON numbers, `RM` prefixes, minus signs, `-` for empty, `CustomerId` 0/null) |
| `sale-get-changed.json` | A `/Sale/Get` body in a different layout (`{success, data: {items, count}}`): `LayoutChanged` |
| `sale-overviews.json` + `get-sale-overview.response.json` + `sale-overview-page.html` | `GET sea…/Sale/Overview/{SaleId}` (#5): one synthetic page model per sale in `sale-list-rows.json` (`Sale`, `Customer`, `Items[]`, `Totals`, `Transactions`, `RefundInfo`, `CreditNoteInfo`), rendered by the fake into the page as `var model = {…};` (JSON-encoded like ASP.NET's `Json.Encode`, next to decoy scripts with braces in strings). Covers: one doctor with an invoice discount line (700101), two doctors + a fractional quantity (700102), an item-level discount, a no-staff line, a generic account and a `(60.00)` discount line with empty quantity/price (700104), non-doctor staff (700105), a doctor missing from the staff list — "Dr Delta" — and a `-40.00` discount line (700201), a refund (700202), lines that do not add up to the net (700203), a walk-in (700205), a return with quantity `(1)` (700206), a cancelled sale (700103), a `Dr.` spelling variant, thousand separators and a JSON-number quantity. `fake.saleOverviews` is the live, mutable copy; hand-computed credited figures are in `src/analytics/doctors.test.ts` |
| `discount-sales.json` | Extra synthetic sales for July 2026 (#12) — `{rows, models}`: Sale List rows + Sale Overview models for discount edge cases (two doctors sharing a discount line, an item discount next to a discount line, discounts of exactly 5 and 6 sen, fractional quantities, a fully discounted line and a zero-price line, one name spelled two ways as item discount and discount line, an unnamed item discount, a sale with no invoice page, a cancelled sale). NOT served by default: `src/analytics/discounts.test.ts` adds them to the fake (`createSyncHarness(sql, { fake: { saleList: { rows }, saleOverviews } })`), so the shared figures above are unchanged; hand-computed figures are in that test |
| `sale-overview-no-model.html` | An invoice page without `var model` (data loaded some other way): `LayoutChanged` |
| `sale-overview-changed.html` | An invoice page whose model moved and renamed its line items (`Lines.Rows`): `LayoutChanged` |

## Unverified guesses (replace with anonymised real recordings)

The live smoke test (`npm run test:live`, see the root README) prints what the real flow does.
Until real responses are recorded, these are guesses:

- The exact JSON of `/Report/GetFilter` (key names, whether options are `Value`/`Text` or
  `Id`/`Name`, wrappers). The live test prints its **shape** (keys and types only).
- The redirect chain after a successful login (here: www → `sea/` → `sea/Home/Index`).
- The auth cookie's name and Domain, and whether the session cookie is persistent.
- How sea answers an expired session: a 302 to the login page, or (for AJAX calls) ASP.NET
  Identity's HTTP 200 + `X-Responded-JSON` 401. The Reader handles both; the live report flags
  `X-Responded-JSON` on any hop.
- Whether a real login ever shows an OTP page (the spec says no captcha was observed; OTP unknown).
- The Sale List (`/Sale/Get`, #4): the format of `SaleDate` (here `/Date(ms)/`, read as UTC; an
  ISO string without a zone would be read as KL wall-clock time), how amounts are formatted, the
  exact status labels ("Active" / "Cancelled"), the sort order (assumed newest first by sale
  date), and how the filter template records selections (here `Selected` flags on options) and
  its date range (here `Date.From`/`To` as `dd/MM/yyyy`). The live report prints each of these
  (as patterns and labels, never values).
- The Sale Overview page (#5): the model's key names outside `Items[]` (`Sale.SaleId`, `Totals.*`),
  whether `Amount` is the line's charged amount after its item discount, the sign and the empty
  fields of discount lines (ItemType 55), how quantities and amounts are written, whether
  `StaffName` is the short form ("Dr Ong"), and how a refund shows (`RefundInfo`,
  `CreditNoteInfo`). The live report prints the model's shape and yes/no checks for each.
- The Staff filter of report 14 (#5): here a `MultiSelect` whose options are full staff names
  ("Dr Alpha Anderson", "Charlie Chen", "Branch North General", …); the live report prints only how
  many there are.

When replacing a fixture with a recorded one: strip every cookie value, token, customer name,
phone number, staff name and amount (the repo is public), keep the structure byte-for-byte
otherwise, and keep the file names so the fake keeps working.
