import { resolveReaderOptions, type ReaderOptions } from "./config";
import { AuthFailed, LayoutChanged, Transient } from "./errors";
import { findAntiForgeryToken, findLoginForm, hasOneTimeCodeForm, isOneTimeCodePath, validationMessages } from "./html";
import { KrelosesSession, looksLikeLoginUrl, MAX_REDIRECTS, redactUrl, type SessionResponse } from "./session";

export interface KrelosesCredentials {
  email: string;
  password: string;
}

const LOGIN_PATH = "/account/login";
const TOKEN_FIELD = "__RequestVerificationToken";
const CREDENTIAL_FIELDS = new Set(["email", "password", "rememberme", TOKEN_FIELD.toLowerCase()]);

/**
 * Logs in to Kreloses the way the browser does, and returns a session usable against the app
 * host (sea.kreloses.com):
 *
 * 1. GET www.kreloses.com/account/login → the ASP.NET anti-forgery token (hidden input in the
 *    form, anywhere on the page, or a `<meta>` tag) and its cookie.
 * 2. POST the form (`Email`, `Password`, `RememberMe`, the token and any other hidden fields),
 *    form-encoded, then follow the redirects by hand, carrying cookies per their Domain.
 * 3. Success = the chain ends on an app page on the sea host.
 *
 * Failures:
 * - `AuthFailed("bad_credentials")`: Kreloses shows its login form again without the chain ever
 *   reaching the app (re-rendered, or redirected back), with its own message in `detail`.
 * - `AuthFailed("unexpected_step")`: anything else between the form and the app — `step` says
 *   which: `one_time_code`, `returned_to_login` (reached sea, then sent back to the login page:
 *   the session did not carry over), `redirected_elsewhere` (off Kreloses; not followed),
 *   `too_many_redirects`, `unrecognised_page`.
 * - `LayoutChanged`: the login page or form is not what the Reader expects, including HTTP 500 on
 *   the form POST (what ASP.NET MVC answers to an anti-forgery mismatch).
 * - `RateLimited` / `Transient`: HTTP 429 / network errors, timeouts and other server errors.
 *
 * The password is only ever sent in step 2, to the login form's own Kreloses URL.
 */
export async function login(credentials: KrelosesCredentials, options: ReaderOptions = {}): Promise<KrelosesSession> {
  const session = new KrelosesSession(resolveReaderOptions(options));

  const loginPage = await session.navigate({ method: "GET", url: session.url("www", LOGIN_PATH), followRedirects: true });
  if (loginPage.status !== 200) {
    throw new LayoutChanged(`The Kreloses login page (${redactUrl(loginPage.url)}) returned HTTP ${loginPage.status}`);
  }
  const form = findLoginForm(loginPage.body);
  if (!form) throw new LayoutChanged(`No login form on ${redactUrl(loginPage.url)}`);
  const token = findAntiForgeryToken(loginPage.body, form);
  if (!token) throw new LayoutChanged(`The Kreloses login page has no ${TOKEN_FIELD}`);

  const postUrl = new URL(form.action || loginPage.url.toString(), loginPage.url);
  if (postUrl.origin !== loginPage.url.origin) {
    throw new LayoutChanged(`The Kreloses login form posts to another site (${postUrl.host})`);
  }

  const fields = new URLSearchParams();
  fields.append(TOKEN_FIELD, token);
  for (const input of form.inputs) {
    if (input.type === "hidden" && input.name && !CREDENTIAL_FIELDS.has(input.name.toLowerCase())) {
      fields.append(input.name, input.value);
    }
  }
  fields.append("Email", credentials.email);
  fields.append("Password", credentials.password);
  fields.append("RememberMe", "false");

  let result: SessionResponse;
  try {
    result = await session.navigate({
      method: "POST",
      url: postUrl,
      followRedirects: true,
      body: fields.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: loginPage.url.origin,
        Referer: `${loginPage.url.origin}${loginPage.url.pathname}`,
      },
    });
  } catch (error) {
    // HTTP 500 on the form POST itself (not a later hop): ASP.NET MVC's answer to a missing or
    // mismatched anti-forgery token or an unexpected form. Retrying will not help.
    if (error instanceof Transient && error.status === 500 && error.request === `POST ${redactUrl(postUrl)}`) {
      throw new LayoutChanged(
        `Kreloses answered HTTP 500 to the login form (${redactUrl(postUrl)}): the anti-forgery token or the form fields may have changed`,
      );
    }
    throw error;
  }
  classifyLoginResult(result, session);
  return session;
}

/** Throws unless the POST's redirect chain ended on an app page on the sea host. */
function classifyLoginResult(result: SessionResponse, session: KrelosesSession): void {
  const where = `${redactUrl(result.url)} (HTTP ${result.status})`;
  const isAppPage = (url: URL) => url.host === session.appHost && !looksLikeLoginUrl(url);

  if (result.status >= 300 && result.status < 400) {
    if (result.unfollowed === "too_many_redirects") {
      throw new AuthFailed("unexpected_step", {
        step: "too_many_redirects",
        detail: `Kreloses sent the login through more than ${MAX_REDIRECTS} redirects (last at ${redactUrl(result.url)}), probably a loop`,
      });
    }
    throw new AuthFailed("unexpected_step", {
      step: "redirected_elsewhere",
      detail: `Kreloses redirected the login to ${result.location ? redactUrl(result.location) : "an invalid address"}`,
    });
  }
  if (result.status === 400 || result.status === 404 || result.status === 405) {
    throw new LayoutChanged(`Kreloses rejected the login form submission: ${where}`);
  }
  if (result.status !== 200) {
    throw new AuthFailed("unexpected_step", { step: "unrecognised_page", detail: `The login ended on ${where}` });
  }

  const loginForm = findLoginForm(result.body);
  if (loginForm) {
    if (result.chain.some(isAppPage)) {
      throw new AuthFailed("unexpected_step", {
        step: "returned_to_login",
        detail: `After signing in, Kreloses sent the app back to its login page (${redactUrl(result.url)}): the session did not carry over to ${session.appHost}`,
      });
    }
    const messages = validationMessages(result.body);
    throw new AuthFailed("bad_credentials", messages.length > 0 ? { detail: messages.join(" ") } : {});
  }

  // On an app page, only the URL can tell a code step apart (app pages may have "Code" fields).
  const oneTimeCode = isAppPage(result.url)
    ? isOneTimeCodePath(result.url)
    : isOneTimeCodePath(result.url) || hasOneTimeCodeForm(result.body);
  if (oneTimeCode) {
    throw new AuthFailed("unexpected_step", {
      step: "one_time_code",
      detail: `Kreloses asked for a one-time code or second login step at ${redactUrl(result.url)}`,
    });
  }
  if (result.url.host !== session.appHost) {
    throw new AuthFailed("unexpected_step", {
      step: "unrecognised_page",
      detail: `The login ended on ${where} instead of ${session.appHost}`,
    });
  }
}
