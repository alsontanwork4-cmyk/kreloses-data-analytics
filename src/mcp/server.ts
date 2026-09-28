import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpToolContext } from "./tools/define";
import { MCP_TOOLS } from "./tools/index";
import { registerMcpTool } from "./tools/registry";

/** Kept under 2,048 characters: Claude Code cuts longer server instructions. */
export const SERVER_INSTRUCTIONS = [
  "Read-only analytics over a two-branch veterinary clinic's sales, synced from its point of sale (Kreloses) into the clinic's dashboard. These tools return exactly the dashboard's numbers, worked out the same way.",
  "- Money is RM, as exact decimal strings (\"1234.50\"). Dates are clinic days in Asia/Kuala_Lumpur, YYYY-MM-DD, inclusive; with no dates a tool answers month to date (daily_sales, which takes one day: yesterday).",
  "- Branches and doctors can be given by id or by name; an ambiguous name comes back as an error listing the candidates — ask the user which one they mean.",
  "- Every result has dataFreshness (data as of, per branch). Always tell the user how current the numbers are, and never present them as more current than that; a branch without a data-as-of time may be incomplete (see data_freshness).",
  "- Every result has definitions: how each number is worked out. Use them to explain numbers; revenue is credited per line to the staff named on it.",
].join("\n");

/**
 * A new MCP server for ONE request (the endpoint is stateless: no sessions, nothing kept between
 * requests), with every tool in `MCP_TOOLS` registered over `context`.
 */
export function createMcpServer(context: McpToolContext): McpServer {
  const server = new McpServer(
    { name: "kreloses-analytics", title: "Clinic sales analytics", version: "1.0.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  for (const tool of MCP_TOOLS) registerMcpTool(server, tool, context);
  return server;
}
