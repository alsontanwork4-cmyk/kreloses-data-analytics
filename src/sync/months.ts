import { clinicToday, endOfMonth, isIsoDate, type IsoDate } from "@/filters";

import type { SyncResult } from "./engine";

/** The first month "Sync now" offers: history is kept from 1 Jan 2024 (spec). */
export const HISTORY_START_MONTH = "2024-01";

const MONTH = /^(\d{4})-(\d{2})$/;
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** `"2026-09"` → `{from: "2026-09-01", to: "2026-09-30"}`; null for anything else. */
export function monthRange(month: string): { from: IsoDate; to: IsoDate } | null {
  if (!MONTH.test(month) || !isIsoDate(`${month}-01`)) return null;
  return { from: `${month}-01`, to: endOfMonth(`${month}-01`) };
}

/** `"2026-09"` → `"September 2026"`. */
export function monthLabel(month: string): string {
  const [, year, number] = MONTH.exec(month) ?? [];
  return year && number ? `${MONTH_NAMES[Number(number) - 1]} ${year}` : month;
}

/** Months "Sync now" can read: the current clinic month first, back to January 2024. */
export function syncMonthOptions(now: Date = new Date()): { value: string; label: string }[] {
  const current = clinicToday(now).slice(0, 7);
  const options: { value: string; label: string }[] = [];
  let [year, month] = current.split("-").map(Number) as [number, number];
  for (let value = current; value >= HISTORY_START_MONTH; ) {
    options.push({ value, label: monthLabel(value) });
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
    value = `${year}-${String(month).padStart(2, "0")}`;
  }
  return options;
}

/** What to tell the owner after "Sync now". */
export function describeSyncResult(result: SyncResult, what: string): { tone: "ok" | "warning" | "error"; message: string } {
  switch (result.status) {
    case "succeeded":
    case "partial": {
      if (result.status === "partial" && result.stoppedAtTimeLimit !== false) {
        return {
          tone: "warning",
          message: `Stopped ${what} at the time limit after ${plural(result.counts.invoicesSeen, "invoice")}. Sync ${what} again to carry on from where it stopped.`,
        };
      }
      // Read to the end (a `partial` here only lacks some invoice pages, which its warning explains).
      const { invoicesSeen, inserted, updated, unchanged, lineItemsRead } = result.counts;
      const done = `Synced ${what}: ${plural(invoicesSeen, "invoice")} read (${inserted} new, ${updated} changed, ${unchanged} unchanged); line items read for ${plural(lineItemsRead, "invoice")}.`;
      const warnings = result.warnings.map((warning) => warning.message);
      return { tone: warnings.length > 0 ? "warning" : "ok", message: [done, ...warnings].join(" ") };
    }
    case "failed":
      return { tone: "error", message: `Sync of ${what} failed. ${result.error?.message ?? ""}`.trim() };
    case "busy":
      return {
        tone: "warning",
        message:
          result.heldFor === "sync"
            ? "A sync is already running for this connection. See Sync status; try again when it has finished."
            : "This Kreloses login is being tested right now. Try again in a moment.",
      };
    case "not_found":
      return { tone: "error", message: "That connection no longer exists. Reload the page." };
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
