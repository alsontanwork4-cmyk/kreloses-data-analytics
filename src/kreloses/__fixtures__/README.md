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
| `sea-not-signed-in.response.json` | Any sea request without a valid auth cookie: `302` to `https://www.kreloses.com/account/login?ReturnUrl=…` (the "login redirect") |
| `post-login-one-time-code.response.json` + `get-verify-code.response.json` + `login-verify-code.html` | An OTP / two-factor step: `302` to `/Account/VerifyCode`, a form with a `Code` field |
| `post-get-filter.response.json` + `report-14-filter.json` | `POST sea…/Report/GetFilter {"report":14}`: the Sale List filter template (Location, Sale status, Payment, Customer, Staff, Invoice category, Date). The fake narrows Location to the signed-in login's locations |
| `report-14-filter-lowercase.json` | The same data in camelCase, wrapped in `{success, data}`, numeric ids and a duplicate — spellings the parser also accepts |
| `report-14-filter-changed.json` | A GetFilter body the Reader must reject with `LayoutChanged` |

## Unverified guesses (replace with anonymised real recordings)

The live smoke test (`npm run test:live`, see the root README) prints what the real flow does.
Until real responses are recorded, these are guesses:

- The exact JSON of `/Report/GetFilter` (key names, whether options are `Value`/`Text` or
  `Id`/`Name`, wrappers). The live test prints its **shape** (keys and types only).
- The redirect chain after a successful login (here: www → `sea/` → `sea/Home/Index`).
- The auth cookie's name and Domain, and whether the session cookie is persistent.
- Whether a real login ever shows an OTP page (the spec says no captcha was observed; OTP unknown).

When replacing a fixture with a recorded one: strip every cookie value, token, customer name,
phone number, staff name and amount (the repo is public), keep the structure byte-for-byte
otherwise, and keep the file names so the fake keeps working.
