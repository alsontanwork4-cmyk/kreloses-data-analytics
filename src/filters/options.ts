import "server-only";

import { listDoctors } from "@/analytics";
import { getDb } from "@/db/client";

import type { FilterOption } from "./types";

/**
 * Choices for the filter bar's selectors (server only; NOT re-exported from `@/filters`, which
 * client components import). Each list is its own function so the ticket that owns the data
 * swaps one body without touching the UI:
 *
 * - branches: the `branches` table (created by the sync, #4). Empty until the first sync.
 * - doctors: staff of kind doctor that appear on invoice lines (`listDoctors`, Analytics Service;
 *   #5). Empty until the first sync with line items (the selector shows, disabled).
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

/** Every doctor, by name; `id` is `staff.id` (what `GlobalFilter.doctorIds` holds). `undefined` would hide the selector. */
export async function listDoctorOptions(): Promise<FilterOption[] | undefined> {
  return (await listDoctors(getDb())).map((doctor) => ({ id: doctor.id, label: doctor.name }));
}
