import { describe, expect, it } from "vitest";

import { AuthFailed, LayoutChanged, login } from "./index";
import { SYNTHETIC_ACCOUNTS, createFakeKreloses, readFixture } from "./testing/fake-kreloses";

/**
 * Seam 2: the session primitives later Reader functions build on — `postJson` (e.g. #4's
 * `/Sale/Get`) and `getHtml` (e.g. #5's `/Sale/Overview/{id}`) — and how they recognise an
 * expired session.
 */
const fast = { requestDelayMs: 0 };
const { north } = SYNTHETIC_ACCOUNTS;

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

describe("Kreloses session: getHtml", () => {
  it("returns an app page's HTML", async () => {
    const fake = createFakeKreloses();
    const session = await login(north, { ...fast, transport: fake.transport });
    expect(await session.getHtml("/Home/Index")).toContain('<div id="root" data-page="dashboard">');
    expect(fake.requests.at(-1)!.headers["x-requested-with"]).toBeUndefined();
  });

  it("raises AuthFailed(session_expired) when the page redirects to the login page", async () => {
    const fake = createFakeKreloses();
    const session = await login(north, { ...fast, transport: fake.transport });
    fake.expireSessions();
    expect(await failure(session.getHtml("/Home/Index"))).toMatchObject({ reason: "session_expired" });
  });

  it("raises AuthFailed(session_expired) for 401/403, X-Responded-JSON 401, or a login page", async () => {
    for (const answer of [
      () => new Response(null, { status: 401 }),
      () => new Response(null, { status: 403 }),
      () =>
        new Response("", {
          status: 200,
          headers: { "X-Responded-JSON": '{"status":401,"headers":{"location":"https:\\/\\/www.kreloses.com\\/account\\/login"}}' },
        }),
      () => new Response(readFixture("login-page.html"), { status: 200, headers: { "Content-Type": "text/html" } }),
    ]) {
      const fake = createFakeKreloses();
      const session = await login(north, { ...fast, transport: fake.transport });
      fake.intercept((request) => (request.url.pathname === "/Home/Index" ? answer() : undefined));
      const error = await failure(session.getHtml("/Home/Index"));
      expect(error).toBeInstanceOf(AuthFailed);
      expect(error).toMatchObject({ reason: "session_expired" });
    }
  });

  it("raises LayoutChanged for a missing page or a redirect elsewhere", async () => {
    const fake = createFakeKreloses();
    const session = await login(north, { ...fast, transport: fake.transport });
    expect(await failure(session.getHtml("/No/Such/Page"))).toBeInstanceOf(LayoutChanged);

    fake.intercept((request) =>
      request.url.pathname === "/Home/Index" ? new Response(null, { status: 302, headers: { Location: "/Home/Moved" } }) : undefined,
    );
    const moved = await failure(session.getHtml("/Home/Index"));
    expect(moved).toBeInstanceOf(LayoutChanged);
    expect((moved as Error).message).toContain("sea.kreloses.com/Home/Moved");
  });
});

describe("the fake Kreloses", () => {
  it("guards every sea route behind the login, including routes added later", async () => {
    const fake = createFakeKreloses();
    fake.addRoute({
      host: "sea",
      method: "POST",
      path: "/Sale/Get",
      handler: () => Response.json({ Results: [], TotalCount: 0 }),
    });
    fake.addRoute({
      host: "sea",
      method: "GET",
      path: /^\/Sale\/Overview\/\d+$/,
      handler: ({ request }) => new Response(`<html>sale ${request.url.pathname.split("/").at(-1)}</html>`),
    });
    const session = await login(north, { ...fast, transport: fake.transport });
    expect(await session.postJson("/Sale/Get", { request: {} })).toEqual({ Results: [], TotalCount: 0 });
    expect(await session.getHtml("/Sale/Overview/42")).toBe("<html>sale 42</html>");

    fake.expireSessions();
    expect(await failure(session.postJson("/Sale/Get", { request: {} }))).toMatchObject({ reason: "session_expired" });
    expect(await failure(session.getHtml("/Sale/Overview/42"))).toMatchObject({ reason: "session_expired" });
  });
});
