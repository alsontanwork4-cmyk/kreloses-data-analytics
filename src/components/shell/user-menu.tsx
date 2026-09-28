import { LogOut } from "lucide-react";

import type { AppUser } from "@/auth/roles";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/** Signed-in email, role and a sign-out button. */
export function UserMenu({ user }: { user: AppUser }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2 px-1">
        <span className="truncate text-sm" data-testid="signed-in-email">
          {user.email}
        </span>
        <Badge variant="secondary" className="capitalize">
          {user.role}
        </Badge>
      </div>
      <form action="/auth/sign-out" method="post">
        <Button type="submit" variant="outline" size="sm" className="w-full justify-start">
          <LogOut />
          Sign out
        </Button>
      </form>
    </div>
  );
}
