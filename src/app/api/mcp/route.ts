import { getDb } from "@/db/client";
import { handleMcpRequest } from "@/mcp/handler";

/**
 * The read-only MCP server for Claude (spec stories 60–65; README "Connect Claude to the MCP
 * server"). Listed in `PUBLIC_EXACT_PATHS`: it does NOT use the dashboard's sign-in — it authenticates
 * every request itself with `Authorization: Bearer <MCP_BEARER_TOKEN>` (`src/mcp/auth.ts`).
 */
function handle(request: Request): Promise<Response> {
  return handleMcpRequest(request, { token: process.env.MCP_BEARER_TOKEN, sql: getDb });
}

export const POST = handle;
// GET/DELETE are answered too (401/503 without the token, else 405: the server is stateless).
export const GET = handle;
export const DELETE = handle;
