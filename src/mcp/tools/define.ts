import type { z } from "zod";

import type { MetricName } from "@/analytics";
import type { Sql } from "@/db/sql";

import type { FreshnessScope } from "./freshness";

/**
 * What every MCP tool is: a thin, READ-ONLY wrapper over Analytics Service functions. A tool is
 * one file in this folder exporting `defineTool({...})`, listed once in `MCP_TOOLS` (./index.ts).
 * The registry (./registry.ts) does the rest for every tool alike:
 *
 * - annotates it read-only, validates its input strictly (unknown arguments are refused, not
 *   ignored) and checks its output against its schema;
 * - runs it inside a read-only, repeatable-read transaction (a consistent snapshot; any write fails);
 * - adds `dataFreshness` (data as of per branch for the tool's `freshness` scope) and `definitions`
 *   (the tool's `METRIC_DEFINITIONS`, verbatim) to every result, plus a one-line text summary;
 * - turns a `ToolInputError` into a helpful error result, and anything else into a generic one
 *   (logged on the server, never shown to the client).
 */
export interface McpToolContext {
  /** The database: inside `run`, a read-only transaction. Pass it straight to Analytics Service functions. */
  sql: Sql;
  /** The clock ("today" at the clinic, freshness checks). */
  now: () => Date;
}

/** What a tool's `run` returns. */
export interface ToolAnswer<Data> {
  /** The structured result (without `dataFreshness` / `definitions`, which the registry adds). */
  data: Data;
  /** One or two short sentences a person could read: what was answered and the headline. */
  summary: string;
  /** Which period and branches the data-as-of note covers (normally the resolved filter). */
  freshness: FreshnessScope;
}

export interface McpTool<Input extends z.ZodRawShape, Output extends z.ZodRawShape> {
  /** snake_case, what Claude calls. */
  name: string;
  title: string;
  /** At most 2,048 characters (Claude Code cuts longer ones); tested in mcp.test.ts. */
  description: string;
  /** Input fields (zod). Validated strictly: unknown fields are refused. */
  input: Input;
  /** Output fields (zod), without `dataFreshness` / `definitions`. */
  output: Output;
  /** The metric definitions this tool's numbers use; returned verbatim with every result. */
  definitions: readonly MetricName[];
  run(context: McpToolContext, input: z.output<z.ZodObject<Input>>): Promise<ToolAnswer<z.output<z.ZodObject<Output>>>>;
}

/** Identity function that type-checks a tool definition. */
export function defineTool<Input extends z.ZodRawShape, Output extends z.ZodRawShape>(tool: McpTool<Input, Output>): McpTool<Input, Output> {
  return tool;
}

/**
 * A problem with the caller's arguments (unknown doctor, ambiguous branch, dates the wrong way
 * round…): its message goes back to the client as the tool's error, so write it for Claude —
 * say what was wrong and how to ask again.
 */
export class ToolInputError extends Error {
  override name = "ToolInputError";
}
