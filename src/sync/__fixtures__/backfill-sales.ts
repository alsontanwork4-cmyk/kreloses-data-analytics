import { syntheticSales, type SyntheticSale } from "@/kreloses/testing/synthetic-sales";

/**
 * SYNTHETIC history for the backfill tests (#8): a few months with sales between 1 Jan 2024 and
 * the nightly window, both branches, served by the tests' own fake Kreloses (`createSyncHarness(sql,
 * { fake: { saleList: { rows }, saleOverviews } })`). Every other month is empty. Lines add up to
 * each sale's net (no discounts, no tax), so a sale's revenue is its lines' sum.
 *
 * Hand-computed revenue (active sales only):
 * - Sep 2026: 800901 125.50 + 800902 1,200.00 + 800903 25.00 + 800905 90.00 = 1,440.50
 *   (800904 cancelled). Inside the nightly window of 2 Oct 2026 (18 Aug – 2 Oct).
 * - Mar 2025: 802501 80.00 + 802502 500.00 + 802503 112.40 + 802504 220.00 + 802505 60.00
 *   + 802507 980.00 = 1,952.40 (802506 cancelled). Seven sales: three Sale List pages of 3.
 * - Dec 2024: 802401 80.00 + 802402 45.50 = 125.50 (802402 at 23:30 KL on 31 Dec: still December).
 * - Jan 2024: 802001 75.00 (00:30 KL on 1 Jan: the first minutes of the history) + 802002 93.20
 *   = 168.20. 802003 (23:30 KL on 31 Dec 2023) is before the history starts: never loaded.
 *
 * 16 sales from 1 Jan 2024 (2 cancelled), so 14 invoice pages to read.
 */
export const BACKFILL_SALES: readonly SyntheticSale[] = [
  // September 2026
  { saleId: 800901, branch: "north", customer: 1, at: "2026-09-05 10:00", lines: [{ name: "CONSULTATION", staff: "Dr Alpha", amount: "80.00" }, { name: "VACCINE DHPPi", staff: "Dr Alpha", amount: "45.50" }] },
  { saleId: 800902, branch: "south", customer: 2, at: "2026-09-12 15:30", lines: [{ name: "SURGERY", staff: "Dr Bravo", amount: "1200.00" }] },
  { saleId: 800903, branch: "north", customer: null, at: "2026-09-20 09:00", lines: [{ name: "SHAMPOO", staff: null, amount: "25.00", itemType: 1 }] },
  { saleId: 800904, branch: "south", customer: 3, at: "2026-09-28 18:00", status: "Cancelled", lines: [{ name: "CONSULTATION", staff: "Dr Bravo", amount: "80.00" }] },
  { saleId: 800905, branch: "north", customer: 1, at: "2026-09-30 23:30", lines: [{ name: "CONSULTATION", staff: "Dr Alpha", amount: "90.00" }] },
  // March 2025
  { saleId: 802501, branch: "north", customer: 4, at: "2025-03-01 00:30", lines: [{ name: "CONSULTATION", staff: "Dr Alpha", amount: "80.00" }] },
  { saleId: 802502, branch: "north", customer: 5, at: "2025-03-03 11:00", lines: [{ name: "DENTAL SCALING", staff: "Dr Alpha", amount: "350.00" }, { name: "X-RAY", staff: "Dr Bravo", amount: "150.00" }] },
  { saleId: 802503, branch: "south", customer: 6, at: "2025-03-07 14:00", lines: [{ name: "CONSULTATION", staff: "Dr Bravo", amount: "80.00" }, { name: "MEDICINE", staff: null, amount: "32.40", itemType: 1 }] },
  { saleId: 802504, branch: "south", customer: 4, at: "2025-03-15 16:45", lines: [{ name: "REHAB SESSION", staff: "Dr Bravo", amount: "220.00" }] },
  { saleId: 802505, branch: "north", customer: 7, at: "2025-03-21 10:15", lines: [{ name: "GROOMING", staff: null, amount: "60.00" }] },
  { saleId: 802506, branch: "south", customer: null, at: "2025-03-28 12:00", status: "Cancelled", lines: [{ name: "CONSULTATION", staff: "Dr Bravo", amount: "80.00" }] },
  { saleId: 802507, branch: "north", customer: 5, at: "2025-03-31 23:59", lines: [{ name: "SURGERY", staff: "Dr Alpha", amount: "980.00" }] },
  // December 2024
  { saleId: 802401, branch: "north", customer: 8, at: "2024-12-24 10:00", lines: [{ name: "CONSULTATION", staff: "Dr Alpha", amount: "80.00" }] },
  { saleId: 802402, branch: "south", customer: 9, at: "2024-12-31 23:30", lines: [{ name: "VACCINE DHPPi", staff: "Dr Bravo", amount: "45.50" }] },
  // January 2024 (and one sale just before the history starts)
  { saleId: 802001, branch: "north", customer: 10, at: "2024-01-01 00:30", lines: [{ name: "CONSULTATION", staff: "Dr Alpha", amount: "75.00" }] },
  { saleId: 802002, branch: "south", customer: 11, at: "2024-01-15 10:00", lines: [{ name: "CONSULTATION", staff: "Dr Bravo", amount: "75.00" }, { name: "MEDICINE", staff: "Dr Bravo", amount: "18.20", itemType: 1 }] },
  { saleId: 802003, branch: "north", customer: 10, at: "2023-12-31 23:30", lines: [{ name: "CONSULTATION", staff: "Dr Alpha", amount: "75.00" }] },
];

/** Fresh Sale List rows + invoice page models for `BACKFILL_SALES` (tests mutate them). */
export function backfillFake() {
  const { rows, overviews } = syntheticSales(BACKFILL_SALES);
  return { saleList: { rows }, saleOverviews: overviews };
}

/** The active sales whose invoice pages the backfill reads (from 1 Jan 2024). */
export const BACKFILL_ACTIVE_SALE_IDS = BACKFILL_SALES.filter((sale) => sale.status !== "Cancelled" && sale.at >= "2024-01-01").map((sale) => String(sale.saleId));
