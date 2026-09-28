import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { DEFAULT_BACKFILL_NIGHT_WINDOW, nightWindowAt, parseNightWindow } from "./backfill-config";

/**
 * The GitHub Actions workflow that triggers the history backfill (`.github/workflows/backfill.yml`).
 * It is never run here: its YAML is parsed and checked, and its one shell step is run locally with a
 * stand-in `curl` (no network), so the owner's opt-in, the secrets handling and "fail on anything
 * but 2xx" are tested.
 */
const WORKFLOW = fileURLToPath(new URL("../../.github/workflows/backfill.yml", import.meta.url));
// js-yaml comes with ESLint's config loader (no extra dependency for one test).
const { load } = createRequire(import.meta.url)("js-yaml") as { load(text: string): unknown };

interface Workflow {
  name: string;
  on: { schedule: { cron: string }[]; workflow_dispatch: unknown };
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, { if: string; "runs-on": string; "timeout-minutes": number; steps: { name: string; env: Record<string, string>; run: string }[] }>;
}

const workflow = load(readFileSync(WORKFLOW, "utf8")) as Workflow;
const job = Object.values(workflow.jobs)[0]!;
const step = job.steps[0]!;

describe("the backfill workflow (GitHub Actions)", () => {
  it("runs every 15 minutes inside the app's default night window, and by hand", () => {
    expect(Object.hasOwn(workflow.on, "workflow_dispatch")).toBe(true);
    expect(workflow.on.schedule).toEqual([{ cron: "*/15 16-21 * * *" }]);
    // Every scheduled time (UTC) falls inside BACKFILL_NIGHT_WINDOW's default in Kuala Lumpur.
    const window = parseNightWindow(DEFAULT_BACKFILL_NIGHT_WINDOW)!;
    const times: Date[] = [];
    for (let hour = 16; hour <= 21; hour += 1) for (let minute = 0; minute < 60; minute += 15) times.push(new Date(Date.UTC(2026, 9, 1, hour, minute)));
    expect(times).toHaveLength(24);
    for (const time of times) expect(nightWindowAt(time, window).inWindow, time.toISOString()).toBe(true);
  });

  it("is inert until the owner opts in, needs no repository access, and never overlaps itself", () => {
    expect(Object.keys(workflow.jobs)).toHaveLength(1);
    expect(job.if).toBe("vars.BACKFILL_ENABLED == 'true'");
    expect(workflow.permissions).toEqual({});
    expect(workflow.concurrency).toEqual({ group: "history-backfill", "cancel-in-progress": false });
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(10);
    expect(job.steps).toHaveLength(1);
  });

  it("passes the secrets through the environment only (never pasted into the script) and never prints them", () => {
    expect(step.env).toEqual({ APP_URL: "${{ secrets.APP_URL }}", CRON_SECRET: "${{ secrets.CRON_SECRET }}" });
    expect(step.run).not.toContain("${{");
    expect(step.run).not.toMatch(/set -x|set -o xtrace/);
    for (const line of step.run.split("\n").filter((text) => /\becho\b/.test(text))) {
      expect(line, line).not.toMatch(/CRON_SECRET}|\$CRON_SECRET|APP_URL}|\$APP_URL/);
    }
    expect(step.run).toContain("curl -fsS");
    expect(step.run).toMatch(/--max-time \d+/);
    expect(step.run).toContain("-o /dev/null"); // the answer (connection names, counts) stays out of the public log
    expect(spawnSync("bash", ["-n", "-c", step.run]).status).toBe(0);
  });

  describe("its step, run with a stand-in curl", () => {
    const dir = mkdtempSync(join(tmpdir(), "kx-backfill-workflow-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    // The stand-in records its arguments and "answers" FAKE_STATUS, exiting FAKE_EXIT (22 = curl -f on an HTTP error).
    writeFileSync(join(dir, "curl"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(dir, "args")}"\nprintf '%s' "$FAKE_STATUS"\nexit "\${FAKE_EXIT:-0}"\n`);
    chmodSync(join(dir, "curl"), 0o755);
    const SECRET = "synthetic-cron-secret-0123456789";
    const runStep = (env: Record<string, string>) => {
      const result = spawnSync("bash", ["-c", step.run], { env: { NODE_ENV: "test", PATH: `${dir}:${process.env.PATH}`, ...env }, encoding: "utf8" });
      return { status: result.status, output: `${result.stdout}${result.stderr}`, args: (() => { try { return readFileSync(join(dir, "args"), "utf8").split("\n"); } catch { return []; } })() };
    };

    it("calls the endpoint over HTTPS with the bearer secret and succeeds on 2xx, printing only the status", () => {
      const result = runStep({ APP_URL: "https://clinic.example/", CRON_SECRET: SECRET, FAKE_STATUS: "200" });
      expect(result.status).toBe(0);
      expect(result.args).toEqual(expect.arrayContaining(["-fsS", "--proto", "=https", `Authorization: Bearer ${SECRET}`, "https://clinic.example/api/cron/backfill"]));
      expect(result.output).toBe("Backfill endpoint answered HTTP 200\n");
      expect(result.output).not.toContain(SECRET);
    });

    it("fails the job on anything but 2xx (a redirect, an HTTP error) and when the secrets are missing", () => {
      expect(runStep({ APP_URL: "https://clinic.example", CRON_SECRET: SECRET, FAKE_STATUS: "302" })).toMatchObject({ status: 1, output: expect.stringContaining("::error::") });
      expect(runStep({ APP_URL: "https://clinic.example", CRON_SECRET: SECRET, FAKE_STATUS: "401", FAKE_EXIT: "22" }).status).not.toBe(0);
      const missing = runStep({ APP_URL: "", CRON_SECRET: "", FAKE_STATUS: "200" });
      expect(missing).toMatchObject({ status: 1, output: expect.stringContaining("Set the repository secrets APP_URL and CRON_SECRET") });
    });
  });
});
