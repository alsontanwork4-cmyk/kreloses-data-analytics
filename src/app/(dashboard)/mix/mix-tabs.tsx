import Link from "next/link";

import { filterSearchParamsOnly, withSearchParams, type SearchParamsInput } from "@/filters";
import { cn } from "@/lib/utils";

/** The Mix page's views (spec: the surgery section and vaccines & dental are part of Mix). */
const MIX_VIEWS = [
  { key: "mix", href: "/mix", label: "Service mix" },
  { key: "surgery", href: "/mix/surgery", label: "Surgery, vaccines & dental" },
] as const;

export type MixView = (typeof MIX_VIEWS)[number]["key"];

/**
 * Tabs between the Mix views. Links keep the global filter (dates, branches, doctors) and drop
 * view-specific params (e.g. `?top=`). Scrolls sideways on phones.
 */
export function MixTabs({ current, params }: { current: MixView; params: SearchParamsInput }) {
  const filterParams = filterSearchParamsOnly(params);
  return (
    <nav aria-label="Mix views" className="-mx-4 overflow-x-auto border-b px-4 md:mx-0 md:px-0">
      <ul className="flex min-w-max gap-1">
        {MIX_VIEWS.map(({ key, href, label }) => (
          <li key={key}>
            <Link
              href={withSearchParams(href, filterParams)}
              aria-current={key === current ? "page" : undefined}
              className={cn(
                "-mb-px inline-flex h-10 items-center border-b-2 px-3 text-sm transition-colors",
                key === current ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
