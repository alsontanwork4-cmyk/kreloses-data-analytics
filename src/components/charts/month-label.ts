const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `'2026-09'` → `'Sep 2026'` (display only; deterministic, so safe on server and client). */
export function formatMonth(month: string): string {
  const [year, number] = month.split("-").map(Number) as [number, number];
  return `${MONTHS[number - 1] ?? "?"} ${year}`;
}
