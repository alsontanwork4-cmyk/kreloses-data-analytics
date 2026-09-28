import { getDb } from "@/db/client";
import { clinicNow } from "@/lib/clinic-clock";
import { handleMcpRequest } from "@/mcp/handler";

/**
 * The read-only MCP server for Claude (spec stories 60–65; README "Connect Claude to the MCP
 * server"). Listed in `PUBLIC_EXACT_PATHS`: it does NOT use the dashboard's sign-in — it authenticates
 * every request itself with `Authorization: Bearer <MCP_BEARER_TOKEN>` (`src/mcp/auth.ts`).
 * "Today" is the dashboard's (`clinicNow`: the real clock in production), so e.g. `daily_sales`
 * defaults to the same yesterday as the Daily page.
 */
function handle(request: Request): Promise<Response> {
  return handleMcpRequest(request, { token: process.env.MCP_BEARER_TOKEN, sql: getDb, now: () => clinicNow() });
}

export const POST = handle;
// GET/DELETE are answered too (401/503 without the token, else 405: the server is stateless).
export const GET = handle;
export const DELETE = handle;
