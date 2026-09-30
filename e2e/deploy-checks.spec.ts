import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

/**
 * The production deploy wizard's post-deploy checks (#7: `scripts/deploy-wizard.sh --check URL`, the
 * same checks as its stage 10) run with the real `curl` against the suite's running app: the
 * sign-in page renders, a signed-out visitor is sent to /login, and the cron and MCP endpoints
 * refuse a call without their secret. The checks send no secret. (HTTPS is only checked for a
 * non-local URL.) The owner runs the same command against production.
 */
const run = promisify(execFile);

test("the deploy wizard's post-deploy checks pass against the running app", async ({ baseURL }) => {
  test.setTimeout(180_000);
  const { stdout } = await run("/bin/bash", ["scripts/deploy-wizard.sh", "--check", baseURL!], {
    env: { NODE_ENV: "test", PATH: process.env.PATH, HOME: process.env.HOME, WIZARD_NO_BROWSER: "1" },
    timeout: 170_000,
  }).catch((error: { stdout?: string; stderr?: string; message: string }) => {
    throw new Error(`--check failed:\n${error.stdout ?? ""}${error.stderr ?? ""}\n${error.message}`);
  });

  expect(stdout).toContain("✓ /login renders the sign-in page");
  expect(stdout).toContain("✓ signed-out visitors are sent to /login (the dashboard is private)");
  expect(stdout).toContain("✓ /api/cron/nightly answers 401 without the cron secret (nightly sync)");
  expect(stdout).toContain("✓ /api/mcp answers 401 without the token (MCP_BEARER_TOKEN is set)");
  if (existsSync("src/app/api/cron/backfill/route.ts")) {
    expect(stdout).toContain("✓ /api/cron/backfill answers 401 without the cron secret (history backfill)");
  }
  expect(stdout).toContain("All checks passed.");
  expect(stdout).not.toContain("✗");
});
