import { Suspense } from "react";

import type { FilterState } from "@/filters";
import { getFilterOptions } from "@/filters/options";

import { FilterBarControls } from "./filter-bar-controls";

/** Server wrapper: loads the selector options, then renders the (client) filter bar. */
export async function GlobalFilterBar({ state }: { state: FilterState }) {
  const options = await getFilterOptions();
  return (
    <Suspense fallback={<div className="h-24 rounded-lg border bg-card" aria-hidden />}>
      <FilterBarControls state={state} {...options} />
    </Suspense>
  );
}
