/**
 * Series colours for every chart (README "Charts"). The palette lives in `src/app/globals.css` as
 * `--chart-1` … `--chart-8` (light and `.dark` values), a categorical palette validated for
 * colour-blind separation IN THIS ORDER. Rules:
 *
 * - Slots are assigned in fixed order and never cycled: a 9th series is not a new colour — fold
 *   the rest into "Other" (or use small multiples).
 * - Colour follows the entity, never its rank: give each series the slot of its stable key
 *   (`stableSeriesSlots`), so filtering or re-sorting never repaints the survivors.
 * - A single-series chart uses slot 1 and needs no legend (its title says what it shows).
 */

export const CHART_SLOTS = 8;

/** The CSS colour of slot 1–8. */
export function seriesColor(slot: number): string {
  if (!Number.isInteger(slot) || slot < 1 || slot > CHART_SLOTS) throw new RangeError(`chart slot must be 1-${CHART_SLOTS}`);
  return `var(--chart-${slot})`;
}

/**
 * Slot per series key, stable across filters: keys are ordered by `compare` (default: as strings)
 * and take slots 1, 2, 3… Keys beyond the 8th get `null` (fold them into "Other").
 */
export function stableSeriesSlots(keys: readonly string[], compare: (a: string, b: string) => number = (a, b) => (a < b ? -1 : a > b ? 1 : 0)): Map<string, number | null> {
  const ordered = [...new Set(keys)].sort(compare);
  return new Map(ordered.map((key, index) => [key, index < CHART_SLOTS ? index + 1 : null]));
}
