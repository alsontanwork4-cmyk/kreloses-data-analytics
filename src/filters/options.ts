import "server-only";

import type { FilterOption } from "./types";

/**
 * Choices for the filter bar's selectors (server only; NOT re-exported from `@/filters`, which
 * client components import). Each list is its own function so the ticket that owns the data
 * swaps one body without touching the UI:
 *
 * - branches: will read the `branches` table (ticket #4). Empty until branches exist.
 * - doctors: will read `staff` (ticket #5). While undefined, the doctor selector is hidden.
 */
export interface FilterOptions {
  branches: FilterOption[];
  doctors?: FilterOption[];
}

export async function getFilterOptions(): Promise<FilterOptions> {
  const [branches, doctors] = await Promise.all([listBranchOptions(), listDoctorOptions()]);
  return doctors ? { branches, doctors } : { branches };
}

export async function listBranchOptions(): Promise<FilterOption[]> {
  return [];
}

/** `undefined` hides the doctor selector; return a list (even empty) to show it. */
export async function listDoctorOptions(): Promise<FilterOption[] | undefined> {
  return undefined;
}
