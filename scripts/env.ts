import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/** Loads `.env.local` then `.env` into process.env (existing variables win), like Next.js does. */
export function loadLocalEnv(): void {
  for (const file of [".env.local", ".env"]) {
    if (existsSync(file)) process.loadEnvFile(file);
  }
}

/** Sets `KEY=value` lines in an env file, replacing existing keys and keeping everything else. */
export function upsertEnvFile(file: string, values: Record<string, string>): void {
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  const pending = new Map(Object.entries(values));
  const updated = lines.map((line) => {
    const key = /^\s*([A-Z0-9_]+)\s*=/.exec(line)?.[1];
    if (key && pending.has(key)) {
      const value = pending.get(key)!;
      pending.delete(key);
      return `${key}=${value}`;
    }
    return line;
  });
  while (updated.length > 0 && updated.at(-1) === "") updated.pop();
  for (const [key, value] of pending) updated.push(`${key}=${value}`);
  writeFileSync(file, `${updated.join("\n")}\n`);
}

/** API URL and publishable key of the running local Supabase stack (`supabase status`). */
export function localSupabaseAuthEnv(): { url: string; publishableKey: string } {
  const output = execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const status = JSON.parse(output.slice(output.indexOf("{"))) as Record<string, string>;
  const url = status.API_URL;
  const publishableKey = status.PUBLISHABLE_KEY;
  if (!url || !publishableKey) throw new Error("`supabase status` did not report API_URL / PUBLISHABLE_KEY");
  return { url, publishableKey };
}
