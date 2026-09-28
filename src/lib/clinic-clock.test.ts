import { describe, expect, it } from "vitest";

import { clinicNow } from "./clinic-clock";

describe("clinicNow", () => {
  const FIXED = "2026-09-28T02:00:00+08:00";

  it("is the real time when CLINIC_NOW is not set", () => {
    const before = Date.now();
    const now = clinicNow({ NODE_ENV: "development" }).getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it("is CLINIC_NOW outside production (dev, test, a Vercel preview)", () => {
    expect(clinicNow({ NODE_ENV: "development", CLINIC_NOW: FIXED }).toISOString()).toBe("2026-09-27T18:00:00.000Z");
    expect(clinicNow({ NODE_ENV: "test", CLINIC_NOW: "2026-09-27T18:00:00Z" }).toISOString()).toBe("2026-09-27T18:00:00.000Z");
    expect(clinicNow({ CLINIC_NOW: FIXED }).toISOString()).toBe("2026-09-27T18:00:00.000Z");
    expect(clinicNow({ NODE_ENV: "development", VERCEL_ENV: "preview", CLINIC_NOW: FIXED }).toISOString()).toBe("2026-09-27T18:00:00.000Z");
  });

  it("ignores CLINIC_NOW in production (NODE_ENV or VERCEL_ENV)", () => {
    for (const env of [
      { NODE_ENV: "production", CLINIC_NOW: FIXED },
      { NODE_ENV: "development", VERCEL_ENV: "production", CLINIC_NOW: FIXED },
      { NODE_ENV: "production", VERCEL_ENV: "production", CLINIC_NOW: "not a date" },
    ]) {
      const before = Date.now();
      expect(clinicNow(env).getTime()).toBeGreaterThanOrEqual(before);
    }
  });

  it("refuses a CLINIC_NOW that is not an instant with a time zone (never guesses the server's)", () => {
    expect(() => clinicNow({ NODE_ENV: "development", CLINIC_NOW: "yesterday" })).toThrow(/CLINIC_NOW/);
    expect(() => clinicNow({ NODE_ENV: "development", CLINIC_NOW: "2026-09-28T02:00:00" })).toThrow(/CLINIC_NOW/);
    expect(() => clinicNow({ NODE_ENV: "development", CLINIC_NOW: "2026-02-30T02:00:00Z" })).toThrow(/CLINIC_NOW/);
  });
});
