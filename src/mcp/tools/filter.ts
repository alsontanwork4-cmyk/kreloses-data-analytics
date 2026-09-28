import { z } from "zod";

import { listBranches, listDoctorNames } from "@/analytics";
import { DATE_PRESETS, clinicToday, isIsoDate, resolveDatePreset, type DatePreset, type GlobalFilter, type IsoDate } from "@/filters";

import { ToolInputError, type McpToolContext } from "./define";
import { matchName, type NamedEntry } from "./names";

/**
 * The global filter for MCP tools: the same `{ dateFrom, dateTo, branchIds?, doctorIds? }` every
 * dashboard page queries with, but typed the way people ask — ISO dates or a preset, branches and
 * doctors by id OR name. Spread the input shapes into a tool's input, then `resolveFilter`.
 */

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be written YYYY-MM-DD")
  .refine(isIsoDate, "must be a real calendar date");

/** The period: dates, a preset, or neither (month to date, like the dashboard). */
export const periodInput = {
  dateFrom: isoDate
    .optional()
    .describe("First clinic day (Asia/Kuala_Lumpur), YYYY-MM-DD, inclusive. Without dateTo the period runs to today."),
  dateTo: isoDate.optional().describe("Last clinic day, YYYY-MM-DD, inclusive. Needs dateFrom."),
  preset: z
    .enum(DATE_PRESETS)
    .optional()
    .describe(
      "Instead of dates: today, this-week (Monday to today), month-to-date, last-month (the whole previous calendar month) or year-to-date. With no dates and no preset: month-to-date.",
    ),
};

export const branchesInput = {
  branches: z
    .array(z.string().max(200))
    .min(1)
    .max(20)
    .optional()
    .describe('Branches by id or name (e.g. "North"). Omit for all branches.'),
};

export const doctorsInput = {
  doctors: z
    .array(z.string().max(200))
    .min(1)
    .max(50)
    .optional()
    .describe('Doctors by id or name: full name, part of it, or the short name printed on invoices (e.g. "Dr Alpha"). Omit for everyone.'),
};

/** Dates + branches + doctors: the whole global filter. */
export const filterInput = { ...periodInput, ...branchesInput, ...doctorsInput };

const named = z.object({ id: z.string(), name: z.string() });

/** What an answer covers, after names and defaults were resolved (so Claude can say it). */
export const filterOutput = z
  .object({
    dateFrom: z.string().describe("First clinic day, inclusive."),
    dateTo: z.string().describe("Last clinic day, inclusive."),
    branches: z.union([z.literal("all"), z.array(named)]),
    doctors: z.union([z.literal("all"), z.array(named)]),
  })
  .describe("What this answer covers: the period (clinic days, Asia/Kuala_Lumpur) and the branches and doctors it was resolved to.");

export type FilterEcho = z.output<typeof filterOutput>;

export interface FilterArguments {
  dateFrom?: IsoDate;
  dateTo?: IsoDate;
  preset?: DatePreset;
  branches?: string[];
  doctors?: string[];
}

/**
 * The `GlobalFilter` the arguments mean, and what it covers. Every problem (dates, unknown or
 * ambiguous names) is reported at once as a `ToolInputError` saying how to ask again.
 */
export async function resolveFilter(context: McpToolContext, args: FilterArguments): Promise<{ filter: GlobalFilter; covers: FilterEcho }> {
  const problems: string[] = [];
  const period = resolvePeriod(args, context.now(), problems);
  const [branchList, doctorList] = await Promise.all([
    args.branches ? listBranches(context.sql) : null,
    args.doctors ? listDoctorNames(context.sql) : null,
  ]);
  const branches = args.branches && branchList ? resolveNames(args.branches, branchList, "branch", problems) : null;
  const doctors =
    args.doctors && doctorList
      ? resolveNames(
          args.doctors,
          doctorList.map((doctor) => ({ id: doctor.id, name: doctor.name, otherNames: doctor.lineNames })),
          "doctor",
          problems,
        )
      : null;
  if (problems.length > 0 || !period) throw new ToolInputError(problems.join(" "));

  const filter: GlobalFilter = { dateFrom: period.dateFrom, dateTo: period.dateTo };
  if (branches) filter.branchIds = branches.map((branch) => branch.id);
  if (doctors) filter.doctorIds = doctors.map((doctor) => doctor.id);
  return {
    filter,
    covers: { dateFrom: period.dateFrom, dateTo: period.dateTo, branches: branches ?? "all", doctors: doctors ?? "all" },
  };
}

function resolvePeriod(args: FilterArguments, now: Date, problems: string[]): { dateFrom: IsoDate; dateTo: IsoDate } | null {
  if (args.preset && (args.dateFrom || args.dateTo)) {
    problems.push("Give either a preset or dateFrom/dateTo, not both.");
    return null;
  }
  if (args.preset) return resolveDatePreset(args.preset, now);
  if (!args.dateFrom && !args.dateTo) return resolveDatePreset("month-to-date", now);
  if (!args.dateFrom) {
    problems.push("dateTo needs a dateFrom (or use a preset).");
    return null;
  }
  const dateTo = args.dateTo ?? clinicToday(now);
  if (args.dateFrom > dateTo) {
    problems.push(`dateFrom (${args.dateFrom}) is after dateTo (${dateTo}).`);
    return null;
  }
  return { dateFrom: args.dateFrom, dateTo };
}

function resolveNames(terms: string[], entries: NamedEntry[], kind: "branch" | "doctor", problems: string[]): { id: string; name: string }[] {
  const found = new Map<string, string>();
  for (const term of terms) {
    const match = matchName(term, entries, kind);
    if (match.ok) found.set(match.entry.id, match.entry.name);
    else problems.push(match.problem);
  }
  return [...found].map(([id, name]) => ({ id, name }));
}
