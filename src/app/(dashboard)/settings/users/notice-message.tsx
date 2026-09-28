import { cn } from "@/lib/utils";

import type { Notice } from "./messages";

/**
 * The outcome of an invite or removal. The live region is always rendered, so screen readers
 * announce each new message (errors assertively).
 */
export function NoticeMessage({ notice, testId }: { notice: Notice | null; testId: string }) {
  return (
    <div aria-live="polite" className="empty:hidden">
      {notice ? (
        <p
          role={notice.tone === "error" ? "alert" : undefined}
          data-testid={testId}
          data-tone={notice.tone}
          className={cn(
            "rounded-md px-3 py-2 text-sm [overflow-wrap:anywhere]",
            notice.tone === "success" && "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
            notice.tone === "warning" && "bg-amber-500/10 text-amber-900 dark:text-amber-200",
            notice.tone === "error" && "bg-destructive/10 text-destructive",
          )}
        >
          {notice.text}
        </p>
      ) : null}
    </div>
  );
}
