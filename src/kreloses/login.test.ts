import { describe, expect, it } from "vitest";

import {
  AuthFailed,
  KRELOSES_SEA_URL,
  KRELOSES_WWW_URL,
  LayoutChanged,
  RateLimited,
  Transient,
  listLocations,
  login,
  type HopEvent,
} from "./index";
import { SYNTHETIC_ACCOUNTS, createFakeKreloses, fixtureResponse, readFixture } from "./testing/fake-kreloses";

/** Seam 2: the Reader's login against the synthetic fixtures served by the fake Kreloses. */
const fast = { requestDelayMs: 0 };
const { north, both, oneTimeCode, hostOnlyCookie, down, rateLimited } = SYNTHETIC_ACCOUNTS;

async function loginError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the login to fail");
}

describe("Kreloses Reader: login", () => {
  it("logs in on www and returns a session that works on sea", async () => {
    const fake = createFakeKreloses();
    const session = await login(north, { ...fast, transport: fake.transport });

    expect(session.appHost).toBe("sea.kreloses.com");
    expect(await listLocations(session)).toEqual([{ id: "1101", name: "Branch North" }]);

    // The browser flow: login page, form POST, then the redirect chain www -> sea.
    expect(fake.requests.map((request) => `${request.method} ${request.url.host}${request.url.pathname}`)).toEqual([
      "GET www.kreloses.com/account/login",
      "POST www.kreloses.com/account/login",
      "GET sea.kreloses.com/",
      "GET sea.kreloses.com/Home/Index",
      "POST sea.kreloses.com/Report/GetFilter",
    ]);
  });

  it("posts the anti-forgery token, its cookie, and the credentials form-encoded", async () => {
    const fake = createFakeKreloses();
    await login(both, { ...fast, transport: fake.transport });

    const post = fake.requests[1]!;
    expect(post.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(post.headers.cookie).toContain("__RequestVerificationToken=SYNTHETIC-COOKIE-TOKEN-51c0ffee");
    const form = new URLSearchParams(post.body);
    expect(form.get("__RequestVerificationToken")).toBe("SYNTHETIC-FORM-TOKEN-7f3a9c1e2b4d+Qw==");
    expect(form.get("Email")).toBe(both.email);
    expect(form.get("Password")).toBe(both.password);
    expect(form.getAll("RememberMe")).toEqual(["false"]);
    expect(form.get("ReturnUrl")).toBe("");
  });

  it("sends the password only once, only to the Kreloses login form", async () => {
    const fake = createFakeKreloses();
    const session = await login(north, { ...fast, transport: fake.transport });
    await listLocations(session);

    const carryingPassword = fake.requests.filter(
      (request) => request.body?.includes(encodeURIComponent(north.password)) || request.body?.includes(north.password),
    );
    expect(carryingPassword.map((request) => `${request.method} ${request.url.href}`)).toEqual([
      "POST https://www.kreloses.com/account/login",
    ]);
  });

  it("carries the auth cookie from www to sea (Domain=.kreloses.com)", async () => {
    const fake = createFakeKreloses();
    await login(north, { ...fast, transport: fake.transport });
    const seaRequests = fake.requests.filter((request) => request.url.host === "sea.kreloses.com");
    expect(seaRequests.length).toBeGreaterThan(0);
    for (const request of seaRequests) expect(request.headers.cookie).toMatch(/\.AspNet\.ApplicationCookie=SYNTHETIC-AUTH-/);
    // The host-only anti-forgery cookie stays on www.
    for (const request of seaRequests) expect(request.headers.cookie).not.toContain("__RequestVerificationToken");
  });

  it("raises AuthFailed(bad_credentials) with Kreloses's message when the login form comes back", async () => {
    const fake = createFakeKreloses();
    const error = await loginError(login({ email: north.email, password: "wrong" }, { ...fast, transport: fake.transport }));
    expect(error).toBeInstanceOf(AuthFailed);
    expect(error).toMatchObject({ reason: "bad_credentials", detail: "Invalid login attempt." });
    expect(String((error as Error).message)).not.toContain("wrong");
  });

  it("raises AuthFailed(unexpected_step: one_time_code) when Kreloses asks for a code", async () => {
    const fake = createFakeKreloses();
    const error = await loginError(login(oneTimeCode, { ...fast, transport: fake.transport }));
    expect(error).toBeInstanceOf(AuthFailed);
    expect(error).toMatchObject({ reason: "unexpected_step", step: "one_time_code" });
    expect((error as AuthFailed).detail).toContain("www.kreloses.com/Account/VerifyCode");
    expect((error as AuthFailed).detail).not.toContain("?");
  });

  it("detects a session cookie that does not reach sea (sent back to the login page)", async () => {
    const fake = createFakeKreloses();
    const error = await loginError(login(hostOnlyCookie, { ...fast, transport: fake.transport }));
    expect(error).toBeInstanceOf(AuthFailed);
    expect(error).toMatchObject({ reason: "unexpected_step", step: "returned_to_login" });
    expect((error as AuthFailed).detail).toMatch(/did not carry over to sea\.kreloses\.com/);
  });

  it("does not follow a redirect off Kreloses, and never sends cookies there", async () => {
    const fake = createFakeKreloses();
    fake.intercept((request) =>
      request.method === "POST" && request.url.pathname === "/account/login"
        ? new Response(null, { status: 302, headers: { Location: "https://sso.example.test/authorize?client=secret" } })
        : undefined,
    );
    const error = await loginError(login(north, { ...fast, transport: fake.transport }));
    expect(error).toMatchObject({ reason: "unexpected_step", step: "redirected_elsewhere" });
    expect((error as AuthFailed).detail).toBe("Kreloses redirected the login to sso.example.test/authorize");
    expect(fake.requests.some((request) => request.url.host === "sso.example.test")).toBe(false);
  });

  it("raises AuthFailed(unexpected_step) when the login ends on an unknown page", async () => {
    const fake = createFakeKreloses();
    fake.intercept((request) =>
      request.method === "POST" && request.url.pathname === "/account/login"
        ? new Response("<html><body><h1>Choose your region</h1></body></html>", { status: 200 })
        : undefined,
    );
    const error = await loginError(login(north, { ...fast, transport: fake.transport }));
    expect(error).toMatchObject({ reason: "unexpected_step", step: "unrecognised_page" });
  });

  it("raises LayoutChanged when the login page has no anti-forgery token or no form", async () => {
    const withoutToken = createFakeKreloses();
    withoutToken.intercept((request) =>
      request.method === "GET" && request.url.pathname === "/account/login"
        ? new Response(readFixture("login-page.html").replace(/<input name="__RequestVerificationToken"[^>]*>/, ""), {
            status: 200,
          })
        : undefined,
    );
    expect(await loginError(login(north, { ...fast, transport: withoutToken.transport }))).toBeInstanceOf(LayoutChanged);

    const noForm = createFakeKreloses();
    noForm.intercept((request) =>
      request.method === "GET" ? new Response("<html><body>Maintenance</body></html>", { status: 200 }) : undefined,
    );
    expect(await loginError(login(north, { ...fast, transport: noForm.transport }))).toBeInstanceOf(LayoutChanged);
  });

  it("raises RateLimited on HTTP 429 and Transient on server errors or network failures", async () => {
    const limited = await loginError(login(rateLimited, { ...fast, transport: createFakeKreloses().transport }));
    expect(limited).toBeInstanceOf(RateLimited);
    expect(limited).toMatchObject({ retryAfterSeconds: 120 });

    expect(await loginError(login(down, { ...fast, transport: createFakeKreloses().transport }))).toBeInstanceOf(Transient);

    const offline = await loginError(
      login(north, {
        ...fast,
        transport: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    );
    expect(offline).toBeInstanceOf(Transient);
    expect((offline as Error).message).toBe("network error on GET www.kreloses.com/account/login");
  });

  it("turns a timeout into Transient", async () => {
    const error = await loginError(
      login(north, {
        ...fast,
        timeoutMs: 20,
        transport: (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
          }),
      }),
    );
    expect(error).toBeInstanceOf(Transient);
    expect((error as Error).message).toBe("no answer within 20 ms to GET www.kreloses.com/account/login");
  });

  it("does not mistake an app page with a code-like field for a one-time-code step", async () => {
    const fake = createFakeKreloses();
    fake.intercept((request) =>
      request.url.host === "sea.kreloses.com" && request.url.pathname === "/Home/Index"
        ? new Response(
            readFixture("sea-app-home.html").replace(
              '<div id="root"',
              '<form action="/Items/Search" method="get"><input type="text" name="Code" autocomplete="one-time-code" /></form><div id="root"',
            ),
            { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
          )
        : undefined,
    );
    const session = await login(north, { ...fast, transport: fake.transport });
    expect(await listLocations(session)).toEqual([{ id: "1101", name: "Branch North" }]);
  });

  it("treats a redirect back to the login form that never reached sea as bad credentials", async () => {
    const fake = createFakeKreloses();
    fake.intercept((request) =>
      request.method === "POST" && request.url.pathname === "/account/login"
        ? new Response(null, { status: 302, headers: { Location: "/account/login?failed=1" } })
        : undefined,
    );
    const error = await loginError(login(north, { ...fast, transport: fake.transport }));
    expect(error).toBeInstanceOf(AuthFailed);
    expect(error).toMatchObject({ reason: "bad_credentials" });
  });

  it("uses Kreloses's .alert-danger / .text-danger text as the bad-credentials message", async () => {
    const fake = createFakeKreloses();
    fake.intercept((request) =>
      request.method === "POST" && request.url.pathname === "/account/login"
        ? new Response(
            readFixture("login-page.html").replace(
              "<h2>Log in</h2>",
              '<h2>Log in</h2><div class="alert alert-danger" role="alert"> This account is locked. Try again in 5 minutes. </div><p class="text-danger">*</p>',
            ),
            { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
          )
        : undefined,
    );
    const error = await loginError(login(north, { ...fast, transport: fake.transport }));
    expect(error).toMatchObject({ reason: "bad_credentials", detail: "This account is locked. Try again in 5 minutes." });
  });

  it("raises LayoutChanged when the login form POST fails with HTTP 500 (e.g. an anti-forgery mismatch)", async () => {
    const fake = createFakeKreloses();
    // The login page without its anti-forgery cookie: the fake then fails the POST like MVC does.
    fake.intercept((request) =>
      request.method === "GET" && request.url.pathname === "/account/login"
        ? new Response(readFixture("login-page.html"), { status: 200, headers: { "Content-Type": "text/html" } })
        : undefined,
    );
    const error = await loginError(login(north, { ...fast, transport: fake.transport }));
    expect(error).toBeInstanceOf(LayoutChanged);
    expect((error as Error).message).toMatch(/HTTP 500.*anti-forgery/);

    // A 503 (maintenance, overload) stays Transient: worth retrying later.
    const unavailable = await loginError(login(down, { ...fast, transport: createFakeKreloses().transport }));
    expect(unavailable).toBeInstanceOf(Transient);
    expect(unavailable).toMatchObject({ status: 503 });
  });

  it("reports a redirect loop as its own unexpected step", async () => {
    const fake = createFakeKreloses();
    fake.intercept((request) =>
      request.url.host === "sea.kreloses.com" && request.url.pathname === "/"
        ? new Response(null, { status: 302, headers: { Location: "/" } })
        : undefined,
    );
    const error = await loginError(login(north, { ...fast, transport: fake.transport }));
    expect(error).toMatchObject({ reason: "unexpected_step", step: "too_many_redirects" });
    expect((error as AuthFailed).detail).toMatch(/more than 10 redirects/);
  });

  it("finds the anti-forgery token outside the form, or in a meta tag", async () => {
    const tokenInput = /<input name="__RequestVerificationToken"[^>]*\/>/;
    const token = readFixture("login-page.html").match(tokenInput)![0];
    for (const page of [
      readFixture("login-page.html").replace(tokenInput, "").replace("</body>", `${token}</body>`),
      readFixture("login-page.html")
        .replace(tokenInput, "")
        .replace("</head>", '<meta name="__RequestVerificationToken" content="SYNTHETIC-FORM-TOKEN-7f3a9c1e2b4d&#x2B;Qw==" /></head>'),
    ]) {
      const fake = createFakeKreloses();
      fake.intercept((request) => {
        if (request.method !== "GET" || request.url.pathname !== "/account/login") return undefined;
        const response = fixtureResponse("get-login", { ASPNET_SESSION: "s" }, { www: new URL(KRELOSES_WWW_URL), sea: new URL(KRELOSES_SEA_URL) });
        return new Response(page, { status: 200, headers: response.headers });
      });
      const session = await login(north, { ...fast, transport: fake.transport });
      expect(await listLocations(session)).toHaveLength(1);
    }
  });

  it("reports every hop to an observer without values or query strings", async () => {
    const fake = createFakeKreloses();
    const hops: HopEvent[] = [];
    await login(north, { ...fast, transport: fake.transport, observer: (hop) => hops.push(hop) });

    expect(hops.map((hop) => [hop.method, hop.url, hop.status, hop.location ?? null])).toEqual([
      ["GET", "www.kreloses.com/account/login", 200, null],
      ["POST", "www.kreloses.com/account/login", 302, "sea.kreloses.com/"],
      ["GET", "sea.kreloses.com/", 302, "sea.kreloses.com/Home/Index"],
      ["GET", "sea.kreloses.com/Home/Index", 200, null],
    ]);
    expect(hops[1]!.setCookies).toEqual([
      expect.objectContaining({ name: ".AspNet.ApplicationCookie", domain: "kreloses.com", hostOnly: false, action: "set" }),
    ]);
    const serialised = JSON.stringify(hops);
    expect(serialised).not.toContain(north.password);
    expect(serialised).not.toContain("SYNTHETIC-AUTH-");
    expect(serialised).not.toContain("SYNTHETIC-COOKIE-TOKEN");
  });

  it("runs a session's requests one at a time, with the polite delay between them", async () => {
    const fake = createFakeKreloses();
    let inFlight = 0;
    let maxInFlight = 0;
    const starts: number[] = [];
    const transport: typeof fake.transport = async (url, init) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      starts.push(Date.now());
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return await fake.transport(url, init);
      } finally {
        inFlight -= 1;
      }
    };
    const session = await login(north, { requestDelayMs: 60, transport });
    const results = await Promise.all([listLocations(session), listLocations(session), listLocations(session)]);

    expect(results).toEqual([[{ id: "1101", name: "Branch North" }], [{ id: "1101", name: "Branch North" }], [{ id: "1101", name: "Branch North" }]]);
    expect(maxInFlight).toBe(1);
    // The three GetFilter calls (the last three requests) each waited for the delay.
    const lastStarts = starts.slice(-3);
    expect(lastStarts[1]! - lastStarts[0]!).toBeGreaterThanOrEqual(55);
    expect(lastStarts[2]! - lastStarts[1]!).toBeGreaterThanOrEqual(55);
  });
});
