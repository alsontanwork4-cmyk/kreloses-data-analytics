import type { IsoDate } from "./dates";
import type { DateRangeKey } from "./presets";

/**
 * The filter every Analytics Service query takes.
 *
 * - `dateFrom`/`dateTo`: inclusive clinic-local calendar dates (Asia/Kuala_Lumpur).
 * - `branchIds`/`doctorIds`: ids as text (the table's primary key rendered as a string).
 *   Absent means "all"; never an empty array.
 */
export interface GlobalFilter {
  dateFrom: IsoDate;
  dateTo: IsoDate;
  branchIds?: string[];
  doctorIds?: string[];
}

/** The filter plus which date option produced it (for the filter bar and for serialising). */
export interface FilterState {
  range: DateRangeKey;
  filter: GlobalFilter;
}

/** One choice in a filter selector (branch, doctor). */
export interface FilterOption {
  id: string;
  label: string;
}
