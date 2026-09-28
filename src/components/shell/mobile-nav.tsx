"use client";

import { Menu } from "lucide-react";
import { Suspense, useState } from "react";

import type { AppUser } from "@/auth/roles";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

import { NavLinks } from "./nav-links";
import { UserMenu } from "./user-menu";

/** Menu button + slide-in navigation for small screens. */
export function MobileNav({ user }: { user: AppUser }) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Open menu">
          <Menu />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-72 gap-0 bg-sidebar p-0">
        <SheetHeader className="border-b">
          <SheetTitle>Kreloses Analytics</SheetTitle>
          <SheetDescription className="sr-only">Navigation</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto p-3">
          <Suspense>
            <NavLinks role={user.role} onNavigate={() => setOpen(false)} />
          </Suspense>
        </div>
        <div className="border-t p-3">
          <UserMenu user={user} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
