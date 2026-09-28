import { describe, expect, it } from "vitest";

import { isPublicPath, loginPath, safeNextPath } from "./paths";
import { hasRole } from "./roles";

describe("safeNextPath (where to return after sign-in)", () => {
  it("accepts same-origin paths with their query", () => {
    expect(safeNextPath("/doctors?range=today")).toBe("/doctors?range=today");
  });

  it("returns the normalised path and query", () => {
    expect(safeNextPath("/daily/../doctors?range=today#top")).toBe("/doctors?range=today");
  });

  it.each([
    ["another origin", "https://evil.example/x"],
    ["a protocol-relative URL", "//evil.example/x"],
    ["a backslash trick", "/\\evil.example"],
    // Browsers strip tab/newline from URLs, turning these into //evil.example.
    ["a tab before a second slash", "/\t/evil.example"],
    ["a newline before a second slash", "/\n/evil"],
    ["a CRLF before a second slash", "/\r\n/evil"],
    ["a NUL character", "/\u0000/evil"],
    ["a DEL character", "/\u007f/evil"],
    ["a percent-encoded tab, once decoded by the query string", new URLSearchParams("next=/%09/evil.example").get("next")],
    // Dot segments normalise away, leaving a protocol-relative "//evil.example".
    ["a parent segment before a second slash", "/..//evil.example"],
    ["a current segment before a second slash", "/.//evil"],
    ["a parent segment after a real segment", "/a/..//evil"],
    ["an encoded parent segment", "/%2e%2e//evil.example"],
    ["an encoded parent segment, once decoded by the query string", new URLSearchParams("next=/%2e%2e//evil.example").get("next")],
    ["a parent segment inside the dashboard", "/overview/..//evil.example"],
    ["the login page itself", "/login?next=/overview"],
    ["an auth route", "/auth/confirm?code=x"],
    ["a relative path", "doctors"],
    ["a non-string", undefined],
  ])("rejects %s", (_label, value) => {
    expect(safeNextPath(value)).toBeNull();
  });
});

describe("isPublicPath", () => {
  it.each([
    ["/login", true],
    ["/auth/confirm", true],
    ["/auth/sign-out", true],
    ["/overview", false],
    ["/api/me", false],
    ["/loginx", false],
    ["/authz", false],
  ])("%s → %s", (path, expected) => {
    expect(isPublicPath(path)).toBe(expected);
  });
});

describe("loginPath", () => {
  it("carries the page to return to, except the home page", () => {
    expect(loginPath({ next: "/daily?range=today" })).toBe("/login?next=%2Fdaily%3Frange%3Dtoday");
    expect(loginPath({ next: "/overview" })).toBe("/login");
  });

  it("carries an error code", () => {
    expect(loginPath({ error: "access-denied" })).toBe("/login?error=access-denied");
  });
});

describe("hasRole", () => {
  it("lets owners do everything and managers only manager things", () => {
    expect(hasRole({ role: "owner" }, "owner")).toBe(true);
    expect(hasRole({ role: "owner" }, "manager")).toBe(true);
    expect(hasRole({ role: "manager" }, "manager")).toBe(true);
    expect(hasRole({ role: "manager" }, "owner")).toBe(false);
  });
});
