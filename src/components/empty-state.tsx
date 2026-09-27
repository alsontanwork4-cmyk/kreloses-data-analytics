import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { hasRole, type AppUser } from "@/auth/roles";
import { Button } from "@/components/ui/button";
import { formatDateRange, type GlobalFilter } from "@/filters";

/** A friendly placeholder for a page or panel with nothing to show yet. */
export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      data-testid="empty-state"
      className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center"
    >
      {Icon ? <Icon className="size-8 text-muted-foreground" aria-hidden /> : null}
      <h2 className="text-base font-medium">{title}</h2>
      {children ? <div className="max-w-md text-sm text-muted-foreground">{children}</div> : null}
      {action}
    </div>
  );
}

/** Empty state for analytics pages before any sales have been synced. */
export function NoSalesYet({
  user,
  filter,
  what,
  icon,
}: {
  user: AppUser;
  filter: GlobalFilter;
  what: string;
  icon?: LucideIcon;
}) {
  const owner = hasRole(user, "owner");
  return (
    <EmptyState
      icon={icon}
      title="No sales data yet"
      action={
        owner ? (
          <Button asChild size="sm">
            <Link href="/connections">Connect Kreloses</Link>
          </Button>
        ) : null
      }
    >
      <p>
        {what} for {formatDateRange(filter.dateFrom, filter.dateTo)} will appear here once a
        Kreloses branch is connected and its sales have synced.
        {owner ? null : " Ask the clinic owner to connect Kreloses."}
      </p>
    </EmptyState>
  );
}
