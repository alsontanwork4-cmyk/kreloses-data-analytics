/**
 * Display-only formatting (components, CSV). Never use these for maths: the Analytics Service has
 * already done it. Money formatting is in `./money` (`formatRinggit`).
 */

const COUNT = new Intl.NumberFormat("en-MY", { maximumFractionDigits: 0 });

/** `1234` → `"1,234"`. */
export function formatCount(value: number): string {
  return COUNT.format(value);
}

/** A signed count change: `"+6"`, `"−2"`, `"0"`. */
export function formatCountChange(value: number): string {
  return value > 0 ? `+${formatCount(value)}` : value < 0 ? `−${formatCount(-value)}` : "0";
}

/** `154.6` → `"+154.6%"`, `-55.3` → `"−55.3%"`, `0` → `"0.0%"`, `null` → `"n/a"`. */
export function formatPercentChange(value: number | null): string {
  if (value === null) return "n/a";
  const text = Math.abs(value).toFixed(1);
  return value > 0 ? `+${text}%` : value < 0 ? `−${text}%` : `${text}%`;
}

/** A run's length: `"8 s"`, `"2 min 05 s"`, `"1 h 02 min"`. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${String(seconds % 60).padStart(2, "0")} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}
