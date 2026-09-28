import { formatDateRange } from "@/filters";

import type { FilterEcho } from "./filter";

/** Wording shared by the tools' one-line summaries. */

/** "1 Sep 2026 – 30 Sep 2026, all branches" / "…, Branch North, doctor Dr Alpha Anderson". */
export function describeCoverage(covers: FilterEcho): string {
  const branches = covers.branches === "all" ? "all branches" : covers.branches.map((branch) => branch.name).join(", ");
  const doctors =
    covers.doctors === "all" ? "" : `, ${covers.doctors.length === 1 ? "doctor" : "doctors"} ${covers.doctors.map((doctor) => doctor.name).join(", ")}`;
  return `${formatDateRange(covers.dateFrom, covers.dateTo)}, ${branches}${doctors}`;
}

/** "1 sale", "3 sales". */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
