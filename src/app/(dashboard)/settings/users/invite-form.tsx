"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { inviteManagerAction, type InviteState } from "./actions";
import { inviteNotice } from "./messages";
import { NoticeMessage } from "./notice-message";

export function InviteForm({ loginUrl }: { loginUrl: string }) {
  const [state, formAction, pending] = useActionState<InviteState, FormData>(inviteManagerAction, {
    status: "idle",
  });
  const notice = state.status === "idle" ? null : inviteNotice(state, loginUrl);
  // React resets the form after the action; keep an invalid address so it can be corrected.
  const retypeEmail = state.status === "invalid-email" ? state.email : "";

  return (
    <div className="flex flex-col gap-3">
      <form action={formAction} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1 space-y-2">
          <Label htmlFor="invite-email">Email</Label>
          <Input
            id="invite-email"
            name="email"
            type="email"
            autoComplete="off"
            inputMode="email"
            required
            placeholder="manager@example.com"
            defaultValue={retypeEmail}
            aria-invalid={state.status === "invalid-email" || undefined}
            className="h-10"
          />
        </div>
        <Button type="submit" className="h-10" disabled={pending}>
          {pending ? "Inviting…" : "Invite manager"}
        </Button>
      </form>
      <NoticeMessage notice={notice} testId="invite-notice" />
    </div>
  );
}
