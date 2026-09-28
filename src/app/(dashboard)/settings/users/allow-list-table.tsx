"use client";

import { UserMinus } from "lucide-react";
import { startTransition, useActionState } from "react";

import type { Role } from "@/auth/roles";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { removeManagerAction, type RemoveState } from "./actions";
import { removeNotice } from "./messages";
import { NoticeMessage } from "./notice-message";

/** One allow-list row, already formatted on the server (clinic time zone). */
export interface AllowListRow {
  email: string;
  role: Role;
  addedAt: string;
  invitedBy: string | null;
  lastSignIn: string | null;
  isYou: boolean;
  /** Only managers can be removed from here. */
  removable: boolean;
}

export function AllowListTable({ rows }: { rows: AllowListRow[] }) {
  const [state, removeAction, pending] = useActionState<RemoveState, FormData>(removeManagerAction, {
    status: "idle",
  });

  const remove = (email: string) => {
    const formData = new FormData();
    formData.set("email", email);
    startTransition(() => removeAction(formData));
  };

  return (
    <div className="flex flex-col gap-3">
      <NoticeMessage notice={state.status === "idle" ? null : removeNotice(state)} testId="remove-notice" />
      <ul aria-label="People with access" className="divide-y rounded-lg border">
        {rows.map((row) => (
          <li
            key={row.email}
            data-testid="allow-list-row"
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3"
          >
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span data-testid="allow-list-email" className="text-sm font-medium [overflow-wrap:anywhere]">
                  {row.email}
                </span>
                <Badge variant={row.role === "owner" ? "default" : "secondary"} className="capitalize">
                  {row.role}
                </Badge>
                {row.isYou ? <Badge variant="outline">You</Badge> : null}
              </div>
              <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {row.invitedBy ? `Invited by ${row.invitedBy} on ${row.addedAt}` : `Added ${row.addedAt}`}
                {" · "}
                {row.lastSignIn ? `Last signed in ${row.lastSignIn}` : "Never signed in"}
              </p>
            </div>
            {row.removable ? (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="sm" disabled={pending} aria-label={`Remove ${row.email}`}>
                    <UserMinus />
                    Remove
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle className="[overflow-wrap:anywhere]">Remove {row.email}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      They lose access to the dashboard straight away, including any open sessions. You can
                      invite them again later.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction variant="destructive" onClick={() => remove(row.email)}>
                      Remove access
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
