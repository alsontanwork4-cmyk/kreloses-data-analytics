import { createHash, timingSafeEqual } from "node:crypto";

/**
 * A configured token shorter than this is treated as no token at all (every request refused):
 * generate one with `openssl rand -base64 32` (44 characters).
 */
export const MIN_MCP_TOKEN_LENGTH = 32;

const REALM = 'Bearer realm="kreloses-mcp"';

/**
 * The MCP endpoint's ONLY gate: `/api/mcp` is in `PUBLIC_EXACT_PATHS`, so the session proxy does not check
 * it. Returns null when the request carries `Authorization: Bearer <MCP_BEARER_TOKEN>`; otherwise
 * the response to send:
 *
 * - the server has no usable token (`configuredToken` unset, blank or shorter than
 *   `MIN_MCP_TOKEN_LENGTH`) → 503 for EVERY request (fail closed: a missing env var never opens
 *   the endpoint);
 * - no bearer token → 401 with `WWW-Authenticate: Bearer realm="kreloses-mcp"`;
 * - a wrong token → 401 with `…, error="invalid_token"` (RFC 6750).
 *
 * The comparison is constant-time (SHA-256 of both, then `timingSafeEqual`, so neither the content
 * nor the length leaks through timing). Tokens are never logged or echoed.
 */
export function checkMcpBearerToken(request: Request, configuredToken: string | undefined): Response | null {
  const expected = configuredToken?.trim() ?? "";
  if (expected.length < MIN_MCP_TOKEN_LENGTH) {
    return refuse(
      503,
      "The MCP server is not configured: set MCP_BEARER_TOKEN (at least 32 characters, e.g. `openssl rand -base64 32`) on the server.",
    );
  }
  const presented = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!presented) return refuse(401, "Missing bearer token: send `Authorization: Bearer <token>`.", REALM);
  if (!sameSecret(presented, expected)) return refuse(401, "Invalid bearer token.", `${REALM}, error="invalid_token"`);
  return null;
}

function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** A JSON-RPC error body (what MCP clients expect), never cached. */
function refuse(status: 401 | 503, message: string, challenge?: string): Response {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (challenge) headers["WWW-Authenticate"] = challenge;
  return Response.json({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }, { status, headers });
}
