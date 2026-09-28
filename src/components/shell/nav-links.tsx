"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import { hasRole, type Role } from "@/auth/roles";
import { filterSearchParamsOnly, withSearchParams } from "@/filters";
import { cn } from "@/lib/utils";

import { NAV_ITEMS, NAV_SECTIONS, type NavSection } from "./nav-config";

/**
 * Sidebar / mobile-menu links. Links keep the current global filter, so switching pages keeps
 * the same date range and branch.
 */
export function NavLinks({ role, onNavigate }: { role: Role; onNavigate?: () => void }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filterParams = filterSearchParamsOnly(searchParams);
  const items = NAV_ITEMS.filter((item) => !item.role || hasRole({ role }, item.role));
  const sections = Object.keys(NAV_SECTIONS) as NavSection[];

  return (
    <nav aria-label="Main" className="flex flex-col gap-5">
      {sections.map((section) => (
        <div key={section} className="flex flex-col gap-1">
          <p className="px-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {NAV_SECTIONS[section]}
          </p>
          <ul className="flex flex-col gap-0.5">
            {items
              .filter((item) => item.section === section)
              .map(({ href, label, icon: Icon }) => {
                const active = pathname === href || pathname.startsWith(`${href}/`);
                return (
                  <li key={href}>
                    <Link
                      href={withSearchParams(href, filterParams)}
                      onClick={onNavigate}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                        active
                          ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                          : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                      )}
                    >
                      <Icon className="size-4 shrink-0" aria-hidden />
                      {label}
                    </Link>
                  </li>
                );
              })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
