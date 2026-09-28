import { dailySalesTool } from "./daily-sales";
import { dataFreshnessTool } from "./data-freshness";
import { discountsTool } from "./discounts";
import { doctorPerformanceTool } from "./doctor-performance";
import { itemMixTool } from "./item-mix";
import type { AnyMcpTool } from "./registry";
import { retentionTool } from "./retention";
import { searchSalesTool } from "./search-sales";

/**
 * Every tool the MCP server offers — all read-only (spec story 61): no tool writes, runs raw SQL or
 * contacts Kreloses. To add one, write `./<tool>.ts` exporting `defineTool({...})` over Analytics
 * Service functions (spread `filterInput` from ./filter.ts into its input and call `resolveFilter`),
 * then list it here and in the shared tests of ../mcp.test.ts. The registry adds the read-only
 * guard, data freshness and definitions to every result.
 */
export const MCP_TOOLS: readonly AnyMcpTool[] = [
  dataFreshnessTool,
  doctorPerformanceTool,
  dailySalesTool,
  searchSalesTool,
  itemMixTool,
  retentionTool,
  discountsTool,
];
