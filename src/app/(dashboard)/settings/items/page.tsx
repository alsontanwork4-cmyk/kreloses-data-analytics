import type { Metadata } from "next";

import { getItemRevenue, METRIC_DEFINITIONS } from "@/analytics";
import { itemKey as normaliseItemKey, MIX_GROUP_LABELS, type ItemClassification } from "@/attribution";
import { requireRole } from "@/auth/session";
import { DataTable, type DataTableColumn } from "@/components/data-table/data-table";
import { SettingsSection } from "@/components/settings/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getDb } from "@/db/client";
import { filterSearchParamsOnly, formatDateRange, parseFilter } from "@/filters";
import { listItemRules, listItems, type ItemEntry, type StoredItemRule } from "@/items/store";
import { moneyToSen, type Money } from "@/lib/money";

import { AddRuleForm, DeleteRuleButton, ItemAssignmentForm } from "./item-forms";

export const metadata: Metadata = { title: "Items · Settings" };

/** At most this many rows in the item lists (search to narrow). */
const LIST_LIMIT = 100;

interface ItemRow extends ItemEntry {
  revenue: Money;
}

const TYPE_LABEL: Record<number, string> = { 1: "Product", 4: "Service" };

function typeLabel(types: number[]): string {
  return types.map((type) => TYPE_LABEL[type] ?? `Type ${type}`).join(", ");
}

/** The flags as words, e.g. "Surgery (operation), Vaccine"; "—" for none. */
function flagsLabel(classification: ItemClassification | null): string {
  if (!classification) return "—";
  const words = [
    classification.surgery ? (classification.procedure ? "Surgery (operation)" : "Surgery (sedation / no operation)") : null,
    classification.consult ? "Consult" : null,
    classification.vaccine ? "Vaccine" : null,
    classification.dentalScaling ? "Dental scaling" : null,
  ].filter(Boolean);
  return words.length > 0 ? words.join(", ") : "—";
}

function decidedBy(item: ItemEntry): string {
  if (item.source === "assignment") return "Your assignment";
  const rule = item.rule ? `${item.rule.matchType === "exact" ? "Exact" : "Pattern"} rule “${item.rule.pattern}”` : null;
  if (item.source === "rule" && rule) return rule;
  if (rule) return `${rule} (leave unmapped)`;
  return "No rule matches";
}

/**
 * Owner only: every item sold and its service-mix group (spec stories 23–26). Unmapped items first,
 * by revenue in the URL's period (and branch), so new items are assigned quickly; then every item
 * (searchable) and the rules. Any change applies to all history at once; nothing is re-synced.
 */
export default async function ItemsSettingsPage({ searchParams }: PageProps<"/settings/items">) {
  await requireRole("owner");
  const params = await searchParams;
  const { filter } = parseFilter(params);
  const query = typeof params.q === "string" ? params.q.trim() : "";
  const sql = getDb();
  const [items, rules, revenue] = await Promise.all([listItems(sql), listItemRules(sql), getItemRevenue(sql, filter)]);

  const rows: ItemRow[] = items
    .map((item) => ({ ...item, revenue: revenue[item.itemKey] ?? "0.00" }))
    .sort((a, b) => moneyToSen(b.revenue) - moneyToSen(a.revenue) || (a.itemKey < b.itemKey ? -1 : a.itemKey > b.itemKey ? 1 : 0));
  const unmapped = rows.filter((row) => row.source === "unmapped");
  const needle = normaliseItemKey(query);
  const matching = needle ? rows.filter((row) => row.itemKey.includes(needle)) : rows;
  const period = formatDateRange(filter.dateFrom, filter.dateTo);

  const assignColumn: DataTableColumn<ItemRow> = {
    key: "assign",
    header: "Group and flags",
    kind: "text",
    value: (row) => (row.classification ? MIX_GROUP_LABELS[row.classification.group] : "Unmapped"),
    cell: (row) => (
      <ItemAssignmentForm itemKey={row.itemKey} itemName={row.name} classification={row.classification} assigned={row.source === "assignment"} />
    ),
  };
  const unmappedColumns: DataTableColumn<ItemRow>[] = [
    { key: "item", header: "Item", kind: "text", value: (row) => row.name },
    { key: "type", header: "Type", kind: "text", value: (row) => typeLabel(row.itemTypes), priority: "secondary" },
    { key: "revenue", header: "Revenue", kind: "money", value: (row) => row.revenue },
    { key: "lines", header: "Lines (all time)", kind: "count", value: (row) => row.lines, priority: "secondary" },
    assignColumn,
  ];
  const itemColumns: DataTableColumn<ItemRow>[] = [
    {
      key: "item",
      header: "Item",
      kind: "text",
      value: (row) => row.name,
      cell: (row) => (
        <span className="flex flex-col gap-0.5">
          {row.name}
          {row.spellings.length > 1 ? <span className="text-xs font-normal text-muted-foreground">{row.spellings.length} spellings</span> : null}
        </span>
      ),
    },
    {
      key: "group",
      header: "Group",
      kind: "text",
      value: (row) => (row.classification ? MIX_GROUP_LABELS[row.classification.group] : "Unmapped"),
      cell: (row) =>
        row.classification ? MIX_GROUP_LABELS[row.classification.group] : <Badge variant="destructive">Unmapped</Badge>,
    },
    { key: "flags", header: "Flags", kind: "text", value: (row) => flagsLabel(row.classification) },
    { key: "decided-by", header: "Decided by", kind: "text", value: (row) => decidedBy(row), priority: "secondary" },
    { key: "type", header: "Type", kind: "text", value: (row) => typeLabel(row.itemTypes), priority: "secondary" },
    { key: "revenue", header: "Revenue", kind: "money", value: (row) => row.revenue },
    { ...assignColumn, header: "Change" },
  ];
  const ruleColumns: DataTableColumn<StoredItemRule>[] = [
    { key: "pattern", header: "Name or pattern", kind: "text", value: (row) => row.pattern },
    { key: "match", header: "Match", kind: "text", value: (row) => (row.matchType === "exact" ? "Exact name" : "Pattern") },
    { key: "priority", header: "Priority", kind: "count", value: (row) => row.priority },
    { key: "group", header: "Group", kind: "text", value: (row) => (row.classification ? MIX_GROUP_LABELS[row.classification.group] : "Leave unmapped") },
    { key: "flags", header: "Flags", kind: "text", value: (row) => flagsLabel(row.classification) },
    { key: "items", header: "Items it decides", kind: "count", value: (row) => row.items },
    { key: "source", header: "Added by", kind: "text", value: (row) => (row.source === "seed" ? "Starting rules" : (row.createdBy ?? "You")), priority: "secondary" },
    { key: "delete", header: "Delete", kind: "text", value: () => "", cell: (row) => <DeleteRuleButton ruleId={row.id} pattern={row.pattern} /> },
  ];
  const keptParams = [...filterSearchParamsOnly(params).entries()];

  return (
    <SettingsSection
      title="Items"
      description="Every item sold belongs to one of eight service groups (Consult, Surgery, Diagnostics, Hospital & treatment, Rehab & TCVM, Medicines & supplements, Preventive, Retail & other) and may be flagged as surgery, consult, vaccine or dental scaling. Your assignment for an item wins; otherwise the rules below decide. Changes apply to every figure, past periods included, at once."
    >
      <DataTable
        headingLevel={3}
        caption="Unmapped items"
        description={
          <>
            Items no rule recognises, by revenue in {period}. Their revenue shows as “Unmapped” until you assign them.
            {unmapped.length > LIST_LIMIT ? (
              <span data-testid="unmapped-count">
                {" "}
                {unmapped.length} unmapped items: the top {LIST_LIMIT} are shown; the CSV has all of them.
              </span>
            ) : null}
          </>
        }
        columns={unmappedColumns}
        rows={unmapped.slice(0, LIST_LIMIT)}
        rowKey={(row) => row.itemKey}
        export={{ name: "unmapped-items", filter, rows: unmapped }}
        empty="Every item sold has a group."
        testId="unmapped-items"
      />

      <div className="flex flex-col gap-2">
        <form role="search" aria-label="Search items" className="flex max-w-md items-center gap-2">
          {keptParams.map(([key, value]) => (
            <input key={`${key}=${value}`} type="hidden" name={key} value={value} />
          ))}
          <Input name="q" defaultValue={query} placeholder="Search items" aria-label="Search items" />
          <Button type="submit" size="sm" variant="outline">
            Search
          </Button>
        </form>
        <DataTable
          headingLevel={3}
          caption="All items"
          description={
            <>
              {needle ? `${matching.length} of ${rows.length} items match “${query}”.` : `${rows.length} items.`} By revenue in {period}
              {matching.length > LIST_LIMIT ? `; the first ${LIST_LIMIT} are shown (the CSV has all of them) — search to find others` : ""}.
            </>
          }
          columns={itemColumns}
          rows={matching.slice(0, LIST_LIMIT)}
          rowKey={(row) => row.itemKey}
          export={{ name: "items", filter, rows: matching }}
          empty={needle ? "No item matches that search." : "Items appear here after the first sync that reads invoice lines."}
          testId="all-items"
        />
      </div>

      <div className="flex flex-col gap-3">
        <div>
          <h3 className="text-base font-medium">Rules</h3>
          <p className="text-xs text-muted-foreground">
            Exact-name rules are tried first, then patterns, each by priority (highest first; ties to the older rule). A pattern
            works like SQL ILIKE on the name in lower case: % stands for any characters, _ for one character (e.g. “%scraping%”
            matches “Skin scraping test”). A rule can also leave matching items unmapped, so lower rules never guess
            them (e.g. “%cancel%” keeps a surgery cancellation fee out of Surgery). The starting rules follow the spec’s surgery and consult definitions and common item
            names; they are not your earlier dashboard’s own rules, so check the unmapped list and adjust here.
          </p>
        </div>
        <AddRuleForm />
        <DataTable
          headingLevel={3}
          caption="Rules in order"
          columns={ruleColumns}
          rows={rules}
          rowKey={(row) => row.id}
          export={{ name: "item-rules", filter }}
          empty="No rules: every item is unmapped until you assign it."
          testId="item-rules"
        />
      </div>

      <details className="rounded-lg border px-3 py-2 text-sm">
        <summary className="cursor-pointer font-medium">How items are grouped</summary>
        <p className="mt-2 text-muted-foreground">{METRIC_DEFINITIONS.mixGroup}</p>
      </details>
    </SettingsSection>
  );
}
