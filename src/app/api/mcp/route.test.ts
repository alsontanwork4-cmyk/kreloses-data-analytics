import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DELETE, GET, POST } from "./route";

/** The route reads MCP_BEARER_TOKEN from the environment on every request (never cached). */
const TOKEN = "route-test-token-0123456789-abcdefghijklmnop";
const request = (method: string, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/mcp", {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: method === "POST" ? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) : undefined,
  });

describe("/api/mcp route", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses every request while MCP_BEARER_TOKEN is not set", async () => {
    vi.stubEnv("MCP_BEARER_TOKEN", "");
    for (const handler of [POST, GET, DELETE]) {
      expect((await handler(request("POST", { Authorization: `Bearer ${TOKEN}` }))).status).toBe(503);
    }
  });

  it("has no sub-routes: only /api/mcp itself skips the sign-in gate (PUBLIC_EXACT_PATHS)", () => {
    const entries = readdirSync(dirname(fileURLToPath(import.meta.url)), { withFileTypes: true });
    expect(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)).toEqual([]);
  });

  it("uses MCP_BEARER_TOKEN once set: no or a wrong token is 401; the right one gets past the gate", async () => {
    vi.stubEnv("MCP_BEARER_TOKEN", TOKEN);
    expect((await POST(request("POST"))).status).toBe(401);
    expect((await POST(request("POST", { Authorization: "Bearer wrong-token-0123456789-abcdefghijklmnopq" }))).status).toBe(401);
    // GET needs no database: past the gate it is simply not supported (stateless server).
    expect((await GET(request("GET", { Authorization: `Bearer ${TOKEN}` }))).status).toBe(405);
  });
});
