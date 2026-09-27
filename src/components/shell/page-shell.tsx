import type { ReactNode } from "react";

import { GlobalFilterBar } from "@/components/filter-bar/global-filter-bar";

/**
 * Standard page frame: title, optional description, the global filter bar (analytics pages pass
 * `filters`), then the page content.
 */
export function PageShell({
  title,
  description,
  filters = false,
  actions,
  children,
}: {
  title: string;
  description?: string;
  filters?: boolean;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {actions}
      </div>
      {filters ? <GlobalFilterBar /> : null}
      {children}
    </div>
  );
}
