/**
 * Synthetic Kreloses logins the fake Kreloses accepts (`./fake-kreloses.ts`). None exist anywhere.
 * Kept in their own module (no `import.meta`, no fixtures) so the Playwright specs can import them
 * under Playwright's CommonJS transform.
 */
export interface FakeAccount {
  email: string;
  password: string;
  /** Location ids (from `report-14-filter.json`) this login can see. */
  locationIds: string[];
  /**
   * `ok` (default); `one_time_code` (redirects to a code page after the password);
   * `host_only_cookie` (auth cookie without Domain, so it never reaches sea);
   * `kreloses_down` (HTTP 503 on the login POST); `rate_limited` (HTTP 429 on the login POST).
   */
  behaviour?: "ok" | "one_time_code" | "host_only_cookie" | "kreloses_down" | "rate_limited";
}

export const SYNTHETIC_ACCOUNTS = {
  north: { email: "north.branch@clinic.example", password: "north-pass-1101", locationIds: ["1101"] },
  south: { email: "south.branch@clinic.example", password: "south-pass-1102", locationIds: ["1102"] },
  both: { email: "both.branches@clinic.example", password: "both-pass-1101-1102", locationIds: ["1101", "1102"] },
  oneTimeCode: {
    email: "two.step@clinic.example",
    password: "two-step-pass",
    locationIds: ["1101"],
    behaviour: "one_time_code",
  },
  hostOnlyCookie: {
    email: "host.only@clinic.example",
    password: "host-only-pass",
    locationIds: ["1101"],
    behaviour: "host_only_cookie",
  },
  down: { email: "kreloses.down@clinic.example", password: "down-pass", locationIds: [], behaviour: "kreloses_down" },
  rateLimited: {
    email: "rate.limited@clinic.example",
    password: "rate-limited-pass",
    locationIds: [],
    behaviour: "rate_limited",
  },
} as const satisfies Record<string, FakeAccount>;
