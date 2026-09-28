"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { remapAliasAction, setStaffKindAction, type StaffChangeState } from "./actions";

export interface StaffOption {
  id: string;
  label: string;
}

const SELECT =
  "h-8 min-w-0 flex-1 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 sm:min-w-44";

/** Which staff member lines with this name are credited to (suggestions first for an unmatched name). */
export function AliasMappingForm({
  aliasId,
  rawName,
  staffId,
  suggestions,
  staff,
}: {
  aliasId: string;
  rawName: string;
  staffId: string;
  suggestions: StaffOption[];
  staff: StaffOption[];
}) {
  const [state, action, pending] = useActionState<StaffChangeState, FormData>(remapAliasAction, { status: "idle" });
  const suggested = new Set(suggestions.map((option) => option.id));
  return (
    <form action={action} className="flex min-w-56 flex-col gap-1" aria-label={`Credit “${rawName}” to`}>
      <input type="hidden" name="aliasId" value={aliasId} />
      <div className="flex items-center gap-2">
        <select name="staffId" defaultValue={staffId} aria-label={`Staff member for “${rawName}”`} className={SELECT}>
          {suggestions.length > 0 ? (
            <optgroup label="Suggested">
              {suggestions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          ) : null}
          <optgroup label={suggestions.length > 0 ? "Everyone" : "Staff"}>
            {staff
              .filter((option) => !suggested.has(option.id))
              .map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
          </optgroup>
        </select>
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          Save
        </Button>
      </div>
      <Notice state={state} />
    </form>
  );
}

const KINDS = [
  { value: "doctor", label: "Doctor" },
  { value: "other", label: "Other staff" },
  { value: "generic", label: "Generic account" },
];

/** A staff member's kind: doctors are ranked; other staff and generic accounts are grouped apart. */
export function StaffKindForm({ staffId, name, kind }: { staffId: string; name: string; kind: string }) {
  const [state, action, pending] = useActionState<StaffChangeState, FormData>(setStaffKindAction, { status: "idle" });
  return (
    <form action={action} className="flex min-w-48 flex-col gap-1" aria-label={`Kind of ${name}`}>
      <input type="hidden" name="staffId" value={staffId} />
      <div className="flex items-center gap-2">
        <select name="kind" defaultValue={kind} aria-label={`Kind of ${name}`} className={SELECT}>
          {KINDS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          Save
        </Button>
      </div>
      <Notice state={state} />
    </form>
  );
}

function Notice({ state }: { state: StaffChangeState }) {
  if (state.status === "idle") return null;
  return (
    <p role="status" className={cn("text-xs", state.status === "saved" ? "text-emerald-700 dark:text-emerald-300" : "text-destructive")}>
      {state.message}
    </p>
  );
}
