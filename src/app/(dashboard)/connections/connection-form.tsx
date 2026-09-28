"use client";

import { useActionState, useId, type ComponentProps } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { saveConnectionAction, type SaveConnectionState } from "./actions";

type SavedState = Extract<SaveConnectionState, { status: "saved" }>;

/**
 * Add or edit a Kreloses login. Saving stores it (password encrypted) and logs in to Kreloses to
 * test it, which takes a few seconds. The password field always starts empty: on edit, leaving it
 * blank keeps the stored password.
 */
export function ConnectionForm({
  connection,
  onSaved,
  onCancel,
}: {
  connection?: { id: string; label: string; email: string };
  onSaved: (state: SavedState) => void;
  onCancel: () => void;
}) {
  const ids = useId();
  const editing = connection !== undefined;
  const [state, formAction, pending] = useActionState<SaveConnectionState, FormData>(
    async (previous, formData) => {
      const next = await saveConnectionAction(previous, formData);
      if (next.status === "saved") onSaved(next);
      return next;
    },
    { status: "idle" },
  );

  const invalid = state.status === "invalid" ? state : null;
  const values = invalid?.values ?? { label: connection?.label ?? "", email: connection?.email ?? "" };
  const fieldError = (field: "label" | "email" | "password") => invalid?.fieldErrors[field];

  const field = (
    name: "label" | "email" | "password",
    label: string,
    input: ComponentProps<typeof Input>,
    hint?: string,
  ) => {
    const id = `${ids}-${name}`;
    const error = fieldError(name);
    const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ");
    return (
      <div className="space-y-1.5">
        <Label htmlFor={id}>{label}</Label>
        <Input
          id={id}
          name={name}
          className="h-10"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          {...input}
        />
        {hint ? (
          <p id={`${id}-hint`} className="text-xs text-muted-foreground">
            {hint}
          </p>
        ) : null}
        {error ? (
          <p id={`${id}-error`} className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    );
  };

  return (
    <form action={formAction} className="space-y-4" aria-label={editing ? `Edit ${connection.label}` : "Add a Kreloses login"}>
      {connection ? <input type="hidden" name="id" value={connection.id} /> : null}
      {invalid?.formError ? (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {invalid.formError}
        </p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-3">
        {field("label", "Name", {
          defaultValue: values.label,
          required: true,
          maxLength: 80,
          placeholder: "e.g. Branch North",
          autoComplete: "off",
        })}
        {field("email", "Kreloses email", {
          type: "email",
          defaultValue: values.email,
          required: true,
          autoComplete: "off",
          inputMode: "email",
          spellCheck: false,
        })}
        {field(
          "password",
          "Kreloses password",
          { type: "password", required: !editing, autoComplete: "new-password", maxLength: 256 },
          editing ? "Leave blank to keep the saved password." : "Stored encrypted and never shown again.",
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Testing the login…" : "Save and test"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        {pending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Logging in to Kreloses to check it works. This takes a few seconds.
          </p>
        ) : null}
      </div>
    </form>
  );
}
