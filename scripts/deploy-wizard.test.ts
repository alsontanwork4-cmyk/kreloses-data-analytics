import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

/**
 * The production deploy wizard (`scripts/deploy-wizard.sh`, #7). It is never pointed at a real
 * service here: every CLI it drives (vercel, supabase, gh, openssl, curl, git, node, npm) is a
 * stand-in on PATH that records its arguments and stdin and answers from a scenario, and PATH holds
 * nothing else but a few local text tools, so nothing can reach the network. A small driver answers
 * the wizard's questions by their wording.
 */
const SCRIPT = fileURLToPath(new URL("./deploy-wizard.sh", import.meta.url));
const REPO = fileURLToPath(new URL("..", import.meta.url));
const BASH = "/bin/bash"; // the owner's macOS bash (3.2): the wizard must run on it

const VALUES = {
  VERCEL_TEAM: "example-team",
  NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic_0123456789",
  OWNER_EMAIL: "owner@example.test",
  SUPABASE_TRANSACTION_POOLER_URL:
    "postgresql://postgres.abcdefghijklmnopqrst:[YOUR-PASSWORD]@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres",
  SUPABASE_DB_PASSWORD: "p@ss w/rd:1+&=é",
  PRODUCTION_URL: "https://kreloses.example.test",
  GITHUB_OWNER: "example-owner",
};
const ENCODED_PASSWORD = "p%40ss%20w%2Frd%3A1%2B%26%3D%C3%A9";
const EXPECTED_DATABASE_URL = `postgresql://postgres.abcdefghijklmnopqrst:${ENCODED_PASSWORD}@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=require`;
const EXPECTED_SESSION_URL = `postgresql://postgres.abcdefghijklmnopqrst:${ENCODED_PASSWORD}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`;
const GH_TOKEN = "gho_SYNTHETIC_OWNER_TOKEN_0123456789";
// What the stand-in openssl prints, call by call (44 base64 characters, 64 hex digits).
const generated = (n: number, format: "base64" | "hex") =>
  format === "base64" ? `SYNTHb64secret${String(n).padStart(2, "0")}${"A".repeat(27)}=` : `5eed${String(n).padStart(2, "0")}${"0".repeat(58)}`;
const PRODUCTION_VARS = [
  "DATABASE_URL",
  "DATABASE_PREPARE",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "OWNER_EMAIL",
  "CREDENTIALS_ENCRYPTION_KEY",
  "CRON_SECRET",
  "MCP_BEARER_TOKEN",
];
const SENSITIVE = new Set(["DATABASE_URL", "CREDENTIALS_ENCRYPTION_KEY", "CRON_SECRET", "MCP_BEARER_TOKEN"]);
const PROJECT = {
  id: "prj_synthetic",
  name: "kreloses-data-analytics",
  framework: "nextjs",
  link: { type: "github", org: "example-owner", repo: "example-repo" },
  resourceConfig: { fluid: true },
};

// ── Stand-in CLIs ─────────────────────────────────────────────────────────────────────────────────
const LOG = `name=$(basename "$0")
S="$STUB_STATE"
stdin=""
log() { jq -nc --arg cmd "$name" --arg stdin "$stdin" --arg ghToken "\${GH_TOKEN:-}" '{cmd:$cmd, args:$ARGS.positional, stdin:$stdin, ghToken:$ghToken}' --args -- "$@" >> "$STUB_LOG"; }
`;
const STUBS: Record<string, string> = {
  vercel: `${LOG}
case "$1" in
  whoami) log "$@"; [ -f "$S/vercel-logged-in" ] || { echo "Error: No existing credentials found." >&2; exit 1; }; echo "example-owner" ;;
  teams) log "$@"; printf '  id            Team name\\n  example-team  Example Team\\n' ;;
  project) log "$@"; [ -f "$S/project-exists" ] || { echo "Error: Project not found" >&2; exit 1; }; echo "General" ;;
  api) log "$@"
    case "$2" in
      /v9/projects/*) [ -f "$S/project-exists" ] || { echo '{"error":{"code":"not_found"}}'; exit 1; }; cat "$S/project.json" ;;
      /v13/deployments/*) echo '{"alias":["kreloses-data-analytics-example-team.vercel.app","kreloses.example.test"]}' ;;
      *) exit 97 ;;
    esac ;;
  link) log "$@"; mkdir -p .vercel
    printf '{"projectId":"prj_synthetic","orgId":"team_synthetic","projectName":"kreloses-data-analytics"}' > .vercel/project.json
    touch "$S/project-exists"; [ -f "$S/project.json" ] || cp "$S/project-after-link.json" "$S/project.json" ;;
  env)
    case "$2" in
      list|ls) log "$@"; [ -f "$S/project-exists" ] || { echo "Error: Project not found" >&2; exit 1; }; cat "$S/env.json" 2>/dev/null || echo '{"envs":[]}' ;;
      add) stdin=$(cat); log "$@"; [ -f "$S/env.json" ] || echo '{"envs":[]}' > "$S/env.json"
        jq --arg k "$3" '.envs += [{key:$k, target:["production"], type:"sensitive"}]' "$S/env.json" > "$S/env.tmp" && mv "$S/env.tmp" "$S/env.json" ;;
      rm) log "$@"; jq --arg k "$3" '.envs |= map(select(.key != $k))' "$S/env.json" > "$S/env.tmp" && mv "$S/env.tmp" "$S/env.json" ;;
      *) log "$@"; exit 97 ;;
    esac ;;
  deploy) log "$@"; touch "$S/site-up"; echo "Building..." >&2; echo "https://kreloses-data-analytics-abc123-example-team.vercel.app" ;;
  crons) log "$@"; echo "  /api/cron/nightly   0 19 * * *" ;;
  git) log "$@" ;;
  *) log "$@"; echo "stand-in vercel: unexpected $*" >&2; exit 97 ;;
esac`,
  supabase: `${LOG}
log "$@"
[ "$1 $2" = "db push" ] || exit 97
for a in "$@"; do [ "$a" = --dry-run ] && dry=1; done
if [ -n "$dry" ]; then
  echo "DRY RUN: migrations will *not* be pushed to the database." >&2
  if [ -f "$S/migrations-applied" ]; then echo "Remote database is up to date."
  else echo "Would push these migrations:" >&2; echo " • 20260928003800_app_users.sql" >&2; fi
  exit 0
fi
touch "$S/migrations-applied"; echo "Applying migration 20260928003800_app_users.sql..." >&2`,
  gh: `${LOG}
case "$1 $2" in
  "auth token") log "$@"; [ -f "$S/gh-logged-in" ] || { echo "no oauth token" >&2; exit 1; }; echo "${GH_TOKEN}" ;;
  "secret list") log "$@"; cat "$S/gh-secrets" 2>/dev/null; true ;;
  "secret set") stdin=$(cat); log "$@"; printf '%s\\t2026-09-30\\n' "$3" >> "$S/gh-secrets" ;;
  "variable list") log "$@"; cat "$S/gh-variables" 2>/dev/null; true ;;
  "variable set") log "$@"; printf '%s\\t%s\\t2026-09-30\\n' "$3" "$5" >> "$S/gh-variables" ;;
  "workflow run") log "$@" ;;
  *) log "$@"; exit 97 ;;
esac`,
  openssl: `${LOG}
log "$@"
n=$(( $(cat "$S/openssl-count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$S/openssl-count"
case "$2" in
  -base64) printf 'SYNTHb64secret%02d%s=\\n' "$n" "${"A".repeat(27)}" ;;
  -hex) printf '5eed%02d%s\\n' "$n" "${"0".repeat(58)}" ;;
  *) exit 97 ;;
esac`,
  curl: `${LOG}
log "$@"
out=""; hdr=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    -D) hdr="$2"; shift ;;
    -w|-X|-H|--data|--max-time|--proto) shift ;;
    -*) ;;
    *) url="$1" ;;
  esac
  shift
done
if [ ! -f "$S/site-up" ]; then echo "curl: (6) Could not resolve host" >&2; printf 000; exit 6; fi
rest="\${url#*://}"; host="\${rest%%/*}"; path="/\${rest#*/}"; [ "$rest" = "$host" ] && path="/"
status=404; headers=""; body="not found"
case "$url" in
  http://*) status=308; headers="location: https://$rest" ;;
  *) case "$path" in
       /login) status=200; body="<html><h1>Kreloses Analytics</h1></html>" ;;
       /overview) status=307; headers="location: /login?next=%2Foverview" ;;
       /api/cron/nightly|/api/cron/backfill) status=401; body='{"error":"unauthorized"}'
         [ -f "$S/cron-behind-gate" ] && body='{"error":"unauthenticated"}' ;;
       /api/mcp) if [ -f "$S/mcp-unconfigured" ]; then status=503; body='{"jsonrpc":"2.0"}'
                 else status=401; headers='www-authenticate: Bearer realm="kreloses-mcp"'; body='{"jsonrpc":"2.0"}'; fi ;;
     esac ;;
esac
[ -n "$hdr" ] && printf 'HTTP/2 %s\\r\\n%s\\r\\n\\r\\n' "$status" "$headers" > "$hdr"
[ -n "$out" ] && printf '%s' "$body" > "$out"
printf '%s' "$status"`,
  git: `${LOG}
[ "$1" = -C ] && shift 2
log "$@"
case "$1" in
  rev-parse) if [ "$2" = --abbrev-ref ]; then echo main; else echo 0123456789abcdef0123456789abcdef01234567; fi ;;
  status|fetch) ;;
  remote) echo "https://github.com/example-owner/example-repo.git" ;;
  *) exit 97 ;;
esac`,
  node: `${LOG}
log "$@"
echo v22.12.0`,
  npm: `${LOG}
log "$@"`,
};
// Local text tools only: nothing that can open a connection or a browser.
const SAFE_TOOLS = ["awk", "basename", "cat", "chmod", "cp", "cut", "dirname", "grep", "head", "jq", "mkdir", "mktemp", "mv", "rm", "sed", "sort", "tail", "touch", "tr", "uniq", "wc"];

function findTool(tool: string): string {
  const dirs = ["/usr/bin", "/bin", ...(process.env.PATH ?? "").split(":")];
  for (const dir of dirs) if (dir && existsSync(join(dir, tool))) return join(dir, tool);
  throw new Error(`${tool} not found`);
}

interface Scenario {
  vercelLoggedIn?: boolean;
  ghLoggedIn?: boolean;
  projectExists?: boolean;
  linked?: boolean;
  envKeys?: string[];
  migrationsApplied?: boolean;
  siteUp?: boolean;
  ghSecrets?: string[];
  ghVariables?: Record<string, string>;
  backfillWorkflow?: boolean;
  flags?: string[];
}

interface Call {
  cmd: string;
  args: string[];
  stdin: string;
  ghToken: string;
}

const sandboxes: string[] = [];
afterAll(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

function sandbox(scenario: Scenario) {
  const dir = mkdtempSync(join(tmpdir(), "kx-deploy-wizard-"));
  sandboxes.push(dir);
  const [bin, safe, root, home, state, tmp] = ["bin", "safe", "root", "home", "state", "tmp"].map((name) => join(dir, name));
  for (const path of [bin, safe, root, home, state, tmp]) mkdirSync(path);
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  for (const tool of SAFE_TOOLS) symlinkSync(findTool(tool), join(safe, tool));
  // The checkout: the real code (for the environment-variable scan, templates and routes).
  for (const name of ["src", "scripts", "supabase"]) symlinkSync(join(REPO, name), join(root, name));
  copyFileSync(join(REPO, "next.config.ts"), join(root, "next.config.ts"));
  if (scenario.backfillWorkflow ?? true) {
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(join(root, ".github", "workflows", "backfill.yml"), "name: History backfill\n");
  }
  if (scenario.linked) {
    mkdirSync(join(root, ".vercel"));
    writeFileSync(join(root, ".vercel", "project.json"), JSON.stringify({ projectId: PROJECT.id, orgId: "team_synthetic" }));
  }
  const flag = (name: string, on: boolean | undefined) => on && writeFileSync(join(state, name), "");
  flag("vercel-logged-in", scenario.vercelLoggedIn ?? true);
  flag("gh-logged-in", scenario.ghLoggedIn ?? true);
  flag("project-exists", scenario.projectExists);
  flag("migrations-applied", scenario.migrationsApplied);
  flag("site-up", scenario.siteUp);
  for (const name of scenario.flags ?? []) flag(name, true);
  writeFileSync(join(state, "project-after-link.json"), JSON.stringify(PROJECT));
  if (scenario.projectExists) writeFileSync(join(state, "project.json"), JSON.stringify(PROJECT));
  if (scenario.envKeys) {
    writeFileSync(join(state, "env.json"), JSON.stringify({ envs: scenario.envKeys.map((key) => ({ key, target: ["production"], type: "sensitive" })) }));
  }
  if (scenario.ghSecrets) writeFileSync(join(state, "gh-secrets"), scenario.ghSecrets.map((name) => `${name}\t2026-09-01\n`).join(""));
  if (scenario.ghVariables) {
    writeFileSync(join(state, "gh-variables"), Object.entries(scenario.ghVariables).map(([name, value]) => `${name}\t${value}\t2026-09-01\n`).join(""));
  }
  const log = join(dir, "calls.jsonl");
  writeFileSync(log, "");
  return {
    dir,
    root,
    home,
    state,
    saveFile: join(home, ".config", "kreloses-data-analytics", "production.env"),
    vars: {
      NODE_ENV: "test" as const,
      PATH: `${bin}:${safe}`,
      HOME: home,
      TMPDIR: tmp,
      STUB_LOG: log,
      STUB_STATE: state,
      DEPLOY_WIZARD_ROOT: root,
      VERCEL_GLOBAL_CONFIG: join(home, ".vercel-owner"),
      WIZARD_NO_BROWSER: "1",
    } as { NODE_ENV: "test" } & Record<string, string>,
    calls(): Call[] {
      return readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Call);
    },
    resetCalls() {
      writeFileSync(log, "");
    },
  };
}
type Sandbox = ReturnType<typeof sandbox>;

interface Run {
  status: number | null;
  output: string;
  prompts: string[];
}

/**
 * Runs the wizard and answers its questions by their wording: `[y/N]` questions from `answers`
 * (first match) or `defaultAnswer`; other prompts (Enter to continue, a value with a default) with "".
 */
function runWizard(sb: Sandbox, args: string[], options: { answers?: [RegExp, string][]; defaultAnswer?: "y" | "n"; env?: Record<string, string> } = {}): Promise<Run> {
  const { answers = [], defaultAnswer = "y", env = {} } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(BASH, [SCRIPT, ...args], { cwd: sb.root, env: { ...sb.vars, ...VALUES, ...env } });
    let output = "";
    let answeredAt = -1;
    let quiet: NodeJS.Timeout | undefined;
    const prompts: string[] = [];
    const answer = () => {
      const tail = output.slice(output.lastIndexOf("\n") + 1);
      if (!tail.endsWith(" ") || tail.trim() === "" || answeredAt === output.length) return;
      answeredAt = output.length;
      const question = tail.trim();
      prompts.push(question);
      const rule = answers.find(([pattern]) => pattern.test(question));
      const reply = rule ? rule[1] : /\[y\/N\]$/.test(question) ? defaultAnswer : "";
      child.stdin.write(`${reply}\n`);
    };
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      clearTimeout(quiet);
      quiet = setTimeout(answer, 60);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`the wizard did not finish; output so far:\n${output}`));
    }, 45_000);
    child.on("close", (status) => {
      clearTimeout(timeout);
      clearTimeout(quiet);
      resolve({ status, output, prompts });
    });
  });
}

const MUTATING: [string, (args: string[]) => boolean][] = [
  ["vercel", (args) => ["link", "deploy"].includes(args[0]!) || (args[0] === "env" && ["add", "rm", "update", "remove"].includes(args[1]!)) || args[0] === "git"],
  ["supabase", (args) => args[0] === "db" && args[1] === "push" && !args.includes("--dry-run")],
  ["gh", (args) => ["secret set", "variable set", "workflow run"].includes(`${args[0]} ${args[1]}`)],
  ["openssl", () => true],
  ["npm", () => true],
];
const isMutating = (call: Call) => MUTATING.some(([cmd, test]) => call.cmd === cmd && test(call.args));
const describeCall = (call: Call) => `${call.cmd} ${call.args.filter((arg) => !arg.startsWith("/")).join(" ")}`;
// (Piped answers are not echoed, so a line printed right after a question shares its line.)
const plannedLines = (output: string) =>
  output
    .split("\n")
    .filter((line) => line.includes("[dry-run]"))
    .map((line) => line.slice(line.indexOf("[dry-run]") + "[dry-run]".length).trim());
const envAdds = (calls: Call[]) => calls.filter((call) => call.cmd === "vercel" && call.args[0] === "env" && call.args[1] === "add");

const SECRET_VALUES = [VALUES.SUPABASE_DB_PASSWORD, ENCODED_PASSWORD, GH_TOKEN, generated(1, "base64"), generated(2, "hex"), generated(3, "base64")];
function expectNoSecrets(text: string) {
  for (const secret of SECRET_VALUES) expect(text, `printed a secret: ${secret}`).not.toContain(secret);
}

describe("the deploy wizard, --dry-run", () => {
  it("changes nothing: read-only checks reach the stand-in CLIs, and every change is printed in order instead", async () => {
    const sb = sandbox({ projectExists: false });
    const run = await runWizard(sb, ["--dry-run"]);
    expect(run.status, run.output).toBe(0);

    const calls = sb.calls();
    expect(calls.filter(isMutating).map(describeCall)).toEqual([]);
    // Every command went to a stand-in (PATH holds nothing else), and HTTP only to the production URL.
    expect(new Set(calls.map((call) => call.cmd))).toEqual(new Set(["git", "node", "vercel", "supabase", "curl", "gh"]));
    for (const call of calls.filter((c) => c.cmd === "curl")) {
      expect(call.args.at(-1)).toMatch(/^https?:\/\/kreloses\.example\.test\//);
    }
    // The read-only checks did run.
    expect(calls.map(describeCall)).toEqual(
      expect.arrayContaining(["vercel whoami --global-config", "gh auth token --user example-owner", `supabase db push --db-url ${EXPECTED_SESSION_URL} --dry-run`]),
    );

    const flags = `--global-config ${sb.vars.VERCEL_GLOBAL_CONFIG} --scope example-team`;
    const project = "--project kreloses-data-analytics";
    const hidden = "< (value on stdin, hidden)";
    const asOwner = "GH_TOKEN=$(gh auth token --user example-owner) ";
    expect(plannedLines(run.output)).toEqual([
      "npm ci",
      "npm run typecheck",
      "npm test",
      `vercel link --yes ${project} ${flags}`,
      "openssl rand -base64 32   (the new CREDENTIALS_ENCRYPTION_KEY, kept in memory, never shown)",
      "openssl rand -hex 32   (the new CRON_SECRET, kept in memory, never shown)",
      "openssl rand -base64 32   (the new MCP_BEARER_TOKEN, kept in memory, never shown)",
      `save the values below to ${sb.saveFile} (chmod 600, outside the repository)`,
      ...PRODUCTION_VARS.map((name) => `vercel env add ${name} production ${SENSITIVE.has(name) ? "--sensitive" : "--no-sensitive"} --yes ${project} ${flags} ${hidden}`),
      // Which database gets written stays visible; the password does not.
      `supabase db push --db-url ${EXPECTED_SESSION_URL.replace(ENCODED_PASSWORD, "<hidden>")} --yes`,
      `vercel deploy --prod --yes ${project} ${flags}`,
      `${asOwner}gh secret set APP_URL --repo example-owner/example-repo ${hidden}`,
      `${asOwner}gh secret set CRON_SECRET --repo example-owner/example-repo ${hidden}`,
      `${asOwner}gh variable set BACKFILL_ENABLED --body true --repo example-owner/example-repo`,
      `${asOwner}gh workflow run backfill.yml --repo example-owner/example-repo`,
    ]);
    expect(run.output).toContain("Dry run: nothing was changed.");
    expectNoSecrets(run.output);
    expect(existsSync(sb.saveFile)).toBe(false);
    expect(existsSync(join(sb.root, ".vercel"))).toBe(false);
  });
});

describe("the deploy wizard, for real (against stand-in CLIs)", () => {
  it("does every step in order on a first run, passing each secret only on stdin and never printing one", async () => {
    const sb = sandbox({ projectExists: false });
    const run = await runWizard(sb, []);
    expect(run.status, run.output).toBe(0);
    const calls = sb.calls();

    expect(calls.filter(isMutating).map((call) => `${call.cmd} ${call.args.slice(0, 3).join(" ")}`)).toEqual([
      "npm ci",
      "npm run typecheck",
      "npm test",
      "vercel link --yes --project",
      "openssl rand -base64 32",
      "openssl rand -hex 32",
      "openssl rand -base64 32",
      ...PRODUCTION_VARS.map((name) => `vercel env add ${name}`),
      "supabase db push --db-url",
      "vercel deploy --prod --yes",
      "gh secret set APP_URL",
      "gh secret set CRON_SECRET",
      "gh variable set BACKFILL_ENABLED",
      "gh workflow run backfill.yml",
    ]);

    // Vercel: production only, sensitive where secret, the value on stdin and never in the arguments.
    const expectedValues: Record<string, string> = {
      DATABASE_URL: EXPECTED_DATABASE_URL,
      DATABASE_PREPARE: "false",
      NEXT_PUBLIC_SUPABASE_URL: VALUES.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: VALUES.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      OWNER_EMAIL: VALUES.OWNER_EMAIL,
      CREDENTIALS_ENCRYPTION_KEY: generated(1, "base64"),
      CRON_SECRET: generated(2, "hex"),
      MCP_BEARER_TOKEN: generated(3, "base64"),
    };
    for (const call of envAdds(calls)) {
      const name = call.args[2]!;
      expect(call.args).toEqual([
        "env", "add", name, "production", SENSITIVE.has(name) ? "--sensitive" : "--no-sensitive", "--yes",
        "--project", "kreloses-data-analytics", "--global-config", sb.vars.VERCEL_GLOBAL_CONFIG, "--scope", "example-team",
      ]);
      expect(call.stdin, name).toBe(expectedValues[name]);
    }
    // Migrations: a read-only dry run first, through the session pooler (5432), password percent-encoded.
    const pushes = calls.filter((call) => call.cmd === "supabase");
    expect(pushes.map((call) => call.args)).toEqual([
      ["db", "push", "--db-url", EXPECTED_SESSION_URL, "--dry-run"],
      ["db", "push", "--db-url", EXPECTED_SESSION_URL, "--yes"],
    ]);
    // GitHub, as the repository owner: APP_URL and the app's own CRON_SECRET, then the opt-in switch.
    const gh = calls.filter((call) => call.cmd === "gh" && call.args[0] !== "auth");
    for (const call of gh) expect(call.ghToken).toBe(GH_TOKEN);
    expect(gh.find((call) => call.args[2] === "APP_URL")?.stdin).toBe(VALUES.PRODUCTION_URL);
    expect(gh.find((call) => call.args[1] === "set" && call.args[2] === "CRON_SECRET")?.stdin).toBe(generated(2, "hex"));
    expect(gh.find((call) => call.args[0] === "variable" && call.args[1] === "set")?.args).toEqual([
      "variable", "set", "BACKFILL_ENABLED", "--body", "true", "--repo", "example-owner/example-repo",
    ]);
    // No secret in any argument except the migration's --db-url (the Supabase CLI takes no other form).
    for (const call of calls.filter((c) => c.cmd !== "supabase")) {
      for (const secret of [...SECRET_VALUES, EXPECTED_DATABASE_URL]) expect(call.args.join(" ")).not.toContain(secret);
    }

    expectNoSecrets(run.output);
    expect(run.output).not.toContain(EXPECTED_DATABASE_URL);
    expect(run.output).toContain("✓ /login renders the sign-in page");
    expect(run.output).toContain("✓ /api/mcp answers 401 without the token");
    expect(run.output).toContain("Vercel Cron lists /api/cron/nightly");

    // The owner's copy: outside the repository, readable only by them, with the MCP token for Claude.
    expect(statSync(sb.saveFile).mode & 0o777).toBe(0o600);
    const saved = readFileSync(sb.saveFile, "utf8");
    expect(saved).toContain(`MCP_BEARER_TOKEN=${generated(3, "base64")}\n`);
    expect(saved).toContain(`CREDENTIALS_ENCRYPTION_KEY=${generated(1, "base64")}\n`);
    expect(saved).toContain(`PRODUCTION_URL=${VALUES.PRODUCTION_URL}\n`);
    expect(saved).not.toContain(VALUES.SUPABASE_DB_PASSWORD);
    expect(saved).not.toContain(ENCODED_PASSWORD);
    expect(readdirSync(sb.root).filter((name) => name.startsWith(".env"))).toEqual([]);
  });

  it("is idempotent: a second run finds every step done and changes nothing", async () => {
    const sb = sandbox({ projectExists: false });
    expect((await runWizard(sb, [])).status).toBe(0);
    sb.resetCalls();

    const again = await runWizard(sb, [], {
      answers: [
        [/Run npm ci/, "n"],
        [/Deploy again anyway/, "n"],
        [/Replace it/, "n"],
        [/Run the backfill workflow once/, "n"],
      ],
    });
    expect(again.status, again.output).toBe(0);
    expect(sb.calls().filter(isMutating).map(describeCall)).toEqual([]);
    expect(again.output).toContain(`Using the values saved in ${sb.saveFile}`);
    expect(again.output).toContain("CREDENTIALS_ENCRYPTION_KEY is already set in Vercel: kept");
    expect(again.output).toContain("the production database is up to date");
    expect(again.output).toContain("GitHub variable BACKFILL_ENABLED is already true");
    expect(again.output).toMatch(/Still to do \(0\)/);
    expectNoSecrets(again.output);
  });

  it("never replaces or re-adds an existing CREDENTIALS_ENCRYPTION_KEY, and never takes one from your shell", async () => {
    const localKey = "LOCAL-dev-key-from-the-shell-0123456789abcdef=";
    const sb = sandbox({ projectExists: true, linked: true, envKeys: ["CREDENTIALS_ENCRYPTION_KEY"] });
    const run = await runWizard(sb, [], { env: { CREDENTIALS_ENCRYPTION_KEY: localKey, CRON_SECRET: "shell-cron-secret-0123456789", MCP_BEARER_TOKEN: "shell-mcp-token-0123456789abcdefghijklmnop" } });
    expect(run.status, run.output).toBe(0);
    const calls = sb.calls();

    expect(calls.filter((call) => call.cmd === "openssl").map((call) => call.args)).toEqual([
      ["rand", "-hex", "32"],
      ["rand", "-base64", "32"],
    ]);
    expect(envAdds(calls).map((call) => call.args[2])).toEqual(PRODUCTION_VARS.filter((name) => name !== "CREDENTIALS_ENCRYPTION_KEY"));
    const touchingKey = calls.filter((call) => call.args.includes("CREDENTIALS_ENCRYPTION_KEY"));
    expect(touchingKey).toEqual([]);
    expect(calls.some((call) => call.stdin.includes(localKey) || call.stdin.includes("shell-cron-secret") || call.stdin.includes("shell-mcp-token"))).toBe(false);
    expect(envAdds(calls).find((call) => call.args[2] === "CRON_SECRET")?.stdin).toBe(generated(1, "hex"));
    expect(run.output).toContain("CREDENTIALS_ENCRYPTION_KEY is already set in Vercel: kept (never replaced");
    expect(run.output).not.toContain(localKey);
    expect(readFileSync(sb.saveFile, "utf8")).not.toContain("CREDENTIALS_ENCRYPTION_KEY=");
  });

  it("--rotate replaces the MCP token (remove, add the new one, redeploy) and refuses the encryption key", async () => {
    const configured = {
      projectExists: true, linked: true, envKeys: PRODUCTION_VARS, migrationsApplied: true, siteUp: true,
      ghSecrets: ["APP_URL", "CRON_SECRET"], ghVariables: { BACKFILL_ENABLED: "true" },
    };
    const sb = sandbox(configured);
    const run = await runWizard(sb, ["--rotate", "MCP_BEARER_TOKEN"], {
      answers: [[/Run npm ci/, "n"], [/Save a copy/, "n"], [/Replace it/, "n"], [/Run the backfill workflow once/, "n"]],
    });
    expect(run.status, run.output).toBe(0);
    const changes = sb.calls().filter(isMutating);
    expect(changes.map((call) => `${call.cmd} ${call.args.slice(0, 3).join(" ")}`)).toEqual([
      "openssl rand -base64 32",
      "vercel env rm MCP_BEARER_TOKEN",
      "vercel env add MCP_BEARER_TOKEN",
      "vercel deploy --prod --yes",
    ]);
    expect(changes[2]!.stdin).toBe(generated(1, "base64"));
    expect(run.output).not.toContain(generated(1, "base64"));

    const refused = sandbox(configured);
    const key = spawnSync(BASH, [SCRIPT, "--rotate", "CREDENTIALS_ENCRYPTION_KEY"], { encoding: "utf8", env: { ...refused.vars, ...VALUES } });
    expect(key.status).toBe(2);
    expect(key.stderr).toContain("CREDENTIALS_ENCRYPTION_KEY is never rotated by this wizard");
    expect(refused.calls()).toEqual([]);
  });

  it("stops at the backfill stage without touching GitHub while #8 is not merged", async () => {
    const sb = sandbox({
      projectExists: true, linked: true, envKeys: PRODUCTION_VARS, migrationsApplied: true, siteUp: true, backfillWorkflow: false,
    });
    const run = await runWizard(sb, [], { answers: [[/Run npm ci/, "n"], [/Deploy again anyway/, "n"]] });
    expect(run.status, run.output).toBe(0);
    expect(sb.calls().filter((call) => call.cmd === "gh")).toEqual([]);
    expect(sb.calls().filter(isMutating)).toEqual([]);
    expect(run.output).toContain("The history backfill (#8) is not on main yet");
  });

  it("refuses to deploy a checkout that is not a clean, up-to-date main (but a dry run only warns)", async () => {
    const sb = sandbox({ projectExists: true });
    writeFileSync(
      join(sb.dir, "bin", "git"),
      `#!/bin/bash\n${LOG}\n[ "$1" = -C ] && shift 2\nlog "$@"\ncase "$1" in rev-parse) [ "$2" = --abbrev-ref ] && echo feature || echo 1111111111111111111111111111111111111111 ;; status) echo " M src/app/page.tsx" ;; remote) echo "https://github.com/example-owner/example-repo.git" ;; esac\n`,
    );
    const run = await runWizard(sb, []);
    expect(run.status).toBe(1);
    expect(run.output).toContain("on branch 'feature', not main");
    expect(run.output).toContain("uncommitted changes");
    expect(run.output).toContain("Deploy only the latest main");
    expect(sb.calls().filter(isMutating)).toEqual([]);

    const dry = await runWizard(sb, ["--dry-run"]);
    expect(dry.status, dry.output).toBe(0);
    expect(dry.output).toContain("deploy from a clean, up-to-date main");
  });
});

describe("the deploy wizard, --check", () => {
  it("passes against a healthy deployment, sending no secret", async () => {
    const sb = sandbox({ siteUp: true });
    const run = await runWizard(sb, ["--check", VALUES.PRODUCTION_URL]);
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("✓ plain HTTP redirects to HTTPS");
    expect(run.output).toContain("✓ /login renders the sign-in page");
    expect(run.output).toContain("✓ signed-out visitors are sent to /login");
    expect(run.output).toContain("✓ /api/cron/nightly answers 401 without the cron secret");
    expect(run.output).toContain("All checks passed.");
    for (const call of sb.calls()) expect(call.args.join(" ")).not.toMatch(/authorization/i);
  });

  it("fails loudly when the MCP token is missing on the server, a cron route is behind the sign-in gate, or the site is down", async () => {
    const broken = sandbox({ siteUp: true, flags: ["mcp-unconfigured", "cron-behind-gate"] });
    const run = await runWizard(broken, ["--check", VALUES.PRODUCTION_URL]);
    expect(run.status).toBe(1);
    expect(run.output).toContain("/api/mcp answered 503: MCP_BEARER_TOKEN is not set on the server");
    expect(run.output).toContain("/api/cron/nightly is behind the sign-in gate");

    const down = await runWizard(sandbox({ siteUp: false }), ["--check", VALUES.PRODUCTION_URL]);
    expect(down.status).toBe(1);
    expect(down.output).toContain("is not reachable");

    const plain = await runWizard(sandbox({ siteUp: true }), ["--check", "http://kreloses.example.test"]);
    expect(plain.status).toBe(1);
    expect(plain.output).toContain("is not HTTPS");
  });
});

describe("environment variables: the wizard's list covers the code", () => {
  const listed = spawnSync(BASH, [SCRIPT, "--list-env"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).map((line) => line.split(" "));
  const known = new Set(listed.map(([, name]) => name!));
  const production = listed.filter(([kind]) => kind === "production").map(([, name]) => name!);

  function codeFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : codeFiles(path);
      return /\.(ts|tsx|mts)$/.test(entry.name) ? [path] : [];
    });
  }
  // Every variable read from process.env or an env record (dot, optional-chain or bracket access)
  // in src/, scripts/ and next.config.ts.
  const readInCode = new Map<string, string>();
  for (const file of [...codeFiles(join(REPO, "src")), ...codeFiles(join(REPO, "scripts")), join(REPO, "next.config.ts")]) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/(?<![\w$])env\??\.([A-Z][A-Z0-9_]*)|(?<![\w$])env\[["'`]([A-Z][A-Z0-9_]*)["'`]\]/g)) {
      readInCode.set(match[1] ?? match[2]!, file.slice(REPO.length));
    }
  }

  it("names every variable the code reads (production, optional, local/test-only or platform)", () => {
    expect(readInCode.size).toBeGreaterThan(10);
    const unknown = [...readInCode].filter(([name]) => !known.has(name)).map(([name, file]) => `${name} (${file})`);
    expect(unknown).toEqual([]);
    expect(spawnSync(BASH, [SCRIPT, "--check-env"], { encoding: "utf8" }).status).toBe(0);
  });

  it("sets only variables the app actually reads in production", () => {
    for (const name of production) expect(readInCode.has(name), name).toBe(true);
  });

  it("names every variable in .env.example and in README's environment table", () => {
    const example = [...readFileSync(join(REPO, ".env.example"), "utf8").matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]!);
    expect(example.length).toBeGreaterThan(5);
    expect(example.filter((name) => !known.has(name))).toEqual([]);
    const readme = readFileSync(join(REPO, "README.md"), "utf8");
    const table = readme.slice(readme.indexOf("### Environment variables"), readme.indexOf("## Project layout"));
    const names = [...table.matchAll(/^\| ([^|]+)\|/gm)].flatMap((row) => [...row[1]!.matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((match) => match[1]!));
    expect(names.length).toBeGreaterThan(10);
    expect(names.filter((name) => !known.has(name))).toEqual([]);
  });

  it("--check-env fails, naming the variable, when the code reads one the wizard does not know", () => {
    const dir = mkdtempSync(join(tmpdir(), "kx-deploy-wizard-env-"));
    sandboxes.push(dir);
    mkdirSync(join(dir, "src", "lib"), { recursive: true });
    const unknownName = ["BRAND", "NEW", "SETTING"].join("_");
    writeFileSync(join(dir, "src", "lib", "x.ts"), `export const a = process.env.${unknownName};\nexport const b = env["OWNER_EMAIL"];\n`);
    const env = { NODE_ENV: "test" as const, PATH: process.env.PATH, HOME: dir, DEPLOY_WIZARD_ROOT: dir };
    const result = spawnSync(BASH, [SCRIPT, "--check-env"], { encoding: "utf8", env });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(unknownName);
    expect(result.stderr).not.toContain("OWNER_EMAIL");
  });
});

describe("the wizard script itself", () => {
  const source = readFileSync(SCRIPT, "utf8");

  it("parses with the owner's bash, and passes shellcheck when it is installed", () => {
    expect(spawnSync(BASH, ["-n", SCRIPT]).status).toBe(0);
    const shellcheck = spawnSync("shellcheck", ["--version"]);
    if (shellcheck.error) return; // not installed on this machine (the PR says so)
    const result = spawnSync("shellcheck", ["-S", "warning", SCRIPT], { encoding: "utf8" });
    expect(result.stdout).toBe("");
  });

  it("holds no secrets, project refs or emails (the repository is public)", () => {
    expect(source).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
    expect(source).not.toMatch(/sb_(publishable|secret)_[A-Za-z0-9]{8,}/);
    expect(source).not.toMatch(/https:\/\/[a-z0-9]{20}\.supabase\.co/);
    expect(source).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
    expect(source).not.toMatch(/gh[opsu]_[A-Za-z0-9]{20,}/);
  });

  it("keeps the wizard library verbatim, reads secrets hidden and never uses xtrace", () => {
    expect(source).toContain("# STAGES: author this section.");
    expect(source).toContain('read -rs value || answered=0');
    expect(source).not.toMatch(/^\s*set -[a-z]*x/m);
  });
});

describe(".vercelignore keeps local-only files out of `vercel deploy` uploads", () => {
  // The Vercel CLI matches .vercelignore with the `ignore` package (gitignore rules).
  const ignore = createRequire(import.meta.url)("ignore") as () => { add(rules: string): { ignores(path: string): boolean } };
  const rules = ignore().add(readFileSync(join(REPO, ".vercelignore"), "utf8"));

  it("excludes agent worktrees, env files and local build/test output", () => {
    for (const path of [
      ".claude/worktrees/agent-x/src/app/page.tsx",
      ".claude/settings.local.json",
      ".env",
      ".env.production",
      ".env.local",
      ".mcp.json",
      "server.pem",
      ".next-e2e/server/app.js",
      "test-results/report.json",
      "playwright-report/index.html",
      "supabase/.temp/project-ref",
    ]) {
      expect(rules.ignores(path), path).toBe(true);
    }
  });

  it("keeps everything the build needs", () => {
    for (const path of ["src/app/page.tsx", "package.json", "package-lock.json", "next.config.ts", "vercel.json", "tsconfig.json", ".env.example", "supabase/migrations/20260928003800_app_users.sql"]) {
      expect(rules.ignores(path), path).toBe(false);
    }
  });
});
