import { dataFreshnessTool } from "./data-freshness";
import { doctorPerformanceTool } from "./doctor-performance";
import type { AnyMcpTool } from "./registry";
import { searchSalesTool } from "./search-sales";

/**
 * Every tool the MCP server offers — all read-only (spec story 61): no tool writes, runs raw SQL or
 * contacts Kreloses. To add one (#18: daily_sales, item_mix, retention, discounts), write
 * `./<tool>.ts` exporting `defineTool({...})` over Analytics Service functions (spread
 * `filterInput` from ./filter.ts into its input and call `resolveFilter`), then list it here.
 * The registry adds the read-only guard, data freshness and definitions to every result.
 */
export const MCP_TOOLS: readonly AnyMcpTool[] = [dataFreshnessTool, doctorPerformanceTool, searchSalesTool];
