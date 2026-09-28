import "server-only";

import { getDb } from "@/db/client";

import type { FilterOption } from "./types";

/**
 * Choices for the filter bar's selectors (server only; NOT re-exported from `@/filters`, which
 * client components import). Each list is its own function so the ticket that owns the data
 * swaps one body without touching the UI:
 *
 * - branches: the `branches` table (created by the sync, #4). Empty until the first sync.
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

/** Every synced branch, by name; `id` is `branches.id` (what `GlobalFilter.branchIds` holds). */
export async function listBranchOptions(): Promise<FilterOption[]> {
  return getDb()<FilterOption[]>`select id::text as id, name as label from branches order by lower(name), id`;
}

/** `undefined` hides the doctor selector; return a list (even empty) to show it. */
export async function listDoctorOptions(): Promise<FilterOption[] | undefined> {
  return undefined;
}
