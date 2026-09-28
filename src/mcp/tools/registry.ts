import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { METRIC_DEFINITIONS, type MetricName } from "@/analytics";
import type { Sql } from "@/db/sql";

import { ToolInputError, type McpTool, type McpToolContext } from "./define";
import { dataFreshnessOutput, describeFreshness } from "./freshness";

/** Every tool is read-only; the registry sets this, a tool cannot opt out. */
export const READ_ONLY_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** A tool of any input/output (the registry treats them all alike). */
// Method syntax in `McpTool.run` keeps this assignable from every concrete tool.
export type AnyMcpTool = McpTool<z.ZodRawShape, z.ZodRawShape>;

/**
 * Registers one tool on a (per-request) MCP server. See `McpTool` (./define.ts) for everything this
 * adds to every tool: read-only annotations and transaction, strict input, data freshness and
 * verbatim definitions in every result, and safe errors.
 */
export function registerMcpTool(server: McpServer, tool: AnyMcpTool, context: McpToolContext): void {
  // Every result carries data freshness, so its definition always comes along.
  const names = [...new Set<MetricName>([...tool.definitions, "dataAsOf"])];
  const definitions = Object.fromEntries(names.map((name) => [name, METRIC_DEFINITIONS[name]]));
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: z.strictObject(tool.input),
      outputSchema: z.object({
        summary: z.string().describe("What this answer says, in a sentence or two (also the first text block)."),
        ...tool.output,
        dataFreshness: dataFreshnessOutput.describe(
          "How fresh the data is, per branch: always tell the user the data-as-of time with these numbers, and never present them as more current.",
        ),
        definitions: z
          .record(z.string(), z.string())
          .describe("How every number in this result is worked out: the dashboard's own definitions, verbatim."),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input: Record<string, unknown>): Promise<CallToolResult> => {
      try {
        const { answer, freshness } = await readOnly(context.sql, async (sql) => {
          const scoped: McpToolContext = { ...context, sql };
          const answer = await tool.run(scoped, input);
          return { answer, freshness: await describeFreshness(sql, answer.freshness, context.now()) };
        });
        // Clients differ in what they show the model: Claude Code only `structuredContent` when both
        // are present, others only the text. So the summary is in both, and so is the data.
        const structured = { summary: answer.summary, ...answer.data, dataFreshness: freshness, definitions };
        return {
          content: [
            { type: "text", text: `${answer.summary}\n${freshness.summary}` },
            { type: "text", text: JSON.stringify(structured) },
          ],
          structuredContent: structured,
        };
      } catch (error) {
        if (error instanceof ToolInputError) return toolError(error.message);
        // Never send internals (SQL, stack) to the client; the server log has them.
        console.error(`[mcp] tool ${tool.name} failed:`, error);
        return toolError(`${tool.name} failed on the server while reading the data. Try again; if it keeps failing, the app's logs say why.`);
      }
    },
  );
}

/**
 * Runs `fn` in a READ ONLY, REPEATABLE READ transaction: every query a tool makes sees one
 * consistent snapshot (e.g. a ranking and its freshness agree even while a sync commits), and a
 * write of any kind fails ("cannot execute … in a read-only transaction") — defence in depth for
 * spec story 61 on top of tools only calling Analytics Service reads.
 */
async function readOnly<T>(sql: Sql, fn: (sql: Sql) => Promise<T>): Promise<T> {
  // A transaction handle answers every query the Analytics Service makes (`sql\`…\``, fragments);
  // it lacks only pool methods (`begin`, `end`, …) that analytics code never calls.
  return (await sql.begin("isolation level repeatable read read only", (tx) => fn(tx as unknown as Sql))) as T;
}

function toolError(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
