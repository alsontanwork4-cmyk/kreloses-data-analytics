import { describe, expect, it } from "vitest";

import { CookieJar } from "./cookie-jar";

const WWW = new URL("https://www.kreloses.com/account/login");
const SEA = new URL("https://sea.kreloses.com/Report/GetFilter");

describe("Reader cookie jar", () => {
  it("sends a cookie scoped to the parent domain to both www and sea", () => {
    const jar = new CookieJar();
    jar.store(WWW, [".AspNet.ApplicationCookie=auth123; domain=.kreloses.com; path=/; secure; HttpOnly"]);
    expect(jar.header(SEA)).toBe(".AspNet.ApplicationCookie=auth123");
    expect(jar.header(new URL("https://www.kreloses.com/"))).toBe(".AspNet.ApplicationCookie=auth123");
  });

  it("keeps a host-only cookie (no Domain) on the host that set it", () => {
    const jar = new CookieJar();
    jar.store(WWW, ["__RequestVerificationToken=tok; path=/; HttpOnly"]);
    expect(jar.header(new URL("https://www.kreloses.com/account/login"))).toBe("__RequestVerificationToken=tok");
    expect(jar.header(SEA)).toBeNull();
  });

  it("ignores a cookie for a domain the response's host does not belong to", () => {
    const jar = new CookieJar();
    jar.store(WWW, [
      "stolen=1; domain=evil.example; path=/",
      "tld=1; domain=com; path=/",
      "sibling=1; domain=sea.kreloses.com; path=/",
    ]);
    expect(jar.header(new URL("https://evil.example/"))).toBeNull();
    expect(jar.header(new URL("https://other.com/"))).toBeNull();
    expect(jar.header(SEA)).toBeNull();
    expect(jar.describe()).toEqual([]);
  });

  it("matches paths and sends the most specific path first", () => {
    const jar = new CookieJar();
    jar.store(WWW, ["a=root; path=/", "b=account; path=/account"]);
    expect(jar.header(new URL("https://www.kreloses.com/account/login"))).toBe("b=account; a=root");
    expect(jar.header(new URL("https://www.kreloses.com/accounting"))).toBe("a=root");
    expect(jar.header(new URL("https://www.kreloses.com/Home"))).toBe("a=root");
  });

  it("defaults the path to the directory of the request path", () => {
    const jar = new CookieJar();
    jar.store(new URL("https://www.kreloses.com/account/login"), ["dir=1"]);
    expect(jar.header(new URL("https://www.kreloses.com/account/other"))).toBe("dir=1");
    expect(jar.header(new URL("https://www.kreloses.com/"))).toBeNull();
  });

  it("replaces a cookie with the same name, domain and path, and deletes expired ones", () => {
    const now = Date.UTC(2026, 8, 28, 2, 0, 0);
    const jar = new CookieJar(() => now);
    jar.store(WWW, ["s=one; path=/", "keep=1; path=/"]);
    jar.store(WWW, ["s=two; path=/"]);
    expect(jar.header(WWW)).toBe("s=two; keep=1");

    jar.store(WWW, ["s=; path=/; Max-Age=0"]);
    expect(jar.header(WWW)).toBe("keep=1");

    jar.store(WWW, ["keep=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT"]);
    expect(jar.header(WWW)).toBeNull();
  });

  it("stops sending a cookie once it expires, and Max-Age wins over Expires", () => {
    let now = Date.UTC(2026, 8, 28, 2, 0, 0);
    const jar = new CookieJar(() => now);
    jar.store(WWW, [
      "short=1; path=/; Max-Age=60; expires=Wed, 01 Jan 2031 00:00:00 GMT",
      "dated=1; path=/; expires=Mon, 28 Sep 2026 03:00:00 GMT",
    ]);
    expect(jar.header(WWW)).toBe("short=1; dated=1");
    now += 61_000;
    expect(jar.header(WWW)).toBe("dated=1");
    now = Date.UTC(2026, 8, 28, 3, 0, 1);
    expect(jar.header(WWW)).toBeNull();
  });

  it("sends Secure cookies only over https (or to a loopback test server)", () => {
    const jar = new CookieJar();
    jar.store(WWW, ["sec=1; domain=kreloses.com; path=/; Secure"]);
    expect(jar.header(new URL("http://sea.kreloses.com/"))).toBeNull();
    expect(jar.header(SEA)).toBe("sec=1");

    const local = new URL("http://127.0.0.1:5123/account/login");
    jar.store(local, ["loop=1; path=/; Secure"]);
    expect(jar.header(local)).toBe("loop=1");
  });

  it("describes cookies without ever revealing their values", () => {
    const now = Date.UTC(2026, 8, 28, 2, 0, 0);
    const jar = new CookieJar(() => now);
    jar.store(WWW, [
      ".AspNet.ApplicationCookie=SECRET-AUTH-VALUE; domain=.kreloses.com; path=/; Max-Age=1209600; secure; HttpOnly; SameSite=Lax",
      "ASP.NET_SessionId=SECRET-SESSION; path=/; HttpOnly",
    ]);
    const described = jar.describe();
    expect(described).toEqual([
      {
        name: ".AspNet.ApplicationCookie",
        domain: "kreloses.com",
        hostOnly: false,
        path: "/",
        expiresAt: new Date(now + 1_209_600_000).toISOString(),
        secure: true,
        httpOnly: true,
        sameSite: "lax",
      },
      {
        name: "ASP.NET_SessionId",
        domain: "www.kreloses.com",
        hostOnly: true,
        path: "/",
        expiresAt: null,
        secure: false,
        httpOnly: true,
        sameSite: null,
      },
    ]);
    expect(JSON.stringify(described)).not.toMatch(/SECRET/);
  });
});
