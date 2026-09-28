"use client";

import { Pause, Play } from "lucide-react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";

/**
 * The owner's "Start backfill" / "Pause backfill" button for one connection (#8). The Server Actions
 * are passed in by the page (they re-check the owner role themselves).
 */
export function BackfillControl({
  connectionId,
  action,
  kind,
}: {
  connectionId: string;
  action: (formData: FormData) => Promise<void>;
  kind: "start" | "pause";
}) {
  return (
    <form action={action}>
      <input type="hidden" name="id" value={connectionId} />
      <Submit kind={kind} />
    </form>
  );
}

function Submit({ kind }: { kind: "start" | "pause" }) {
  const { pending } = useFormStatus();
  const text = kind === "start" ? "Start backfill" : "Pause backfill";
  return (
    <Button type="submit" variant="outline" disabled={pending} aria-busy={pending || undefined}>
      {kind === "start" ? <Play /> : <Pause />}
      {pending ? (kind === "start" ? "Starting…" : "Pausing…") : text}
    </Button>
  );
}
