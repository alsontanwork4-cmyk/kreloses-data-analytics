import { Suspense, type ReactNode } from "react";

import type { AppUser } from "@/auth/roles";

import { MobileNav } from "./mobile-nav";
import { NavLinks } from "./nav-links";
import { UserMenu } from "./user-menu";

/** Sidebar on desktop, top bar + slide-in menu on phones. */
export function AppShell({ user, children }: { user: AppUser; children: ReactNode }) {
  return (
    <div className="flex min-h-svh w-full">
      <aside className="sticky top-0 hidden h-svh w-60 shrink-0 flex-col border-r bg-sidebar md:flex">
        <div className="flex h-14 items-center border-b px-5 font-semibold">Kreloses Analytics</div>
        <div className="flex-1 overflow-y-auto p-3">
          <Suspense>
            <NavLinks role={user.role} />
          </Suspense>
        </div>
        <div className="border-t p-3">
          <UserMenu user={user} />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/95 px-2 backdrop-blur md:hidden">
          <MobileNav user={user} />
          <span className="font-semibold">Kreloses Analytics</span>
        </header>
        <main className="flex-1 px-4 py-5 md:px-8 md:py-8">{children}</main>
      </div>
    </div>
  );
}
