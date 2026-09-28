"use client";

import { Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";

import { deleteConnectionAction, retestConnectionAction, type SaveConnectionState } from "./actions";
import { ConnectionForm } from "./connection-form";
import { SaveNotice } from "./save-notice";

type Mode = "idle" | "editing" | "confirm-delete";

/** Edit, "Test again" and delete (with confirmation) for one connection card. */
export function ConnectionActions({ connection }: { connection: { id: string; label: string; email: string } }) {
  const [mode, setMode] = useState<Mode>("idle");
  const [saved, setSaved] = useState<Extract<SaveConnectionState, { status: "saved" }> | null>(null);

  if (mode === "editing") {
    return (
      <div className="border-t pt-4">
        <ConnectionForm
          connection={connection}
          onSaved={(state) => {
            setSaved(state);
            setMode("idle");
          }}
          onCancel={() => setMode("idle")}
        />
      </div>
    );
  }

  if (mode === "confirm-delete") {
    return (
      <div role="group" aria-label="Confirm delete" className="space-y-3 rounded-md border border-destructive/30 bg-destructive/5 p-3">
        <p className="text-sm">
          Delete “{connection.label}”? The app forgets this Kreloses login and its saved password, and stops syncing it.
          Sales already synced are kept.
        </p>
        <div className="flex flex-wrap gap-2">
          <form action={deleteConnectionAction}>
            <input type="hidden" name="id" value={connection.id} />
            <PendingButton variant="destructive" pendingLabel="Deleting…">
              Delete connection
            </PendingButton>
          </form>
          <Button type="button" variant="ghost" onClick={() => setMode("idle")}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {saved ? <SaveNotice state={saved} /> : null}
      <div className="flex flex-wrap gap-2">
        <form action={retestConnectionAction} onSubmit={() => setSaved(null)}>
          <input type="hidden" name="id" value={connection.id} />
          <PendingButton variant="outline" pendingLabel="Testing…" icon={<RefreshCw />}>
            Test again
          </PendingButton>
        </form>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setSaved(null);
            setMode("editing");
          }}
        >
          <Pencil />
          Edit
        </Button>
        <Button type="button" variant="ghost" className="text-destructive" onClick={() => setMode("confirm-delete")}>
          <Trash2 />
          Delete
        </Button>
      </div>
    </div>
  );
}

function PendingButton({
  children,
  pendingLabel,
  variant,
  icon,
}: {
  children: string;
  pendingLabel: string;
  variant: "outline" | "destructive";
  icon?: ReactNode;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} disabled={pending} aria-busy={pending || undefined}>
      {icon}
      {pending ? pendingLabel : children}
    </Button>
  );
}
