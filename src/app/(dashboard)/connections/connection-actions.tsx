"use client";

import { CheckCircle2, Info, Pencil, RefreshCw, Trash2, TriangleAlert, Download } from "lucide-react";
import { useActionState, useId, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import {
  deleteConnectionAction,
  retestConnectionAction,
  syncNowAction,
  type RetestState,
  type SaveConnectionState,
  type SyncNowState,
} from "./actions";
import { ConnectionForm } from "./connection-form";
import { SaveNotice } from "./save-notice";

type Mode = "idle" | "editing" | "confirm-delete";

export interface MonthOption {
  value: string;
  label: string;
}

/** "Sync now" (one month), edit, "Test again" and delete (with confirmation) for one connection card. */
export function ConnectionActions({
  connection,
  months,
}: {
  connection: { id: string; label: string; email: string };
  months: MonthOption[];
}) {
  const [mode, setMode] = useState<Mode>("idle");
  const [saved, setSaved] = useState<Extract<SaveConnectionState, { status: "saved" }> | null>(null);
  const [retest, retestAction] = useActionState<RetestState, FormData>(retestConnectionAction, { status: "idle" });

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
      {retest.status === "busy" ? <Notice tone="warning">{retest.message}</Notice> : null}
      <SyncNow connectionId={connection.id} months={months} />
      <div className="flex flex-wrap gap-2">
        <form action={retestAction} onSubmit={() => setSaved(null)}>
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

/** Reads one month of this login's sales from Kreloses now (the nightly sync does this automatically later). */
function SyncNow({ connectionId, months }: { connectionId: string; months: MonthOption[] }) {
  const selectId = useId();
  // Controlled, so the chosen month stays selected after the form action (React resets uncontrolled fields).
  const [month, setMonth] = useState(months[0]?.value ?? "");
  const [state, action] = useActionState<SyncNowState, FormData>(syncNowAction, { status: "idle" });
  return (
    <div className="flex flex-col gap-2 rounded-md border bg-muted/30 p-3">
      <form action={action} aria-label="Sync sales" className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="id" value={connectionId} />
        <label htmlFor={selectId} className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
          Month to sync
          <select
            id={selectId}
            name="month"
            value={month}
            onChange={(event) => setMonth(event.target.value)}
            className="h-9 min-w-44 rounded-lg border border-input bg-background px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {months.map((month) => (
              <option key={month.value} value={month.value}>
                {month.label}
              </option>
            ))}
          </select>
        </label>
        <PendingButton variant="default" pendingLabel="Syncing…" icon={<Download />}>
          Sync now
        </PendingButton>
      </form>
      {state.status === "done" ? <Notice tone={state.tone}>{state.message}</Notice> : null}
    </div>
  );
}

function Notice({ tone, children }: { tone: "ok" | "warning" | "error"; children: ReactNode }) {
  const Icon = tone === "ok" ? CheckCircle2 : tone === "warning" ? Info : TriangleAlert;
  return (
    <p
      role="status"
      className={cn(
        "flex items-start gap-2 rounded-md px-3 py-2 text-sm",
        tone === "ok" && "bg-emerald-600/10 text-emerald-800 dark:text-emerald-300",
        tone === "warning" && "bg-amber-500/10 text-amber-900 dark:text-amber-200",
        tone === "error" && "bg-destructive/10 text-destructive",
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{children}</span>
    </p>
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
  variant: "outline" | "destructive" | "default";
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
