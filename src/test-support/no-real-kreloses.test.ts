import { describe, expect, it } from "vitest";

import { login, Transient } from "@/kreloses";

import { takeBlockedKrelosesRequests } from "./no-real-kreloses";

/**
 * The Vitest setup file `no-real-kreloses.ts` stops any test from reaching the real Kreloses,
 * e.g. one that forgets to pass the fake's `transport`. (`npm run test:live` does not load it.)
 */
describe("tests cannot contact the real Kreloses", () => {
  it("blocks fetch to *.kreloses.com, and records the attempt so the test fails", async () => {
    await expect(login({ email: "someone@clinic.example", password: "x" }, { requestDelayMs: 0 })).rejects.toBeInstanceOf(
      Transient,
    );
    // The setup file's afterEach fails any test that tried; this test takes the record itself.
    expect(takeBlockedKrelosesRequests()).toEqual(["GET https://www.kreloses.com/account/login"]);
    await expect(fetch("https://sea.kreloses.com/Report/GetFilter", { method: "POST" })).rejects.toThrow(
      /must not contact the real Kreloses/,
    );
    expect(takeBlockedKrelosesRequests()).toEqual(["POST https://sea.kreloses.com/Report/GetFilter"]);
  });
});
