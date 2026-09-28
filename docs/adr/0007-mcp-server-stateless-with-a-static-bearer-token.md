# The MCP server is stateless, opened by one static bearer token, and runs every tool read-only

Claude reaches the clinic's data through `/api/mcp` on the same Vercel deployment (spec stories
60–65). Three choices shape it.

**Stateless Streamable HTTP.** Every POST gets a fresh MCP server and transport (official SDK,
`sessionIdGenerator: undefined`, JSON answers instead of an SSE stream); GET and DELETE are 405.
Serverless instances share no memory, so sessions would need a store, and none of our tools
streams or calls back to the client. Any client that speaks Streamable HTTP works unchanged.

**One static bearer token (`MCP_BEARER_TOKEN`), not OAuth.** The owner is the only user of the
MCP server and connects a handful of clients (Claude Code, a custom connector). OAuth 2.1 with
dynamic client registration would add an authorization server, token storage and a consent screen
for one person. The token is compared in constant time; a missing, blank or short (< 32
characters) token refuses every request (fail closed), so forgetting the env var never opens the
endpoint. Consequence: whoever holds the token reads all clinic data, rotation means a new env
value plus updating each client (older Vercel deployments keep the old value, so Deployment
Protection must stay on or they must be deleted), and connectors that only support OAuth cannot
connect. `/api/mcp` is public as that exact path only (`PUBLIC_EXACT_PATHS`), never its sub-paths. Adding
OAuth later means a new auth check in `src/mcp/auth.ts`; the tools do not change.

**Read-only by construction, three times over.** Tools only call Analytics Service reads (no SQL,
no raw-SQL tool, nothing reaches Kreloses); the registry wraps every call in a `READ ONLY,
REPEATABLE READ` transaction, so even a buggy tool cannot write and all of one answer's queries see
one snapshot; and tests checksum every table around calls to every tool. A separate read-only
database role for the MCP route would be a fourth layer, but needs a second connection string in
production; not done yet.

Because Claude Code cuts tool descriptions (and server instructions) after 2,048 characters, a
description quotes only its key `METRIC_DEFINITIONS` verbatim, and every result carries all of the
definitions its numbers use, verbatim, next to the data freshness per branch.
