import { beforeAll, describe, expect, it } from "vitest";

import { useTestDatabase } from "@/db/testing";
import { SYNTHETIC_ACCOUNTS } from "@/kreloses/testing/fake-kreloses";
import { listStaffMembers, remapAlias, setStaffKind } from "@/staff/store";
import { runSync } from "@/sync/engine";
import { clearSyncTables, createSyncHarness, type SyncHarness } from "@/sync/test-support";

import { getDoctorRanking, getOverviewKpis, getPendingLineItems, getStaffAliasRevenue, listDoctors } from "./index";

/**
 * Seam 1: the Sync Engine reads the synthetic Sale List AND each invoice's Sale Overview page
 * (src/kreloses/__fixtures__/sale-overviews.json) from the fake Kreloses into a throwaway
 * database; the Analytics Service must then return exactly these HAND-COMPUTED figures.
 *
 * Credited lines, September 2026 (active sales; KL days). "→" = revenue (credited amount less any refund share).
 *   North
 *   700101 C1  Dr Alpha: 150 + 900 + 200 less a (50.00) discount line spread by charged amount → 144.00 + 864.00 + 192.00 = 1,200.00
 *   700102 C2  Dr Bravo 80.00 · Dr Alpha 120.00 + 2.5 × 72.20 = 180.50                         (lines = net, nothing spread)
 *   700104 C3  Dr Bravo 3 × 350 → 1,023.31 and 1,200 less 120 item discount → 1,052.54 · no staff 180 → 175.42
 *              · "North General" 0.5 × 100 → 48.73          (a (60.00) voucher spread by charged 1,050/1,080/180/50)
 *   700105 C2  "Charlie" 45.00 · no staff 54.90
 *   South
 *   700201 C4  "Dr Delta" (not in the staff list: a deleted doctor) 90 → 84.37 · 2 × 275 → 515.63 ((40.00) spread; tie → line 1)
 *   700202 C5  Dr Bravo 700.00 + 400.00 (credited 1,100.00 = the net) less a 100.00 refund spread by charged
 *              700 / 400 (63.64 / 36.36) → 636.36 + 363.64 = 1,000.00 (#6: refunds come off the revenue base)
 *   700203 C1  Dr Bravo 100 → 96.15 · "Dr. Alpha" 160 → 153.85  (lines 260.00 vs net 250.00: the 10.00 gap spread by charged)
 *   700205 —   "South General" 45.00 (walk-in: no customer)
 *   700206 C4  "Dr Delta" return of 1 × 120.00 → (120.00)
 *   Cancelled 700103, 700204: never counted.                                    Total 5,755.40 (= revenue bases)
 *
 * Doctors (ranked by revenue; share = revenue ÷ 5,755.40, one decimal; AOV = revenue ÷ distinct customers):
 *   Dr Bravo Brown     3,252.00 · 4 invoices · 4 customers (C2 C3 C5 C1) · AOV 813.00 · 6 items → 1.50 · 56.5 %
 *     North 2,155.85 · 2 · 2 · 1,077.93 (1,077.925) · 3 → 1.50 · 37.5 %   South 1,096.15 · 2 · 2 · 548.08 (548.075) · 3 → 1.50 · 19.0 %
 *   Dr Alpha Anderson  1,654.35 · 3 invoices · 2 customers (C1 C2) · AOV 827.18 (827.175) · 6 items → 2.00 · 28.7 %
 *     North 1,500.50 · 2 · 2 · 750.25 · 5 → 2.50 · 26.1 %                  South 153.85 · 1 · 1 · 153.85 · 1 → 1.00 · 2.7 %
 *   Dr Delta             480.00 · 2 invoices · 1 customer (C4) · AOV 480.00 · 3 items → 1.50 · 8.3 %  (South only)
 * Separate groups (never ranked with doctors):
 *   Other staff: Charlie Chen 45.00 · 1 · 1 · 45.00 · 1 → 1.00 · 0.8 %
 *   Generic accounts: 93.73 · 2 invoices · 1 customer (the walk-in is nobody) · 93.73 · 2 → 1.00 · 1.6 %
 *     Branch North General 48.73 · 1 · 1 · 48.73 · 0.8 %    Branch South General 45.00 · 1 · 0 · no AOV · 0.8 %
 *   No staff on line: 230.32 · 2 invoices · 2 customers · AOV 115.16 · 2 → 1.00 · 4.0 %
 *   Line items not synced yet: 0.00
 *
 * Previous period (2–31 Aug 2026): Dr Alpha 500.00 (700090, C1) · Dr Bravo 1,000.00 (700091) · Dr Delta 800.00 (700092).
 * Same period last year (Sep 2025): Dr Alpha 12,345.60 (600001, C1) · Dr Bravo 654.40 (600002) · no staff 100.00 (600003).
 */
const { both } = SYNTHETIC_ACCOUNTS;
const SEPTEMBER = { dateFrom: "2026-09-01", dateTo: "2026-09-30" };
const PERIOD = { dateFrom: "2026-09-01", dateTo: "2026-09-30" };

describe("Analytics Service: doctors (fed by the Sync Engine, line items included)", () => {
  const db = useTestDatabase();
  let h: SyncHarness;
  let connectionId: string;
  let branch: { north: string; south: string };
  let staff: Record<string, string>;

  const sync = (dateRange = { from: "2025-09-01", to: "2026-09-30" }) => runSync(h.deps(), connectionId, "manual", { dateRange, pageSize: 7 });

  beforeAll(async () => {
    await clearSyncTables(db.sql);
    h = createSyncHarness(db.sql, { now: new Date("2026-10-01T02:00:00Z") });
    connectionId = await h.connect(both, "Both branches");
    expect(await sync()).toMatchObject({ status: "succeeded", counts: { invoicesSeen: 20, inserted: 20, lineItemsRead: 17 } });
    const branches = await db.sql<{ id: string; krelosesLocationId: string }[]>`select id::text, kreloses_location_id from branches`;
    branch = {
      north: branches.find((row) => row.krelosesLocationId === "1101")!.id,
      south: branches.find((row) => row.krelosesLocationId === "1102")!.id,
    };
    const rows = await db.sql<{ id: string; fullName: string }[]>`select id::text, full_name from staff`;
    staff = Object.fromEntries(rows.map((row) => [row.fullName, row.id]));
  });

  it("reconciles: per branch and per month, credited lines' revenue adds up to the invoices' revenue bases, and their credited amounts to the nets, to the sen", async () => {
    const rows = await db.sql<{ branch: string; month: string; base: string | null; revenue: string | null; net: string | null; credited: string | null }[]>`
      with bases as (
        select b.name as branch, to_char(i.sale_date, 'YYYY-MM') as month, sum(i.revenue_base) as base,
          sum(case when i.status = 'active' then i.net_amount else 0 end) as net
        from invoices i join branches b on b.id = i.branch_id group by 1, 2
      ),
      credited as (
        select b.name as branch, to_char(i.sale_date, 'YYYY-MM') as month, sum(c.revenue_amount) as revenue, sum(c.credited_amount) as credited
        from credited_lines c join invoices i on i.id = c.invoice_id join branches b on b.id = i.branch_id
        where i.status = 'active' group by 1, 2
      )
      select coalesce(n.branch, c.branch) as branch, coalesce(n.month, c.month) as month,
        n.base::text, c.revenue::text, n.net::text, c.credited::text
      from bases n full join credited c on c.branch = n.branch and c.month = n.month
      order by 1, 2
    `;
    expect(rows).toEqual([
      { branch: "Branch North", month: "2025-09", base: "12345.60", revenue: "12345.60", net: "12345.60", credited: "12345.60" },
      { branch: "Branch North", month: "2025-10", base: "999.00", revenue: "999.00", net: "999.00", credited: "999.00" },
      { branch: "Branch North", month: "2026-08", base: "1500.00", revenue: "1500.00", net: "1500.00", credited: "1500.00" },
      { branch: "Branch North", month: "2026-09", base: "3980.40", revenue: "3980.40", net: "3980.40", credited: "3980.40" },
      { branch: "Branch South", month: "2025-09", base: "754.40", revenue: "754.40", net: "754.40", credited: "754.40" },
      { branch: "Branch South", month: "2026-08", base: "1100.00", revenue: "1100.00", net: "1100.00", credited: "1100.00" },
      // 700202's 100.00 refund: off the revenue, never off what its lines were charged (so never a discount).
      { branch: "Branch South", month: "2026-09", base: "1775.00", revenue: "1775.00", net: "1875.00", credited: "1875.00" },
    ]);
  });

  it("ranks doctors by revenue with AOV per customer, invoices, items per invoice and share; other groups apart", async () => {
    const ranking = await getDoctorRanking(db.sql, SEPTEMBER);
    expect(ranking.period).toEqual(PERIOD);
    expect(ranking.totalRevenue).toBe("5755.40");
    expect(ranking.doctors).toEqual([
      {
        staffId: staff["Dr Bravo Brown"],
        name: "Dr Bravo Brown",
        source: "kreloses",
        active: true,
        revenue: "3252.00",
        invoices: 4,
        customers: 4,
        aovPerCustomer: "813.00",
        itemsPerInvoice: 1.5,
        sharePercent: 56.5,
      },
      {
        staffId: staff["Dr Alpha Anderson"],
        name: "Dr Alpha Anderson",
        source: "kreloses",
        active: true,
        revenue: "1654.35",
        invoices: 3,
        customers: 2,
        aovPerCustomer: "827.18",
        itemsPerInvoice: 2,
        sharePercent: 28.7,
      },
      {
        staffId: staff["Dr Delta"],
        name: "Dr Delta",
        source: "alias_only",
        active: true,
        revenue: "480.00",
        invoices: 2,
        customers: 1,
        aovPerCustomer: "480.00",
        itemsPerInvoice: 1.5,
        sharePercent: 8.3,
      },
    ]);
    expect(ranking.groups).toEqual({
      other: {
        revenue: "45.00",
        invoices: 1,
        customers: 1,
        aovPerCustomer: "45.00",
        itemsPerInvoice: 1,
        sharePercent: 0.8,
        members: [
          {
            staffId: staff["Charlie Chen"],
            name: "Charlie Chen",
            source: "kreloses",
            active: true,
            revenue: "45.00",
            invoices: 1,
            customers: 1,
            aovPerCustomer: "45.00",
            itemsPerInvoice: 1,
            sharePercent: 0.8,
          },
        ],
      },
      generic: {
        revenue: "93.73",
        invoices: 2,
        customers: 1,
        aovPerCustomer: "93.73",
        itemsPerInvoice: 1,
        sharePercent: 1.6,
        members: [
          {
            staffId: staff["Branch North General"],
            name: "Branch North General",
            source: "kreloses",
            active: true,
            revenue: "48.73",
            invoices: 1,
            customers: 1,
            aovPerCustomer: "48.73",
            itemsPerInvoice: 1,
            sharePercent: 0.8,
          },
          {
            staffId: staff["Branch South General"],
            name: "Branch South General",
            source: "kreloses",
            active: true,
            revenue: "45.00",
            invoices: 1,
            customers: 0,
            aovPerCustomer: null,
            itemsPerInvoice: 1,
            sharePercent: 0.8,
          },
        ],
      },
      noStaff: { revenue: "230.32", invoices: 2, customers: 2, aovPerCustomer: "115.16", itemsPerInvoice: 1, sharePercent: 4 },
      pending: { revenue: "0.00", invoices: 0, customers: 0, aovPerCustomer: null, itemsPerInvoice: null, sharePercent: 0 },
    });
  });

  it("splits each doctor by branch: AOV per customer counted per branch", async () => {
    const ranking = await getDoctorRanking(db.sql, SEPTEMBER, { splitByBranch: true });
    const split = Object.fromEntries(ranking.doctors.map((doctor) => [doctor.name, doctor.branches]));
    expect(split["Dr Bravo Brown"]).toEqual([
      { branchId: branch.north, branchName: "Branch North", revenue: "2155.85", invoices: 2, customers: 2, aovPerCustomer: "1077.93", itemsPerInvoice: 1.5, sharePercent: 37.5 },
      { branchId: branch.south, branchName: "Branch South", revenue: "1096.15", invoices: 2, customers: 2, aovPerCustomer: "548.08", itemsPerInvoice: 1.5, sharePercent: 19 },
    ]);
    expect(split["Dr Alpha Anderson"]).toEqual([
      { branchId: branch.north, branchName: "Branch North", revenue: "1500.50", invoices: 2, customers: 2, aovPerCustomer: "750.25", itemsPerInvoice: 2.5, sharePercent: 26.1 },
      { branchId: branch.south, branchName: "Branch South", revenue: "153.85", invoices: 1, customers: 1, aovPerCustomer: "153.85", itemsPerInvoice: 1, sharePercent: 2.7 },
    ]);
    expect(split["Dr Delta"]).toEqual([
      { branchId: branch.south, branchName: "Branch South", revenue: "480.00", invoices: 2, customers: 1, aovPerCustomer: "480.00", itemsPerInvoice: 1.5, sharePercent: 8.3 },
    ]);
    // Without the split there is no per-branch breakdown.
    expect((await getDoctorRanking(db.sql, SEPTEMBER)).doctors[0]).not.toHaveProperty("branches");
  });

  it("applies the branch and doctor filters (share stays a share of all revenue in the period and branches)", async () => {
    const north = await getDoctorRanking(db.sql, { ...SEPTEMBER, branchIds: [branch.north] });
    expect(north.totalRevenue).toBe("3980.40");
    expect(north.doctors.map((doctor) => [doctor.name, doctor.revenue, doctor.customers, doctor.sharePercent])).toEqual([
      ["Dr Bravo Brown", "2155.85", 2, 54.2],
      ["Dr Alpha Anderson", "1500.50", 2, 37.7],
    ]);

    const alpha = await getDoctorRanking(db.sql, { ...SEPTEMBER, doctorIds: [staff["Dr Alpha Anderson"]!] });
    expect(alpha.totalRevenue).toBe("5755.40");
    expect(alpha.doctors.map((doctor) => [doctor.name, doctor.revenue, doctor.sharePercent])).toEqual([["Dr Alpha Anderson", "1654.35", 28.7]]);
    expect(alpha.groups.noStaff.revenue).toBe("0.00");
    expect(alpha.groups.other.members).toEqual([]);

    const nobody = await getDoctorRanking(db.sql, { ...SEPTEMBER, doctorIds: ["999999", "not-an-id"] });
    expect(nobody.doctors).toEqual([]);
  });

  it("applies the doctor filter to the Overview: revenue, invoices and customers credited to the selected doctors", async () => {
    const kpis = await getOverviewKpis(db.sql, { ...SEPTEMBER, doctorIds: [staff["Dr Alpha Anderson"]!] });
    expect(kpis.total).toEqual({
      revenue: {
        value: "1654.35",
        previousPeriod: { base: "500.00", change: "1154.35", changePercent: 230.9 },
        lastYear: { base: "12345.60", change: "-10691.25", changePercent: -86.6 },
      },
      invoices: { value: 3, previousPeriod: { base: 1, change: 2, changePercent: 200 }, lastYear: { base: 1, change: 2, changePercent: 200 } },
      customers: { value: 2, previousPeriod: { base: 1, change: 1, changePercent: 100 }, lastYear: { base: 1, change: 1, changePercent: 100 } },
      aovPerCustomer: {
        value: "827.18",
        previousPeriod: { base: "500.00", change: "327.18", changePercent: 65.4 },
        lastYear: { base: "12345.60", change: "-11518.42", changePercent: -93.3 },
      },
    });
    expect(kpis.branches.map((row) => [row.branchName, row.revenue.value, row.invoices.value, row.customers.value, row.aovPerCustomer.value])).toEqual([
      ["Branch North", "1500.50", 2, 2, "750.25"],
      ["Branch South", "153.85", 1, 1, "153.85"],
    ]);

    // Two doctors: an invoice or customer they share counts once.
    const two = await getOverviewKpis(db.sql, { ...SEPTEMBER, doctorIds: [staff["Dr Alpha Anderson"]!, staff["Dr Bravo Brown"]!] });
    expect(two.total.revenue.value).toBe("4906.35");
    expect(two.total.invoices.value).toBe(5); // 700101 700102 700104 700202 700203
    expect(two.total.customers.value).toBe(4); // C1 C2 C3 C5
  });

  it("lists the doctors for the filter bar, and each line name's revenue for Settings", async () => {
    expect(await listDoctors(db.sql)).toEqual([
      { id: staff["Dr Alpha Anderson"], name: "Dr Alpha Anderson" },
      { id: staff["Dr Bravo Brown"], name: "Dr Bravo Brown" },
      { id: staff["Dr Delta"], name: "Dr Delta" },
    ]);
    const byAlias = await getStaffAliasRevenue(db.sql, SEPTEMBER);
    const names = await db.sql<{ id: string; rawName: string }[]>`select id::text, raw_name from staff_aliases`;
    expect(Object.fromEntries(names.map((alias) => [alias.rawName, byAlias[alias.id] ?? "0.00"]))).toEqual({
      "Dr Alpha": "1500.50",
      "Dr. Alpha": "153.85",
      "Dr Bravo": "3252.00",
      "Dr Delta": "480.00",
      Charlie: "45.00",
      "North General": "48.73",
      "South General": "45.00",
    });
  });

  it("counts an invoice whose line items are not synced yet at its net amount, so revenue never drops", async () => {
    // 700104 is edited in Kreloses (gross and discount changed, net the same — a line-relevant change, #6)
    // and its page cannot be read this time: its stored lines are stale, so its whole revenue base
    // counts as "line items not synced yet".
    const row = h.fake.saleRows.find((candidate) => candidate.SaleId === 700104)!;
    row.GrossAmount = "2,490.00";
    row.Discounts = "190.00";
    h.clock.advance(3_600_000);
    let pageDown = true;
    h.fake.intercept((request) =>
      pageDown && request.url.pathname === "/Sale/Overview/700104" ? new Response("down", { status: 503 }) : undefined,
    );
    expect(await runSync(h.deps(), connectionId, "manual", { dateRange: { from: "2026-09-01", to: "2026-09-30" }, maxRetries: 0 })).toMatchObject({
      status: "failed",
    });

    const kpis = await getOverviewKpis(db.sql, SEPTEMBER);
    expect(kpis.total.revenue.value).toBe("5755.40");
    expect(kpis.total.invoices.value).toBe(9);
    const ranking = await getDoctorRanking(db.sql, SEPTEMBER);
    expect(ranking.totalRevenue).toBe("5755.40");
    expect(ranking.groups.pending).toEqual({ revenue: "2300.00", invoices: 1, customers: 1, aovPerCustomer: "2300.00", itemsPerInvoice: null, sharePercent: 40 });
    expect(ranking.doctors.find((doctor) => doctor.name === "Dr Bravo Brown")!.revenue).toBe("1176.15"); // 3,252.00 − 2,075.85
    expect(ranking.groups.noStaff.revenue).toBe("54.90");
    // A doctor filter hides pending sales (nobody is credited yet), so pages say how many there are.
    const withDoctor = { ...SEPTEMBER, doctorIds: [staff["Dr Bravo Brown"]!] };
    expect((await getDoctorRanking(db.sql, withDoctor)).groups.pending.invoices).toBe(0);
    expect(await getPendingLineItems(db.sql, withDoctor)).toEqual({ invoices: 1, revenue: "2300.00" });
    expect(await getPendingLineItems(db.sql, { ...withDoctor, branchIds: [branch.south] })).toEqual({ invoices: 0, revenue: "0.00" });

    // The next sync reads the page and everything is credited again.
    pageDown = false;
    const again = await runSync(h.deps(), connectionId, "manual", { dateRange: { from: "2026-09-01", to: "2026-09-30" } });
    expect(again).toMatchObject({ counts: { lineItemsRead: 1 } });
    const after = await getDoctorRanking(db.sql, SEPTEMBER);
    expect(after.groups.pending.revenue).toBe("0.00");
    expect(after.doctors[0]).toMatchObject({ name: "Dr Bravo Brown", revenue: "3252.00" });
  });

  it("crediting a generic-looking name to a doctor keeps the doctor a doctor; a kind the owner set is never changed by a remap", async () => {
    const aliasId = async (raw: string) => (await db.sql`select id::text from staff_aliases where raw_name = ${raw}`)[0]!.id as string;
    const kindOf = async (name: string) => (await listStaffMembers(db.sql)).find((member) => member.name === name)!.kind;

    // "North General" (a generic account's line name) was really Dr Alpha Anderson.
    expect(await remapAlias(db.sql, await aliasId("North General"), staff["Dr Alpha Anderson"]!)).toEqual({ status: "saved" });
    expect(await kindOf("Dr Alpha Anderson")).toBe("doctor");
    const ranking = await getDoctorRanking(db.sql, SEPTEMBER);
    expect(ranking.doctors.map((doctor) => [doctor.name, doctor.revenue])).toEqual([
      ["Dr Bravo Brown", "3252.00"],
      ["Dr Alpha Anderson", "1703.08"], // 1,654.35 + 48.73
      ["Dr Delta", "480.00"],
    ]);
    expect(ranking.groups.generic.members.map((member) => member.name)).toEqual(["Branch South General"]);

    // The owner made Charlie Chen a generic account; crediting a "Dr" name to him does not undo that.
    await setStaffKind(db.sql, staff["Charlie Chen"]!, "generic");
    await remapAlias(db.sql, await aliasId("Dr Delta"), staff["Charlie Chen"]!);
    expect(await kindOf("Charlie Chen")).toBe("generic");

    // Put everything back (the alias-only "Dr Delta" is still listed, so its own entry can be chosen again).
    const deltaEntry = (await listStaffMembers(db.sql)).find((member) => member.name === "Dr Delta")!;
    expect(deltaEntry).toMatchObject({ source: "alias_only", aliases: 0 });
    await remapAlias(db.sql, await aliasId("Dr Delta"), deltaEntry.id);
    await remapAlias(db.sql, await aliasId("North General"), staff["Branch North General"]!);
    await setStaffKind(db.sql, staff["Charlie Chen"]!, "other");
    expect((await getDoctorRanking(db.sql, SEPTEMBER)).doctors.map((doctor) => [doctor.name, doctor.revenue])).toEqual([
      ["Dr Bravo Brown", "3252.00"],
      ["Dr Alpha Anderson", "1654.35"],
      ["Dr Delta", "480.00"],
    ]);
  });

  it("a name that matched nobody can be credited to someone and then back to its own entry, restoring every figure", async () => {
    const [delta] = await db.sql<{ id: string }[]>`select id::text from staff_aliases where raw_name = 'Dr Delta'`;
    const before = await getDoctorRanking(db.sql, SEPTEMBER, { splitByBranch: true });

    await remapAlias(db.sql, delta!.id, staff["Dr Bravo Brown"]!);
    // Its own (alias-only) entry stays on the list of people to credit it to, with no names left.
    const ownEntry = (await listStaffMembers(db.sql)).find((member) => member.source === "alias_only" && member.name === "Dr Delta");
    expect(ownEntry).toMatchObject({ kind: "doctor", aliases: 0 });

    expect(await remapAlias(db.sql, delta!.id, ownEntry!.id)).toEqual({ status: "saved" });
    expect(await getDoctorRanking(db.sql, SEPTEMBER, { splitByBranch: true })).toEqual(before);
  });

  it("follows a remapped line name and a changed kind at once, without re-syncing", async () => {
    const aliasId = (await db.sql`select id::text from staff_aliases where raw_name = 'Dr Delta'`)[0]!.id as string;
    const requests = h.fake.requests.length;

    // The owner says "Dr Delta" was Dr Bravo Brown all along.
    expect(await remapAlias(db.sql, aliasId, staff["Dr Bravo Brown"]!)).toEqual({ status: "saved" });
    let ranking = await getDoctorRanking(db.sql, SEPTEMBER);
    expect(ranking.doctors.map((doctor) => doctor.name)).toEqual(["Dr Bravo Brown", "Dr Alpha Anderson"]);
    // 3,252.00 + 480.00; invoices 4 + 2; customers C1 C2 C3 C5 + C4; items 6 + 3.
    expect(ranking.doctors[0]).toMatchObject({ revenue: "3732.00", invoices: 6, customers: 5, aovPerCustomer: "746.40", itemsPerInvoice: 1.5, sharePercent: 64.8 });

    // Charlie Chen is a doctor after all; Dr Alpha Anderson is recorded as "other" staff.
    await setStaffKind(db.sql, staff["Charlie Chen"]!, "doctor");
    await setStaffKind(db.sql, staff["Dr Alpha Anderson"]!, "other");
    ranking = await getDoctorRanking(db.sql, SEPTEMBER);
    expect(ranking.doctors.map((doctor) => [doctor.name, doctor.revenue])).toEqual([
      ["Dr Bravo Brown", "3732.00"],
      ["Charlie Chen", "45.00"],
    ]);
    expect(ranking.groups.other.members.map((member) => [member.name, member.revenue])).toEqual([["Dr Alpha Anderson", "1654.35"]]);
    expect(ranking.totalRevenue).toBe("5755.40");
    expect(await listDoctors(db.sql)).toEqual([
      { id: staff["Charlie Chen"], name: "Charlie Chen" },
      { id: staff["Dr Bravo Brown"], name: "Dr Bravo Brown" },
    ]);
    expect(h.fake.requests.length).toBe(requests); // nothing was read from Kreloses

    // Put it back for any later test.
    await remapAlias(db.sql, aliasId, staff["Dr Delta"]!);
    await setStaffKind(db.sql, staff["Charlie Chen"]!, "other");
    await setStaffKind(db.sql, staff["Dr Alpha Anderson"]!, "doctor");
  });
});
