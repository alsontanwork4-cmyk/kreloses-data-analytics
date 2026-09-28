import { beforeEach, describe, expect, it } from "vitest";

import { itemKey, type ItemClassification } from "@/attribution";
import { useTestDatabase } from "@/db/testing";

import {
  addItemRule,
  assignItem,
  classifyItemNames,
  classifyUnclassifiedItems,
  clearItemAssignment,
  deleteItemRule,
  listItemRules,
  listItems,
  loadItemClassifier,
} from "./store";

const NO_FLAGS = { surgery: false, consult: false, vaccine: false, dentalScaling: false, procedure: false };
const as = (group: ItemClassification["group"], flags: Partial<ItemClassification> = {}): ItemClassification => ({ group, ...NO_FLAGS, ...flags });

describe("item groups: stored rules, assignments and classifications", () => {
  const db = useTestDatabase();

  /** What `item_classifications` says about each name. */
  async function stored(names: string[]) {
    const rows = await db.sql<{ itemName: string; mixGroup: string; source: string; isSurgery: boolean; isProcedure: boolean; isConsult: boolean }[]>`
      select item_name, mix_group, source, is_surgery, is_procedure, is_consult from item_classifications where item_name = any(${names})
    `;
    return Object.fromEntries(rows.map((row) => [row.itemName, row.mixGroup]));
  }

  /** Invoice lines for `names` (the Settings list and the recompute read names from sold lines). */
  async function linesNamed(names: { name: string; type?: number }[]) {
    const [branch] = await db.sql<{ id: string }[]>`
      insert into branches (kreloses_location_id, name) values ('9001', 'Branch Test')
      on conflict (kreloses_location_id) do update set name = excluded.name returning id::text
    `;
    const [invoice] = await db.sql<{ id: string }[]>`
      insert into invoices (kreloses_sale_id, sale_number, branch_id, sale_at, status, status_name, gross_amount, discount_amount, net_amount,
        tax_amount, total_amount, payment_status, total_payments, total_refunds, raw_header, fetched_at)
      values (${`t-${Math.random()}`}, 'INV-T', ${branch!.id}, now(), 'active', 'Active', 0, 0, 0, 0, 0, 'Paid', 0, 0, '{}', now())
      returning id::text
    `;
    let lineNo = 1;
    for (const { name, type = 4 } of names) {
      await db.sql`
        insert into invoice_lines (invoice_id, line_no, item_name, item_type, quantity, unit_price, amount)
        values (${invoice!.id}, ${lineNo++}, ${name}, ${type}, ${type === 55 ? null : 1}, ${type === 55 ? null : 0}, 0)
      `;
    }
  }

  beforeEach(async () => {
    await db.sql`delete from invoices`;
    await db.sql`delete from item_classifications`;
    await db.sql`delete from item_assignments`;
    await db.sql`delete from item_group_rules where source = 'owner'`;
  });

  it("the seeded rules put common item names in their group, conservatively (unknown items stay unmapped)", async () => {
    const classify = await loadItemClassifier(db.sql);
    const cases: [string, ItemClassification | "unmapped"][] = [
      ["Consultation", as("consult", { consult: true })],
      ["Consultation - follow up", as("consult", { consult: true })],
      ["TCVM examination", as("consult", { consult: true })],
      ["Surgery consultation", as("consult", { consult: true })],
      // "<procedure> consult(ation)" is a consult, never an operation.
      ["Spay consult", as("consult", { consult: true })],
      ["Neutering consultation", as("consult", { consult: true })],
      ["Spay/neuter consultation", as("consult", { consult: true })],
      ["Pyometra consult", as("consult", { consult: true })],
      ["Hernia repair consult", as("consult", { consult: true })],
      // Combined consult + something: a consult line (so the day is a working day).
      ["Vaccination & consultation", as("consult", { consult: true })],
      ["Consultation + Vaccination", as("consult", { consult: true })],
      ["Deworming + consult", as("consult", { consult: true })],
      // Post-op visits are consults, not surgery.
      ["Surgery follow-up", as("consult", { consult: true })],
      ["Surgery recheck", as("consult", { consult: true })],
      ["Surgery review", as("consult", { consult: true })],
      ["Neuter check-up", as("consult", { consult: true })],
      ["Spay wound check", as("consult", { consult: true })],
      ["Post-op check", as("consult", { consult: true })],
      ["Post-operative review", as("consult", { consult: true })],
      ["Follow-up consultation", as("consult", { consult: true })],
      ["Recheck consult", as("consult", { consult: true })],
      // …but a generic follow-up / recheck keeps its own group (what was done), or stays unmapped.
      ["Follow-up X-ray", as("diagnostics")],
      ["Recheck blood test", as("diagnostics")],
      ["Blood test follow up", as("diagnostics")],
      ["Follow up vaccination", as("preventive", { vaccine: true })],
      ["Medication review", "unmapped"],
      ["Recheck", "unmapped"],
      ["SURGERY", as("surgery", { surgery: true, procedure: true })],
      ["Surgery - Spay", as("surgery", { surgery: true, procedure: true })],
      ["Surgery - FHO", as("surgery", { surgery: true, procedure: true })],
      ["Neutering (cat)", as("surgery", { surgery: true, procedure: true })],
      ["Cryoablation", as("surgery", { surgery: true, procedure: true })],
      ["Cystotomy", as("surgery", { surgery: true, procedure: true })],
      ["Tooth extraction", as("surgery", { surgery: true, procedure: true })],
      ["Pyometra surgery", as("surgery", { surgery: true, procedure: true })],
      ["C-section", as("surgery", { surgery: true, procedure: true })],
      ["Hernia repair", as("surgery", { surgery: true, procedure: true })],
      ["Closed reduction (fracture)", as("surgery", { surgery: true, procedure: true })],
      ["Surgery - Wound stitching", as("surgery", { surgery: true, procedure: true })],
      ["Wound suturing", as("surgery", { surgery: true, procedure: true })],
      ["Caesarean section", as("surgery", { surgery: true, procedure: true })],
      ["Surgery - C section", as("surgery", { surgery: true, procedure: true })],
      // Related surgical charges: surgery lines, but not an operation by themselves.
      ["Surgery pack / consumables", as("surgery", { surgery: true, procedure: false })],
      ["Surgical pack", as("surgery", { surgery: true, procedure: false })],
      ["Surgery - pack (sterile)", as("surgery", { surgery: true, procedure: false })],
      ["Surgical consumables", as("surgery", { surgery: true, procedure: false })],
      ["Surgery consumables", as("surgery", { surgery: true, procedure: false })],
      // A "package" / "pack" of an operation is the operation.
      ["Surgery - Spay package", as("surgery", { surgery: true, procedure: true })],
      ["Surgery - Neuter pack (cat)", as("surgery", { surgery: true, procedure: true })],
      // Removals that are operations.
      ["Surgery - Mass removal", as("surgery", { surgery: true, procedure: true })],
      ["Tumour removal", as("surgery", { surgery: true, procedure: true })],
      ["Tumor removal", as("surgery", { surgery: true, procedure: true })],
      ["Lump removal", as("surgery", { surgery: true, procedure: true })],
      ["Foreign body removal", as("surgery", { surgery: true, procedure: true })],
      ["Enterotomy (foreign body removal)", as("surgery", { surgery: true, procedure: true })],
      ["Sedation", as("surgery", { surgery: true, procedure: false })],
      ["General anaesthesia", as("surgery", { surgery: true, procedure: false })],
      ["Anesthesia monitoring", as("surgery", { surgery: true, procedure: false })],
      ["Sedation for X-ray", as("surgery", { surgery: true, procedure: false })], // spec: sedation is surgery (#15: sedation only)
      ["Anaesthesia for dental scaling", as("surgery", { surgery: true, procedure: false })],
      // Pre-anaesthetic tests are diagnostics, not anaesthesia.
      ["Pre-anaesthetic blood test", as("diagnostics")],
      ["Pre-anesthetic bloodwork", as("diagnostics")],
      ["Pre-anaesthetic blood panel", as("diagnostics")],
      ["Preanesthetic screen", as("diagnostics")],
      ["Vaccination - Rabies", as("preventive", { vaccine: true })],
      ["Vaccination - DHPPi", as("preventive", { vaccine: true })],
      ["Dental scaling", as("preventive", { dentalScaling: true })],
      // A scaling done under anaesthesia is still dental scaling (Preventive), not a surgery line.
      ["Dental scaling under anaesthesia", as("preventive", { dentalScaling: true })],
      ["Scaling & polishing (sedation)", as("preventive", { dentalScaling: true })],
      ["Seresto collar", as("preventive")],
      ["Deworming tablets", as("preventive")],
      ["Flea & tick spot-on", as("preventive")],
      ["Heartworm test", as("diagnostics")],
      ["Heartworm antigen test", as("diagnostics")],
      ["Heartworm treatment (Melarsomine)", as("hospital_treatment")],
      ["Blood test panel", as("diagnostics")],
      ["X-ray", as("diagnostics")],
      ["Ultrasound (abdomen)", as("diagnostics")],
      ["Urinalysis", as("diagnostics")],
      ["Rehab session", as("rehab_tcvm")],
      ["Acupuncture", as("rehab_tcvm")],
      ["Laser treatment", as("rehab_tcvm")],
      ["Hospitalisation (per day)", as("hospital_treatment")],
      ["IV fluids", as("hospital_treatment")],
      ["Pain relief injection", as("hospital_treatment")],
      ['Antibiotic tablets "Amoxi" {250mg}', as("medicines_supplements")],
      ["Joint supplement", as("medicines_supplements")],
      ["Local anaesthetic eye drops", as("medicines_supplements")],
      ["Anaesthetic cream", as("medicines_supplements")],
      ["Prescription diet 2kg", as("retail_other")],
      ["Nail clipping", as("retail_other")],
      ["Grooming", as("retail_other")],
      ["Flea comb", as("retail_other")],
      // Paperwork about a vaccine is not a vaccination.
      ["Vaccine card", as("retail_other")],
      ["Vaccination card", as("retail_other")],
      ["Rabies vaccination certificate", as("retail_other")],
      ["Vaccine certificate", as("retail_other")],
      ["Vaccination book", as("retail_other")],
      ["Vaccination record", as("retail_other")],
      // …but a vaccination that comes with its certificate is a vaccination.
      ["Vaccination - Rabies (with certificate)", as("preventive", { vaccine: true })],
      // Not recognised: better unmapped (visible, assigned by the owner) than a wrong group.
      ["Skin scraping test", "unmapped"],
      ["Ear cleaner 100ml", "unmapped"],
      ["Microchip", "unmapped"],
      ["Display stand", "unmapped"],
      // Never surgery, and no safe group: left unmapped by rule.
      ["Surgery cancellation fee", "unmapped"],
      ["Stitching removal", "unmapped"],
      ["Suture removal", "unmapped"],
      ["Wound suture removal", "unmapped"],
      ["Removal of stitches", "unmapped"],
      ["Drain removal", "unmapped"],
      ["Cast removal", "unmapped"],
      ["Bandage removal", "unmapped"],
      ["Splint removal", "unmapped"],
      ["Tick removal", "unmapped"],
      ["Diagnostic section fee", "unmapped"], // not a C-section ("…c section…")
    ];
    const results = cases.map(([name]) => {
      const match = classify(name);
      return [name, match.source === "unmapped" ? "unmapped" : match.classification] as const;
    });
    expect(results).toEqual(cases);
  });

  it("stores a classification for each new item name (the sync's hook), leaving known names alone", async () => {
    await classifyItemNames(db.sql, ["Consultation", "Skin scraping test", "consultation "]);
    expect(await stored(["Consultation", "Skin scraping test", "consultation "])).toEqual({
      Consultation: "consult",
      "consultation ": "consult",
      "Skin scraping test": "unmapped",
    });
    const [row] = await db.sql<{ itemKey: string; source: string; ruleId: string | null }[]>`
      select item_key, source, rule_id::text from item_classifications where item_name = 'consultation '
    `;
    expect(row).toMatchObject({ itemKey: "consultation", source: "rule" });
    expect(row!.ruleId).not.toBeNull();
    await classifyItemNames(db.sql, []);
  });

  it("an owner rule reclassifies every name at once; a duplicate or invalid rule is refused", async () => {
    await linesNamed([{ name: "Skin scraping test" }, { name: "Skin scraping test (deep)" }, { name: "RM10 OFF", type: 55 }]);
    await classifyUnclassifiedItems(db.sql);
    expect(await stored(["Skin scraping test", "Skin scraping test (deep)", "RM10 OFF"])).toEqual({
      "Skin scraping test": "unmapped",
      "Skin scraping test (deep)": "unmapped",
    }); // discount lines are not items

    const added = await addItemRule(db.sql, {
      matchType: "pattern",
      pattern: "%Skin Scraping%",
      priority: 100,
      classification: as("diagnostics"),
      createdBy: "owner@example.test",
    });
    expect(added).toMatchObject({ status: "saved" });
    expect(await stored(["Skin scraping test", "Skin scraping test (deep)"])).toEqual({
      "Skin scraping test": "diagnostics",
      "Skin scraping test (deep)": "diagnostics",
    });
    const rules = await listItemRules(db.sql);
    // Exact rules first (they always win), then patterns by priority: the owner's 100 tops the seeded ones.
    expect(rules.findIndex((rule) => rule.matchType === "pattern")).toBe(rules.filter((rule) => rule.matchType === "exact").length);
    expect(rules.find((rule) => rule.matchType === "pattern")).toMatchObject({
      pattern: "%skin scraping%",
      priority: 100,
      source: "owner",
      createdBy: "owner@example.test",
      items: 2,
    });

    expect(await addItemRule(db.sql, { matchType: "pattern", pattern: "%skin  SCRAPING%", priority: 5, classification: as("retail_other") })).toEqual({
      status: "duplicate",
    });
    expect(await addItemRule(db.sql, { matchType: "pattern", pattern: " ", priority: 5, classification: as("retail_other") })).toMatchObject({
      status: "invalid",
      field: "pattern",
    });

    // Deleting it puts them back to unmapped.
    expect(await deleteItemRule(db.sql, (added as { ruleId: string }).ruleId)).toEqual({ status: "saved" });
    expect(await stored(["Skin scraping test"])).toEqual({ "Skin scraping test": "unmapped" });
    expect(await deleteItemRule(db.sql, (added as { ruleId: string }).ruleId)).toEqual({ status: "not_found" });
    expect(await deleteItemRule(db.sql, "not-an-id")).toEqual({ status: "not_found" });
  });

  it("a “leave unmapped” rule keeps matching items out of every group (and says so)", async () => {
    await linesNamed([{ name: "Consultation fee" }, { name: "Consultation" }]);
    await classifyUnclassifiedItems(db.sql);
    const added = await addItemRule(db.sql, { matchType: "pattern", pattern: "%fee%", priority: 100, classification: null });
    expect(added).toMatchObject({ status: "saved" });
    expect(await stored(["Consultation fee", "Consultation"])).toEqual({ "Consultation fee": "unmapped", Consultation: "consult" });
    const fee = (await listItems(db.sql)).find((item) => item.itemKey === "consultation fee")!;
    expect(fee).toMatchObject({ source: "unmapped", classification: null, rule: { matchType: "pattern", pattern: "%fee%", priority: 100 } });
    expect((await listItemRules(db.sql)).find((rule) => rule.pattern === "%fee%")).toMatchObject({ classification: null, items: 1 });
    // A seeded one: cancellation fees never become surgery.
    await linesNamed([{ name: "Surgery cancellation fee" }]);
    await classifyUnclassifiedItems(db.sql);
    expect((await listItems(db.sql)).find((item) => item.itemKey === "surgery cancellation fee")).toMatchObject({
      source: "unmapped",
      rule: { pattern: "%fee%" }, // the owner's (priority 100) beats the seeded %cancel% (99)
    });
  });

  it("the owner's assignment beats the rules for every spelling of the item; clearing it goes back to the rules", async () => {
    await linesNamed([{ name: "Consultation" }, { name: "CONSULTATION " }, { name: "Consultation fee" }]);
    await classifyUnclassifiedItems(db.sql);

    expect(await assignItem(db.sql, { itemKey: itemKey("consultation"), classification: as("rehab_tcvm"), assignedBy: "owner@example.test" })).toEqual({
      status: "saved",
    });
    expect(await stored(["Consultation", "CONSULTATION ", "Consultation fee"])).toEqual({
      Consultation: "rehab_tcvm",
      "CONSULTATION ": "rehab_tcvm",
      "Consultation fee": "consult",
    });
    // Assigning again replaces it.
    await assignItem(db.sql, { itemKey: "consultation", classification: as("consult", { consult: true }) });
    expect(await stored(["Consultation"])).toEqual({ Consultation: "consult" });
    const [row] = await db.sql<{ source: string }[]>`select source from item_classifications where item_name = 'Consultation'`;
    expect(row!.source).toBe("assignment");

    expect(await clearItemAssignment(db.sql, "consultation")).toEqual({ status: "saved" });
    const [after] = await db.sql<{ source: string }[]>`select source from item_classifications where item_name = 'Consultation'`;
    expect(after!.source).toBe("rule");
    expect(await clearItemAssignment(db.sql, "consultation")).toEqual({ status: "not_found" });

    expect(await assignItem(db.sql, { itemKey: "consultation", classification: as("surgery", { procedure: true }) })).toMatchObject({
      status: "invalid",
      field: "flags",
    });
    expect(await assignItem(db.sql, { itemKey: "consultation", classification: { ...as("surgery"), group: "unmapped" as never } })).toMatchObject({
      status: "invalid",
      field: "group",
    });
    expect(await assignItem(db.sql, { itemKey: "  ", classification: as("surgery") })).toMatchObject({ status: "invalid", field: "item" });
  });

  it("lists every item sold (spelling variants together) with what decides its group", async () => {
    await linesNamed([
      { name: "Consultation" },
      { name: "Consultation" },
      { name: "CONSULTATION " },
      { name: "Ear cleaner 100ml", type: 1 },
      { name: "RM10 OFF", type: 55 },
    ]);
    await classifyUnclassifiedItems(db.sql);
    await assignItem(db.sql, { itemKey: "ear cleaner 100ml", classification: as("medicines_supplements") });

    const items = await listItems(db.sql);
    expect(items.map((item) => ({ ...item, rule: item.rule && { matchType: item.rule.matchType, pattern: item.rule.pattern } }))).toEqual([
      {
        itemKey: "consultation",
        name: "Consultation",
        spellings: ["CONSULTATION ", "Consultation"],
        itemTypes: [4],
        lines: 3,
        source: "rule",
        classification: as("consult", { consult: true }),
        rule: { matchType: "pattern", pattern: "%consult%" },
      },
      {
        itemKey: "ear cleaner 100ml",
        name: "Ear cleaner 100ml",
        spellings: ["Ear cleaner 100ml"],
        itemTypes: [1],
        lines: 1,
        source: "assignment",
        classification: as("medicines_supplements"),
        rule: null,
      },
    ]);
  });

  it("the catch-up classifies names stored without one (e.g. lines synced before item groups existed)", async () => {
    await linesNamed([{ name: "X-ray" }, { name: "Microchip" }]);
    expect(await stored(["X-ray", "Microchip"])).toEqual({});
    expect(await classifyUnclassifiedItems(db.sql)).toBe(2);
    expect(await stored(["X-ray", "Microchip"])).toEqual({ "X-ray": "diagnostics", Microchip: "unmapped" });
    expect(await classifyUnclassifiedItems(db.sql)).toBe(0);
  });
});
