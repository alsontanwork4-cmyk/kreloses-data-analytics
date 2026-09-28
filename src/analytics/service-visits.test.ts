import { beforeAll, describe, expect, it } from "vitest";

import { useTestDatabase } from "@/db/testing";
import { SYNTHETIC_ACCOUNTS } from "@/kreloses/testing/fake-kreloses";
import { runSync } from "@/sync/engine";
import { clearSyncTables, createSyncHarness } from "@/sync/test-support";

import type { BranchScope } from "./facts";
import { retentionFakeData } from "./retention-fixture";
import { serviceVisitLines, serviceVisits, syncedThrough } from "./service-visits";

/**
 * The service-visit definition (`METRIC_DEFINITIONS.serviceVisit`) every visit-based metric shares
 * (retention #13, post-op follow-up #15), over the hand-built retention sales (./retention-fixture.ts;
 * the visit list is documented in retention.test.ts). Customers are shown by Kreloses id (91001 = C1001).
 */
describe("Analytics Service: service visits", () => {
  const db = useTestDatabase();
  let north: BranchScope;
  let south: BranchScope;
  const ALL: BranchScope = { all: true };

  beforeAll(async () => {
    await clearSyncTables(db.sql);
    const { rows, overviews } = retentionFakeData();
    const h = createSyncHarness(db.sql, { fake: { saleList: { rows }, saleOverviews: overviews }, now: new Date("2026-10-01T02:00:00Z") });
    const connectionId = await h.connect(SYNTHETIC_ACCOUNTS.both, "Both branches");
    expect(await runSync(h.deps(), connectionId, "manual", { dateRange: { from: "2024-01-01", to: "2026-09-30" } })).toMatchObject({ status: "partial" });
    const branches = await db.sql<{ id: string; krelosesLocationId: string }[]>`select id::text, kreloses_location_id from branches`;
    north = { all: false, ids: [branches.find((row) => row.krelosesLocationId === "1101")!.id] };
    south = { all: false, ids: [branches.find((row) => row.krelosesLocationId === "1102")!.id] };
  });

  const visits = async (branches: BranchScope) =>
    (
      await db.sql<{ day: string; customer: string }[]>`
        select v.sale_date::text as day, c.kreloses_customer_id as customer
        from (${serviceVisits(db.sql, branches)}) v join customers c on c.id = v.customer_id
        order by 1, 2
      `
    ).map((row) => `${row.day} ${row.customer}`);

  it("is one row per customer and clinic day with a sold service line on an active, synced sale", async () => {
    // Not visits: products only (C1004 2025-03-03), a cancelled sale (C1005 2025-01-06), a returned service and a
    // sale whose line items are not synced (C1011 2026-03), walk-ins (2025-12-30, 2025-12-31, 2026-01-26).
    expect(await visits(ALL)).toEqual([
      "2024-01-08 91001",
      "2024-05-06 91002",
      "2024-07-01 91003",
      "2024-09-02 91004",
      "2024-10-07 91005",
      "2025-02-10 91001",
      "2025-04-07 91009",
      "2025-05-05 91010",
      "2025-06-02 91002",
      "2025-07-07 91003",
      "2025-08-04 91011",
      "2025-10-06 91014",
      "2025-11-03 91014",
      "2026-01-05 91006",
      "2026-01-12 91001",
      "2026-01-19 91010",
      "2026-02-02 91007",
      "2026-02-09 91009",
      "2026-03-02 91008",
      "2026-03-23 91003",
      "2026-04-05 91006",
      "2026-05-04 91007",
      "2026-07-02 91013",
      "2026-08-03 91012",
      "2026-08-10 91012",
      "2026-09-30 91001",
      "2026-09-30 91013",
    ]);
    expect(await visits(south)).toEqual([
      "2024-10-07 91005",
      "2025-07-07 91003",
      "2025-11-03 91014",
      "2026-01-05 91006",
      "2026-01-19 91010",
      "2026-02-02 91007",
      "2026-03-23 91003",
      "2026-04-05 91006",
      "2026-05-04 91007",
      "2026-08-03 91012",
      "2026-08-10 91012",
    ]);
    expect(await visits(north)).toHaveLength(16);
    expect(await visits({ all: false, ids: [] })).toEqual([]);
  });

  it("keeps each credited service line with who it is credited to now", async () => {
    const lines = await db.sql<{ day: string; branch: string; item: string; staff: string | null; creditGroup: string }[]>`
      select v.sale_date::text as day, b.name as branch, l.item_name as item, s.full_name as staff, v.credit_group
      from (${serviceVisitLines(db.sql, ALL)}) v
      join customers c on c.id = v.customer_id
      join branches b on b.id = v.branch_id
      join invoice_lines l on l.id = v.invoice_line_id and l.invoice_id = v.invoice_id
      left join staff s on s.id = v.staff_id
      where c.kreloses_customer_id in ('91003', '91004', '91009', '91012') and v.sale_date in ('2024-07-01', '2024-09-02', '2026-02-09', '2026-08-10')
      order by 1, 3
    `;
    expect(lines).toEqual([
      // Two invoices, two doctors, one day: three service lines of one visit.
      { day: "2024-07-01", branch: "Branch North", item: "Consultation", staff: "Dr Alpha Anderson", creditGroup: "doctor" },
      { day: "2024-07-01", branch: "Branch North", item: "Dental scaling", staff: "Dr Bravo Brown", creditGroup: "doctor" },
      { day: "2024-07-01", branch: "Branch North", item: "X-ray", staff: "Dr Bravo Brown", creditGroup: "doctor" },
      // Dr Bravo's product on the same invoice is not a service line.
      { day: "2024-09-02", branch: "Branch North", item: "Consultation", staff: "Dr Alpha Anderson", creditGroup: "doctor" },
      { day: "2026-02-09", branch: "Branch North", item: "Nail clipping", staff: "Charlie Chen", creditGroup: "other" },
      { day: "2026-08-10", branch: "Branch South", item: "Consultation", staff: null, creditGroup: "no_staff" },
    ]);
  });

  it("says how far the synced sales go, per branch scope", async () => {
    const through = async (branches: BranchScope) => (await db.sql<{ day: string | null }[]>`select ${syncedThrough(db.sql, branches)}::text as day`)[0]!.day;
    expect(await through(ALL)).toBe("2026-09-30");
    expect(await through(north)).toBe("2026-09-30");
    expect(await through(south)).toBe("2026-08-10");
    expect(await through({ all: false, ids: [] })).toBeNull();
  });
});
