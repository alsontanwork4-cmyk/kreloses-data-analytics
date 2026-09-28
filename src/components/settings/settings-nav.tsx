"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import type { Role } from "@/auth/roles";
import { settingsNavItemsFor } from "@/components/shell/nav-config";
import { cn } from "@/lib/utils";

/** Tabs across the top of every Settings page (from `SETTINGS_NAV_ITEMS`). Scrolls sideways on phones. */
export function SettingsNav({ role }: { role: Role }) {
  const pathname = usePathname();
  const items = settingsNavItemsFor(role);
  if (items.length === 0) return null;

  return (
    <nav aria-label="Settings" className="-mx-4 overflow-x-auto border-b px-4 md:mx-0 md:px-0">
      <ul className="flex min-w-max gap-1">
        {items.map(({ href, label }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "-mb-px inline-flex h-10 items-center border-b-2 px-3 text-sm transition-colors",
                  active
                    ? "border-foreground font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
