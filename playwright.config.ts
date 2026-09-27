import { createHash, randomBytes } from "node:crypto";

import { defineConfig, devices } from "@playwright/test";

import { databaseUrl } from "./src/db/admin";

/**
 * E2E smoke suite (`npm run test:e2e`). Self-contained, and safe to run from several worktrees at
 * once: each run gets its own throwaway database (`kx_e2e_…`), its own Next.js dev server on its
 * own port (building into `.next-e2e`, so it doesn't disturb your dev server), and unique
 * synthetic emails. Magic links are read from the local Supabase mail catcher (Mailpit).
 *
 * Needs: `supabase start` (shared stack), `.env.local` with the Supabase URL + publishable key,
 * and once per machine `npx playwright install --only-shell chromium`.
 */

// Values are put on process.env so the test workers (child processes) see the same run.
process.env.E2E_RUN_ID ||= randomBytes(4).toString("hex");
process.env.E2E_DB_NAME ||= `kx_e2e_${Date.now().toString(36)}_${process.env.E2E_RUN_ID}`;
process.env.E2E_PORT ||= String(
  4100 + (parseInt(createHash("sha1").update(process.cwd()).digest("hex").slice(0, 8), 16) % 800),
);

const port = Number(process.env.E2E_PORT);
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "e2e",
  // One server + one database per run; tests share them, so keep them in order.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx next dev --port ${port}`,
    url: `${baseURL}/login`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      NEXT_DIST_DIR: ".next-e2e",
      DATABASE_URL: databaseUrl(process.env.E2E_DB_NAME),
      DATABASE_PREPARE: "true",
      // The owner is seeded from OWNER_EMAIL by the app itself (that path is under test too).
      OWNER_EMAIL: `e2e-owner-${process.env.E2E_RUN_ID}@example.test`,
    },
  },
});
