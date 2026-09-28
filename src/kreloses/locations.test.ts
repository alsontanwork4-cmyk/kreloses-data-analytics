import { describe, expect, it } from "vitest";

import { AuthFailed, LayoutChanged, RateLimited, listLocations, login } from "./index";
import { SYNTHETIC_ACCOUNTS, createFakeKreloses, readFixture } from "./testing/fake-kreloses";

/** Seam 2: the Location filter of the Sale List report (POST /Report/GetFilter {report: 14}). */
const fast = { requestDelayMs: 0 };
const { north, both } = SYNTHETIC_ACCOUNTS;

async function signedIn(account: { email: string; password: string } = both) {
  const fake = createFakeKreloses();
  const session = await login(account, { ...fast, transport: fake.transport });
  return { fake, session };
}

function answerGetFilter(fake: ReturnType<typeof createFakeKreloses>, response: () => Response) {
  fake.intercept((request) => (request.url.pathname === "/Report/GetFilter" ? response() : undefined));
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

describe("Kreloses Reader: listLocations", () => {
  it("lists every location the login can see, without the 'All Locations' pseudo-option", async () => {
    const { fake, session } = await signedIn(both);
    expect(await listLocations(session)).toEqual([
      { id: "1101", name: "Branch North" },
      { id: "1102", name: "Branch South" },
    ]);

    const request = fake.requests.at(-1)!;
    expect(request.method).toBe("POST");
    expect(request.url.href).toBe("https://sea.kreloses.com/Report/GetFilter");
    expect(JSON.parse(request.body!)).toEqual({ report: 14 });
    expect(request.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(request.headers["x-requested-with"]).toBe("XMLHttpRequest");
  });

  it("reads a login that sees one branch", async () => {
    const { session } = await signedIn(north);
    expect(await listLocations(session)).toEqual([{ id: "1101", name: "Branch North" }]);
  });

  it("accepts the other common ASP.NET JSON spellings (camelCase, wrapped in data, numeric ids)", async () => {
    const { fake, session } = await signedIn();
    answerGetFilter(
      fake,
      () =>
        new Response(readFixture("report-14-filter-lowercase.json"), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        }),
    );
    expect(await listLocations(session)).toEqual([
      { id: "1101", name: "Branch North" },
      { id: "1102", name: "Branch South" },
    ]);
  });

  it("raises LayoutChanged, with the shape but no values, when the filter JSON changes", async () => {
    const { fake, session } = await signedIn();
    answerGetFilter(
      fake,
      () =>
        new Response(readFixture("report-14-filter-changed.json"), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const error = await failure(listLocations(session));
    expect(error).toBeInstanceOf(LayoutChanged);
    expect((error as LayoutChanged).shape).toBe(
      "{reportDefinition: {id: number, sections: [{heading: string, controls: [{type: string, branches: [number] (2)}] (1)}] (1)}}",
    );
    expect((error as LayoutChanged).shape).not.toContain("1101");
  });

  it("raises LayoutChanged when the Location filter or its option fields are missing", async () => {
    const withoutLocation = await signedIn();
    answerGetFilter(withoutLocation.fake, () => Response.json({ Filters: [{ Name: "Sale status", Options: [] }] }));
    expect(await failure(listLocations(withoutLocation.session))).toBeInstanceOf(LayoutChanged);

    const oddOptions = await signedIn();
    answerGetFilter(oddOptions.fake, () => Response.json({ Filters: [{ Name: "Location", Options: [{ Code: "N" }] }] }));
    expect(await failure(listLocations(oddOptions.session))).toBeInstanceOf(LayoutChanged);
  });

  it("raises LayoutChanged when GetFilter answers with HTML or an unexpected status", async () => {
    const html = await signedIn();
    answerGetFilter(html.fake, () => new Response("<html><body>Oops</body></html>", { status: 200, headers: { "Content-Type": "text/html" } }));
    expect(await failure(listLocations(html.session))).toBeInstanceOf(LayoutChanged);

    const missing = await signedIn();
    answerGetFilter(missing.fake, () => new Response("Not found", { status: 404 }));
    expect(await failure(listLocations(missing.session))).toBeInstanceOf(LayoutChanged);
  });

  it("raises AuthFailed(session_expired) when Kreloses redirects to its login page", async () => {
    const { fake, session } = await signedIn();
    fake.expireSessions();
    const error = await failure(listLocations(session));
    expect(error).toBeInstanceOf(AuthFailed);
    expect(error).toMatchObject({ reason: "session_expired" });
  });

  it("raises AuthFailed(session_expired) on 401/403 or a login page instead of JSON", async () => {
    for (const response of [
      () => new Response(null, { status: 401 }),
      () => new Response(null, { status: 403 }),
      () => new Response(readFixture("login-page.html"), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }),
    ]) {
      const { fake, session } = await signedIn();
      answerGetFilter(fake, response);
      expect(await failure(listLocations(session))).toMatchObject({ reason: "session_expired" });
    }
  });

  it("raises RateLimited on HTTP 429", async () => {
    const { fake, session } = await signedIn();
    answerGetFilter(fake, () => new Response("slow down", { status: 429 }));
    expect(await failure(listLocations(session))).toBeInstanceOf(RateLimited);
  });
});
