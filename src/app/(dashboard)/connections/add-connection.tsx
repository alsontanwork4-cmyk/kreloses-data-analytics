"use client";

import { Plus } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";

import type { SaveConnectionState } from "./actions";
import { ConnectionForm } from "./connection-form";
import { SaveNotice } from "./save-notice";

/** "Add connection" button that opens the form, and the result of the last save. */
export function AddConnection({ disabled }: { disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<Extract<SaveConnectionState, { status: "saved" }> | null>(null);

  if (open) {
    return (
      <section aria-labelledby="add-connection-title" className="rounded-xl border bg-card p-4">
        <h2 id="add-connection-title" className="mb-1 text-base font-medium">
          Add a Kreloses login
        </h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Use the login for one branch. Add another connection for each branch that has its own login.
        </p>
        <ConnectionForm
          onSaved={(state) => {
            setSaved(state);
            setOpen(false);
          }}
          onCancel={() => setOpen(false)}
        />
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {saved ? <SaveNotice state={saved} /> : null}
      <div>
        <Button
          type="button"
          disabled={disabled}
          onClick={() => {
            setSaved(null);
            setOpen(true);
          }}
        >
          <Plus />
          Add connection
        </Button>
      </div>
    </div>
  );
}
