import { formatClinicDateTime } from "@/filters";
import { formatCount } from "@/lib/format";
import type { BackfillProgress } from "@/sync/backfill-progress";

/**
 * Display words for a connection's history backfill (#8). Display only: every number comes from
 * `getBackfillProgress` (src/sync/backfill-progress.ts).
 */
export type BackfillTone = "done" | "working" | "waiting" | "stopped";

export function backfillState(progress: BackfillProgress): { label: string; tone: BackfillTone } {
  switch (progress.status) {
    case "complete":
      return { label: "Complete", tone: "done" };
    case "paused":
      return { label: "Paused", tone: "stopped" };
    case "not_started":
      return { label: "Not started", tone: "stopped" };
    case "active":
      if (progress.loginStatus === "failed") return { label: "Waiting for the login to work", tone: "waiting" };
      return progress.started ? { label: "Loading history", tone: "working" } : { label: "Waiting for its first night", tone: "waiting" };
  }
}

const MONTH = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

/** `"2025-03"` → `"March 2025"`. */
export function monthName(month: string): string {
  return MONTH.format(new Date(`${month}-01T00:00:00Z`));
}

/** `"1,234 of about 16,000 invoices"` / `"1,234 of 16,000 invoices"` / `"1,234 invoices (total not known yet)"`. */
export function invoicesText(progress: BackfillProgress): string {
  const { done, total, estimated } = progress.invoices;
  if (total === null) return `${formatCount(done)} ${done === 1 ? "invoice" : "invoices"} (total not known yet)`;
  return `${formatCount(done)} of ${estimated ? "about " : ""}${formatCount(total)} invoices`;
}

/** `"about 3 nights"`, `"none"`, or `"not known yet"`. */
export function nightsLeftText(progress: BackfillProgress): string {
  const nights = progress.estimatedNightsLeft;
  if (nights === null) return "not known yet";
  if (nights === 0) return "none";
  return nights === 1 ? "about 1 night" : `about ${formatCount(nights)} nights`;
}

/** The night window's requests: `"Tonight so far"` while in it, else `"Last night"`. */
export function requestsLabel(progress: BackfillProgress): string {
  return progress.night.inWindow ? "Kreloses requests tonight" : "Kreloses requests last night";
}

/** One short line for the Connections page. */
export function backfillSummaryText(progress: BackfillProgress): string {
  switch (progress.status) {
    case "complete":
      return `History from ${monthName(progress.dateFrom.slice(0, 7))} loaded${progress.completedAt ? ` (${formatClinicDateTime(progress.completedAt)})` : ""}.`;
    case "paused":
      return `History backfill paused at ${progress.months.done} of ${progress.months.total} months.`;
    case "not_started":
      return "History backfill not started.";
    case "active": {
      if (progress.loginStatus === "failed") return "History backfill waits until the login works again.";
      if (!progress.started) return `History backfill (from ${monthName(progress.dateFrom.slice(0, 7))}) runs at night once its trigger is set up.`;
      const percent = progress.invoices.percent === null ? "" : `${progress.invoices.percent}% of invoices, `;
      const loading = `Loading history: ${percent}${progress.months.done} of ${progress.months.total} months, ${nightsLeftText(progress)} left.`;
      return progress.noChunkLastNight ? `${loading} No chunk ran last night: check the backfill trigger.` : loading;
    }
  }
}

/**
 * The backfill only runs when something calls its endpoint at night (the GitHub Actions workflow
 * the owner enables): said while it has not started, and when a whole night went by without a chunk.
 */
export function triggerNote(progress: BackfillProgress): { tone: "info" | "warning"; text: string } | null {
  if (progress.status !== "active" || progress.loginStatus === "failed") return null;
  if (!progress.started) {
    return {
      tone: "info",
      text: "It runs at night once the backfill trigger is set up (GitHub Actions: README, “History backfill”). Nothing runs until then.",
    };
  }
  if (progress.noChunkLastNight) {
    return {
      tone: "warning",
      text: "No backfill chunk ran last night. Check that the backfill trigger is still set up and running (GitHub Actions: README, “History backfill”).",
    };
  }
  return null;
}
