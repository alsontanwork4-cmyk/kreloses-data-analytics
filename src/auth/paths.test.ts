import { describe, expect, it } from "vitest";

import { isPublicPath, loginPath, safeNextPath } from "./paths";
import { hasRole } from "./roles";

describe("safeNextPath (where to return after sign-in)", () => {
  it("accepts same-origin paths with their query", () => {
    expect(safeNextPath("/doctors?range=today")).toBe("/doctors?range=today");
  });

  it.each([
    ["another origin", "https://evil.example/x"],
    ["a protocol-relative URL", "//evil.example/x"],
    ["a backslash trick", "/\\evil.example"],
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
