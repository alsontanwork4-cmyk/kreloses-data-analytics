import { resolveReaderOptions, type ReaderOptions } from "./config";
import { AuthFailed, LayoutChanged } from "./errors";
import { findLoginForm, isOneTimeCodeStep, validationMessages } from "./html";
import { KrelosesSession, redactUrl, type SessionResponse } from "./session";

export interface KrelosesCredentials {
  email: string;
  password: string;
}

const LOGIN_PATH = "/account/login";
const TOKEN_FIELD = "__RequestVerificationToken";
const CREDENTIAL_FIELDS = new Set(["email", "password", "rememberme"]);

/**
 * Logs in to Kreloses the way the browser does, and returns a session usable against the app
 * host (sea.kreloses.com):
 *
 * 1. GET www.kreloses.com/account/login → the ASP.NET anti-forgery token (hidden input) and its
 *    cookie.
 * 2. POST the form (`Email`, `Password`, `RememberMe`, the token and any other hidden fields),
 *    form-encoded, then follow the redirects by hand, carrying cookies per their Domain.
 * 3. Success = the chain ends on an app page on the sea host.
 *
 * Raises `AuthFailed("bad_credentials")` when Kreloses re-shows its login form,
 * `AuthFailed("unexpected_step")` for anything else (a one-time-code page, being sent back to the
 * login page, a redirect off Kreloses, an unknown page), `LayoutChanged` when the login page is
 * not what the Reader expects, and `RateLimited` / `Transient` for HTTP 429 / network and server
 * errors. The password is only ever sent in step 2, to the login form's own Kreloses URL.
 */
export async function login(credentials: KrelosesCredentials, options: ReaderOptions = {}): Promise<KrelosesSession> {
  const session = new KrelosesSession(resolveReaderOptions(options));

  const loginPage = await session.navigate({ method: "GET", url: session.url("www", LOGIN_PATH), followRedirects: true });
  if (loginPage.status !== 200) {
    throw new LayoutChanged(`The Kreloses login page (${redactUrl(loginPage.url)}) returned HTTP ${loginPage.status}`);
  }
  const form = findLoginForm(loginPage.body);
  if (!form) throw new LayoutChanged(`No login form on ${redactUrl(loginPage.url)}`);
  const token = form.inputs.find((input) => input.name === TOKEN_FIELD)?.value;
  if (!token) throw new LayoutChanged(`The Kreloses login form has no ${TOKEN_FIELD}`);

  const postUrl = new URL(form.action || loginPage.url.toString(), loginPage.url);
  if (postUrl.origin !== loginPage.url.origin) {
    throw new LayoutChanged(`The Kreloses login form posts to another site (${postUrl.host})`);
  }

  const fields = new URLSearchParams();
  for (const input of form.inputs) {
    if (input.type === "hidden" && input.name && !CREDENTIAL_FIELDS.has(input.name.toLowerCase())) {
      fields.append(input.name, input.value);
    }
  }
  fields.append("Email", credentials.email);
  fields.append("Password", credentials.password);
  fields.append("RememberMe", "false");

  const result = await session.navigate({
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
  classifyLoginResult(result, session);
  return session;
}

/** Throws unless the POST's redirect chain ended on an app page on the sea host. */
function classifyLoginResult(result: SessionResponse, session: KrelosesSession): void {
  const where = `${redactUrl(result.url)} (HTTP ${result.status})`;

  if (result.status >= 300 && result.status < 400) {
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
  const messages = validationMessages(result.body);
  if (loginForm && (result.redirects === 0 || messages.length > 0)) {
    throw new AuthFailed("bad_credentials", messages.length > 0 ? { detail: messages.join(" ") } : {});
  }
  if (isOneTimeCodeStep(result.body, result.url)) {
    throw new AuthFailed("unexpected_step", {
      step: "one_time_code",
      detail: `Kreloses asked for a one-time code or second login step at ${redactUrl(result.url)}`,
    });
  }
  if (loginForm) {
    throw new AuthFailed("unexpected_step", {
      step: "returned_to_login",
      detail: `After signing in, Kreloses sent the app back to its login page (${redactUrl(result.url)}): the session did not carry over to ${session.appHost}`,
    });
  }
  if (result.url.host !== session.appHost) {
    throw new AuthFailed("unexpected_step", {
      step: "unrecognised_page",
      detail: `The login ended on ${where} instead of ${session.appHost}`,
    });
  }
}
