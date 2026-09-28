import { describe, expect, it } from "vitest";

import { checkMcpBearerToken, MIN_MCP_TOKEN_LENGTH } from "./auth";

const TOKEN = "test-token-0123456789abcdefghijklmnopqrstuv"; // 42 characters, like `openssl rand -base64 32`

const request = (authorization?: string) =>
  new Request("http://localhost/api/mcp", { method: "POST", headers: authorization === undefined ? {} : { Authorization: authorization } });

async function refusal(response: Response | null) {
  expect(response).not.toBeNull();
  return { status: response!.status, wwwAuthenticate: response!.headers.get("WWW-Authenticate"), body: await response!.text() };
}

describe("MCP bearer token check", () => {
  it("lets a request with the right bearer token through", () => {
    expect(checkMcpBearerToken(request(`Bearer ${TOKEN}`), TOKEN)).toBeNull();
    expect(checkMcpBearerToken(request(`bearer ${TOKEN}`), TOKEN)).toBeNull(); // the scheme is case-insensitive
    expect(checkMcpBearerToken(request(`Bearer ${TOKEN}`), `${TOKEN}\n`)).toBeNull(); // a stray newline in the env value
  });

  it.each([
    ["no Authorization header", undefined],
    ["an empty header", ""],
    ["another scheme", `Basic ${Buffer.from(`owner:${TOKEN}`).toString("base64")}`],
    ["the scheme without a token", "Bearer "],
  ])("refuses %s with 401 and a Bearer challenge", async (_label, header) => {
    const answer = await refusal(checkMcpBearerToken(request(header), TOKEN));
    expect(answer.status).toBe(401);
    expect(answer.wwwAuthenticate).toBe('Bearer realm="kreloses-mcp"');
  });

  it.each([
    ["a wrong token", "Bearer wrong-token-0123456789abcdefghijklmnopqr"],
    ["a prefix of the token", `Bearer ${TOKEN.slice(0, -1)}`],
    ["the token with something added", `Bearer ${TOKEN}x`],
    ["the token in the wrong case", `Bearer ${TOKEN.toUpperCase()}`],
  ])("refuses %s with 401 invalid_token, never echoing the token", async (_label, header) => {
    const answer = await refusal(checkMcpBearerToken(request(header), TOKEN));
    expect(answer.status).toBe(401);
    expect(answer.wwwAuthenticate).toBe('Bearer realm="kreloses-mcp", error="invalid_token"');
    expect(answer.body).not.toContain(TOKEN.slice(0, 8));
    expect(answer.body).not.toContain(header.slice(7, 15));
  });

  it.each([
    ["not set", undefined],
    ["empty", ""],
    ["blank", "   "],
    ["too short to be a real secret", "x".repeat(MIN_MCP_TOKEN_LENGTH - 1)],
  ])("refuses every request when MCP_BEARER_TOKEN is %s (fail closed)", async (_label, configured) => {
    for (const header of [undefined, "Bearer ", `Bearer ${configured ?? ""}`, `Bearer ${TOKEN}`]) {
      const answer = await refusal(checkMcpBearerToken(request(header), configured));
      expect(answer.status).toBe(503);
      expect(JSON.parse(answer.body)).toMatchObject({ error: { message: expect.stringContaining("MCP_BEARER_TOKEN") } });
    }
  });
});
