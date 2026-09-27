import { Suspense } from "react";

import { getFilterOptions } from "@/filters/options";

import { FilterBarControls } from "./filter-bar-controls";

/** Server wrapper: loads the selector options, then renders the (client) filter bar. */
export async function GlobalFilterBar() {
  const options = await getFilterOptions();
  return (
    <Suspense fallback={<div className="h-24 rounded-lg border bg-card" aria-hidden />}>
      <FilterBarControls {...options} />
    </Suspense>
  );
}
