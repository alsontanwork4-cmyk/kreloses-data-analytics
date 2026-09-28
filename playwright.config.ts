import { createHash, randomBytes } from "node:crypto";

import { defineConfig, devices } from "@playwright/test";

import { loadLocalEnv } from "./scripts/env";
import { databaseUrl } from "./src/db/admin";

/**
 * E2E smoke suite (`npm run test:e2e`). Self-contained, and safe to run from several worktrees at
 * once: each run gets its own throwaway database (`kx_e2e_…`), its own Next.js dev server on its
 * own port (building into `.next-e2e`, so it doesn't disturb your dev server), and unique
 * synthetic emails. Magic links are read from the local Supabase mail catcher (Mailpit). The app
 * logs in to a fake Kreloses (e2e/support/fake-kreloses-server.ts) on its own port, never the
 * real one.
 *
 * Needs: `supabase start` (shared stack), `.env.local` with the Supabase URL + publishable key,
 * and once per machine `npx playwright install --only-shell chromium`.
 */

// The tests talk to Supabase Auth directly too, so they need the same URL/key as the app.
loadLocalEnv();

// Values are put on process.env so the test workers (child processes) see the same run.
process.env.E2E_RUN_ID ||= randomBytes(4).toString("hex");
process.env.E2E_DB_NAME ||= `kx_e2e_${Date.now().toString(36)}_${process.env.E2E_RUN_ID}`;
process.env.E2E_PORT ||= String(
  4100 + (parseInt(createHash("sha1").update(process.cwd()).digest("hex").slice(0, 8), 16) % 800),
);

const port = Number(process.env.E2E_PORT);
const baseURL = `http://localhost:${port}`;

// A fake Kreloses (synthetic fixtures) for the app to log in to: real Kreloses is never contacted.
process.env.E2E_KRELOSES_PORT ||= String(port + 1000);
const fakeKrelosesUrl = `http://127.0.0.1:${process.env.E2E_KRELOSES_PORT}`;
// A throwaway key per run for encrypting the (synthetic) Kreloses passwords.
process.env.E2E_CREDENTIALS_ENCRYPTION_KEY ||= randomBytes(32).toString("base64");
// A throwaway MCP bearer token per run (e2e/mcp.spec.ts sends it to /api/mcp).
process.env.E2E_MCP_BEARER_TOKEN ||= randomBytes(32).toString("base64");
// A fixed "now" at the clinic for pages that read `clinicNow()` (the Daily page's "yesterday" is
// 27 Sep 2026), so e2e/daily.spec.ts never depends on the machine clock or on crossing KL midnight.
process.env.E2E_CLINIC_NOW ||= "2026-09-28T09:00:00+08:00";
// A throwaway secret per run for the nightly cron endpoint (e2e/nightly.spec.ts calls it as Vercel Cron would).
process.env.E2E_CRON_SECRET ||= randomBytes(24).toString("hex");

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
  webServer: [
    {
      command: "npx tsx e2e/support/fake-kreloses-server.ts",
      url: `${fakeKrelosesUrl}/__health`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "ignore",
      stderr: "pipe",
      env: { FAKE_KRELOSES_PORT: process.env.E2E_KRELOSES_PORT },
    },
    {
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
        CREDENTIALS_ENCRYPTION_KEY: process.env.E2E_CREDENTIALS_ENCRYPTION_KEY,
        MCP_BEARER_TOKEN: process.env.E2E_MCP_BEARER_TOKEN,
        CLINIC_NOW: process.env.E2E_CLINIC_NOW,
        CRON_SECRET: process.env.E2E_CRON_SECRET,
        // Point the Kreloses Reader at the fake (allowed outside production, loopback only).
        KRELOSES_BASE_URL_WWW: fakeKrelosesUrl,
        KRELOSES_BASE_URL_SEA: fakeKrelosesUrl,
      },
    },
  ],
});
