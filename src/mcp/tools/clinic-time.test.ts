import { describe, expect, it } from "vitest";

import { clinicTimestamp } from "./clinic-time";

describe("clinicTimestamp", () => {
  it("writes an instant in clinic time (Asia/Kuala_Lumpur) with its offset", () => {
    expect(clinicTimestamp(new Date("2026-10-01T02:00:00Z"))).toBe("2026-10-01T10:00:00+08:00");
    // Across midnight, and milliseconds dropped (not rounded up).
    expect(clinicTimestamp(new Date("2026-08-31T16:30:05.999Z"))).toBe("2026-09-01T00:30:05+08:00");
    expect(new Date(clinicTimestamp(new Date("2026-12-31T23:59:59Z"))).toISOString()).toBe("2026-12-31T23:59:59.000Z");
  });
});
