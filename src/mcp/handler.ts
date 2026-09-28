import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import type { Sql } from "@/db/sql";

import { checkMcpBearerToken } from "./auth";
import { createMcpServer } from "./server";

export interface McpHandlerDeps {
  /** `MCP_BEARER_TOKEN`: the one secret that opens the endpoint. Unset → every request refused. */
  token: string | undefined;
  /** The database, opened only once a request is authorised. */
  sql: () => Sql;
  /** The clock (defaults to the real time). */
  now?: () => Date;
}

/**
 * The remote MCP endpoint (`/api/mcp`): Streamable HTTP, STATELESS — every POST gets a fresh server
 * and transport, answers with plain JSON (no SSE stream, no session id), and is closed afterwards,
 * so it runs as an ordinary serverless function.
 *
 * 1. The bearer token is checked first, for every method (`checkMcpBearerToken`: 503 when the
 *    server has no token, 401 otherwise).
 * 2. Only POST carries MCP messages; GET (a server-to-client event stream) and DELETE (ending a
 *    session) have no meaning without sessions → 405, as the transport spec allows.
 */
export async function handleMcpRequest(request: Request, deps: McpHandlerDeps): Promise<Response> {
  const refused = checkMcpBearerToken(request, deps.token);
  if (refused) return refused;
  if (request.method !== "POST") {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this MCP server is stateless; send JSON-RPC messages with POST." }, id: null },
      { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } },
    );
  }

  const server = createMcpServer({ sql: deps.sql(), now: deps.now ?? (() => new Date()) });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    // JSON mode: the body is complete by now, so closing below cannot cut it short.
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } finally {
    await server.close();
  }
}
