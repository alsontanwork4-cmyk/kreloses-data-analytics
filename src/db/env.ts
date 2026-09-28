/** Supabase's transaction-mode pooler (Supavisor) listens on this port; it cannot use prepared statements. */
export const TRANSACTION_POOLER_PORT = "6543";

/**
 * App database settings from the environment:
 * - `DATABASE_URL` (required)
 * - `DATABASE_PREPARE` — "true"/"false"; defaults to false on port 6543, true otherwise
 * - `DATABASE_POOL_MAX` — pool size per server instance (default 3)
 */
export function sqlOptionsFromEnv(env: Record<string, string | undefined>): {
  url: string;
  prepare: boolean;
  max: number;
} {
  const url = env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env.local (see README) and point it at a database.",
    );
  }
  const explicit = env.DATABASE_PREPARE?.trim().toLowerCase();
  const prepare =
    explicit === "true" || explicit === "false"
      ? explicit === "true"
      : new URL(url).port !== TRANSACTION_POOLER_PORT;
  const max = Number(env.DATABASE_POOL_MAX);
  return { url, prepare, max: Number.isInteger(max) && max > 0 ? max : 3 };
}
