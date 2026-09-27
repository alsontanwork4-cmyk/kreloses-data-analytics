import { databaseUrl } from "../../src/db/admin";

/** Identity of this e2e run (set in playwright.config.ts, inherited by the test workers). */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; run the suite with \`npm run test:e2e\``);
  return value;
}

const runId = required("E2E_RUN_ID");

export const run = {
  runId,
  databaseName: required("E2E_DB_NAME"),
  get databaseUrl() {
    return databaseUrl(this.databaseName);
  },
  /** Seeded by the app from OWNER_EMAIL. */
  ownerEmail: `e2e-owner-${runId}@example.test`,
  /** Added to the allow-list as a manager by global setup. */
  managerEmail: `e2e-manager-${runId}@example.test`,
  /** Never on the allow-list. */
  strangerEmail: `e2e-stranger-${runId}@example.test`,
  mailpitUrl: process.env.E2E_MAILPIT_URL || "http://127.0.0.1:54324",
};
