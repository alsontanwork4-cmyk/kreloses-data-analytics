import { describe, expect, it } from "vitest";

import { magicLinkEmail } from "./claims";

// Shapes observed from the local Supabase Auth server (see README "Auth and access").
const at = 1790529393;

describe("magicLinkEmail", () => {
  it("accepts a session from our token-hash magic link (amr otp), new or returning user, after refresh", () => {
    expect(magicLinkEmail({ email: "Owner@Example.test", amr: [{ method: "otp", timestamp: at }] })).toBe(
      "Owner@Example.test",
    );
  });

  it("accepts a session from the PKCE ?code= fallback (amr magiclink)", () => {
    expect(magicLinkEmail({ email: "owner@example.test", amr: [{ method: "magiclink", timestamp: at }] })).toBe(
      "owner@example.test",
    );
  });

  it.each([
    ["a password sign-up or sign-in", [{ method: "password", timestamp: at }]],
    ["an OAuth sign-in", [{ method: "oauth", timestamp: at }]],
    ["an anonymous sign-in", [{ method: "anonymous", timestamp: at }]],
    ["no amr claim", undefined],
    ["an empty amr claim", []],
    ["a malformed amr claim", "otp"],
  ])("refuses %s", (_label, amr) => {
    expect(magicLinkEmail({ email: "owner@example.test", amr })).toBeNull();
  });

  it("refuses claims without an email", () => {
    expect(magicLinkEmail({ amr: [{ method: "otp", timestamp: at }] })).toBeNull();
    expect(magicLinkEmail({ email: "", amr: [{ method: "otp", timestamp: at }] })).toBeNull();
    expect(magicLinkEmail(null)).toBeNull();
    expect(magicLinkEmail(undefined)).toBeNull();
  });
});
