"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { requestMagicLink, type MagicLinkState } from "./actions";

export function LoginForm({ next }: { next?: string }) {
  const [state, formAction, pending] = useActionState<MagicLinkState, FormData>(
    requestMagicLink,
    { status: "idle" },
  );

  if (state.status === "sent") {
    return (
      <div role="status" className="space-y-2 text-sm">
        <p className="font-medium">Check your email</p>
        <p className="text-muted-foreground">
          We sent a sign-in link to <span className="font-medium text-foreground">{state.email}</span>.
          Open it on any device to sign in. The link expires in one hour.
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          required
          defaultValue={state.status === "error" ? state.email : ""}
          aria-invalid={state.status === "error" || undefined}
          aria-describedby={state.status === "error" ? "login-error" : undefined}
          className="h-10"
        />
      </div>
      {state.status === "error" ? (
        <p id="login-error" role="alert" className="text-sm text-destructive">
          {state.message}
        </p>
      ) : null}
      <Button type="submit" className="h-10 w-full" disabled={pending}>
        {pending ? "Sending…" : "Email me a sign-in link"}
      </Button>
    </form>
  );
}
