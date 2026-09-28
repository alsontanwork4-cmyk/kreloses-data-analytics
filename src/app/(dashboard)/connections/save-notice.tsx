import { CheckCircle2, TriangleAlert } from "lucide-react";

import { cn } from "@/lib/utils";

import type { SaveConnectionState } from "./actions";

/** The outcome of the last save: login test passed, or saved-but-failed with the reason. */
export function SaveNotice({ state }: { state: Extract<SaveConnectionState, { status: "saved" }> }) {
  const ok = state.testStatus === "ok";
  const Icon = ok ? CheckCircle2 : TriangleAlert;
  return (
    <p
      role="status"
      className={cn(
        "flex items-start gap-2 rounded-md px-3 py-2 text-sm",
        ok ? "bg-emerald-600/10 text-emerald-800 dark:text-emerald-300" : "bg-destructive/10 text-destructive",
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{state.message}</span>
    </p>
  );
}
