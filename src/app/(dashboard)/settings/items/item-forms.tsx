"use client";

import { Trash2 } from "lucide-react";
import { startTransition, useActionState, useState } from "react";

import { MIX_GROUP_LABELS, MIX_GROUPS, type ItemClassification, type ItemFlags, type MixGroup } from "@/attribution";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

import { addItemRuleAction, assignItemAction, clearItemAssignmentAction, deleteItemRuleAction, type ItemChangeState } from "./actions";

const SELECT =
  "h-8 min-w-0 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

const FLAGS: { name: keyof ItemFlags; label: string }[] = [
  { name: "surgery", label: "Surgery" },
  { name: "procedure", label: "Operation" },
  { name: "consult", label: "Consult" },
  { name: "vaccine", label: "Vaccine" },
  { name: "dentalScaling", label: "Dental scaling" },
];

const NO_FLAGS: ItemFlags = { surgery: false, consult: false, vaccine: false, dentalScaling: false, procedure: false };

/**
 * A group select plus the five flags. Choosing a group sets the flags that follow from it (Surgery →
 * surgery + operation, Consult → consult; others clear those two) — the owner can still change
 * them, e.g. untick "Operation" for a sedation-only charge. "Operation" needs "Surgery".
 */
function ClassificationFields({ name, initial, allowUnmapped = false }: { name: string; initial: ItemClassification | null; allowUnmapped?: boolean }) {
  const [group, setGroup] = useState<MixGroup | "unmapped" | "">(initial?.group ?? "");
  const [flags, setFlags] = useState<ItemFlags>(initial ?? NO_FLAGS);
  const choose = (next: MixGroup | "unmapped" | "") => {
    setGroup(next);
    setFlags((current) =>
      next === "unmapped" ? NO_FLAGS : { ...current, surgery: next === "surgery", procedure: next === "surgery", consult: next === "consult" },
    );
  };
  const toggle = (flag: keyof ItemFlags, on: boolean) =>
    setFlags((current) => {
      const next = { ...current, [flag]: on };
      if (flag === "surgery" && !on) next.procedure = false;
      if (flag === "procedure" && on) next.surgery = true;
      return next;
    });
  return (
    <div className="flex flex-col gap-1.5">
      <select name="group" value={group} onChange={(event) => choose(event.target.value as MixGroup | "unmapped" | "")} aria-label={`Group for “${name}”`} className={cn(SELECT, "w-52")} required>
        <option value="" disabled>
          Choose a group…
        </option>
        {MIX_GROUPS.map((option) => (
          <option key={option} value={option}>
            {MIX_GROUP_LABELS[option]}
          </option>
        ))}
        {allowUnmapped ? <option value="unmapped">Leave unmapped (no group)</option> : null}
      </select>
      <fieldset className="grid w-max grid-cols-3 gap-x-3 gap-y-1 text-xs" aria-label={`Flags for “${name}”`}>
        {FLAGS.map((flag) => (
          <label key={flag.name} className="inline-flex items-center gap-1 whitespace-nowrap">
            <input
              type="checkbox"
              name={flag.name}
              checked={flags[flag.name]}
              disabled={group === "unmapped"}
              onChange={(event) => toggle(flag.name, event.target.checked)}
              className="size-3.5"
            />
            {flag.label}
          </label>
        ))}
      </fieldset>
    </div>
  );
}

/** Assigns one item (all its spellings) to a group with flags; beats every rule. */
export function ItemAssignmentForm({
  itemKey,
  itemName,
  classification,
  assigned,
}: {
  itemKey: string;
  itemName: string;
  classification: ItemClassification | null;
  /** The owner's assignment decides it now (so "Use the rules" is offered). */
  assigned: boolean;
}) {
  const [state, action, pending] = useActionState<ItemChangeState, FormData>(assignItemAction, { status: "idle" });
  const [cleared, clear, clearing] = useActionState<ItemChangeState, FormData>(clearItemAssignmentAction, { status: "idle" });
  return (
    <div className="flex flex-col gap-1">
      <form action={action} aria-label={`Assign “${itemName}”`} className="flex items-start gap-2">
        <input type="hidden" name="itemKey" value={itemKey} />
        <ClassificationFields name={itemName} initial={classification} />
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          Save
        </Button>
      </form>
      {assigned ? (
        <form action={clear}>
          <input type="hidden" name="itemKey" value={itemKey} />
          <Button type="submit" size="sm" variant="ghost" disabled={clearing} className="h-6 px-1 text-xs">
            Use the rules instead
          </Button>
        </form>
      ) : null}
      <Notice state={cleared.status !== "idle" ? cleared : state} />
    </div>
  );
}

/** Adds an exact-name or pattern rule. */
export function AddRuleForm() {
  const [state, action, pending] = useActionState<ItemChangeState, FormData>(addItemRuleAction, { status: "idle" });
  return (
    <form action={action} aria-label="Add a rule" className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="rule-match">Match</Label>
          <select id="rule-match" name="matchType" defaultValue="pattern" className={SELECT}>
            <option value="pattern">Pattern</option>
            <option value="exact">Exact name</option>
          </select>
        </div>
        <div className="flex min-w-48 flex-1 flex-col gap-1">
          <Label htmlFor="rule-pattern">Item name or pattern</Label>
          <Input id="rule-pattern" name="pattern" required maxLength={200} placeholder="%skin scraping%" autoComplete="off" />
        </div>
        <div className="flex w-24 flex-col gap-1">
          <Label htmlFor="rule-priority">Priority</Label>
          <Input id="rule-priority" name="priority" type="number" step={1} min={-10000} max={10000} defaultValue={100} />
        </div>
      </div>
      <div className="flex flex-wrap items-start gap-3">
        <ClassificationFields name="new rule" initial={null} allowUnmapped />
        <Button type="submit" size="sm" disabled={pending}>
          Add rule
        </Button>
      </div>
      <Notice state={state} />
    </form>
  );
}

/** Deletes a rule after a confirmation. */
export function DeleteRuleButton({ ruleId, pattern }: { ruleId: string; pattern: string }) {
  const [state, action, pending] = useActionState<ItemChangeState, FormData>(deleteItemRuleAction, { status: "idle" });
  const remove = () => {
    const formData = new FormData();
    formData.set("ruleId", ruleId);
    startTransition(() => action(formData));
  };
  return (
    <div className="flex flex-col items-start gap-1">
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="ghost" size="sm" disabled={pending} aria-label={`Delete rule “${pattern}”`}>
            <Trash2 />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="[overflow-wrap:anywhere]">Delete the rule “{pattern}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Items it decides will follow the next matching rule (or become unmapped), in every period. You can add it again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={remove}>
              Delete rule
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Notice state={state} />
    </div>
  );
}

function Notice({ state }: { state: ItemChangeState }) {
  if (state.status === "idle") return null;
  return (
    <p role="status" className={cn("text-xs", state.status === "saved" ? "text-emerald-700 dark:text-emerald-300" : "text-destructive")}>
      {state.message}
    </p>
  );
}
