import type { Metadata } from "next";

import { getStaffAliasRevenue, METRIC_DEFINITIONS } from "@/analytics";
import { requireRole } from "@/auth/session";
import { DataTable, type DataTableColumn } from "@/components/data-table/data-table";
import { SettingsSection } from "@/components/settings/settings-section";
import { Badge } from "@/components/ui/badge";
import { getDb } from "@/db/client";
import { formatDateRange, parseFilter } from "@/filters";
import { listStaffAliases, listStaffMembers, type StaffAlias, type StaffMember } from "@/staff/store";

import { AliasMappingForm, StaffKindForm, type StaffOption } from "./staff-forms";

export const metadata: Metadata = { title: "Doctors · Settings" };

const MATCH_LABEL: Record<StaffAlias["match"], string> = { auto: "Automatic", manual: "Set by you", unmatched: "No match" };
const KIND_LABEL: Record<StaffMember["kind"], string> = { doctor: "Doctor", other: "Other staff", generic: "Generic account" };

interface AliasRow extends StaffAlias {
  revenue: string;
}

/**
 * Owner only: the staff names on invoice lines and who each is credited to (spec stories 18–20),
 * and every staff member's kind. Changes apply to every figure at once; nothing is re-synced.
 * Revenue per name is for the period in the URL (the global filter the owner was looking at).
 */
export default async function DoctorsSettingsPage({ searchParams }: PageProps<"/settings/doctors">) {
  await requireRole("owner");
  const { filter } = parseFilter(await searchParams);
  const sql = getDb();
  const [aliases, members, revenue] = await Promise.all([listStaffAliases(sql), listStaffMembers(sql), getStaffAliasRevenue(sql, filter)]);

  const options: StaffOption[] = members.map((member) => ({ id: member.id, label: `${member.name} (${KIND_LABEL[member.kind].toLowerCase()})` }));
  const labelOf = new Map(options.map((option) => [option.id, option.label]));
  const aliasRows: AliasRow[] = aliases.map((alias) => ({ ...alias, revenue: revenue[alias.id] ?? "0.00" }));
  const period = formatDateRange(filter.dateFrom, filter.dateTo);

  const aliasColumns: DataTableColumn<AliasRow>[] = [
    { key: "name", header: "Name on invoice lines", kind: "text", value: (row) => row.rawName },
    {
      key: "match",
      header: "Match",
      kind: "text",
      value: (row) => MATCH_LABEL[row.match],
      cell: (row) => (
        <Badge variant={row.match === "unmatched" ? "destructive" : row.match === "manual" ? "default" : "secondary"}>{MATCH_LABEL[row.match]}</Badge>
      ),
    },
    { key: "revenue", header: "Revenue", kind: "money", value: (row) => row.revenue },
    {
      key: "credited-to",
      header: "Credited to",
      kind: "text",
      value: (row) => row.staff.name,
      cell: (row) => (
        <AliasMappingForm
          aliasId={row.id}
          rawName={row.rawName}
          staffId={row.staff.id}
          suggestions={row.suggestions.map((suggestion) => ({ id: suggestion.id, label: labelOf.get(suggestion.id) ?? suggestion.name }))}
          staff={options}
        />
      ),
    },
  ];

  const staffColumns: DataTableColumn<StaffMember>[] = [
    {
      key: "staff",
      header: "Staff member",
      kind: "text",
      value: (row) => row.name,
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {row.name}
          {row.source === "alias_only" ? <Badge variant="outline" className="font-normal">Not in staff list</Badge> : null}
          {row.source === "kreloses" && !row.active ? <Badge variant="outline" className="font-normal">No longer in Kreloses</Badge> : null}
        </span>
      ),
    },
    {
      key: "kind",
      header: "Kind",
      kind: "text",
      value: (row) => KIND_LABEL[row.kind],
      cell: (row) => <StaffKindForm staffId={row.id} name={row.name} kind={row.kind} />,
    },
    { key: "kind-set-by", header: "Kind set by", kind: "text", value: (row) => (row.kindSource === "manual" ? "You" : "Automatic"), priority: "secondary" },
    { key: "names", header: "Names on lines", kind: "count", value: (row) => row.aliases, priority: "secondary" },
  ];

  return (
    <SettingsSection
      title="Doctors"
      description="Staff names on invoice lines are short (“Dr Ong”); each is matched to a full Kreloses staff name. Correct a match or a staff member's kind here: every figure on the dashboard follows at once, without a new sync."
    >
      <DataTable
        headingLevel={3}
        caption="Names on invoice lines"
        description={
          <>
            “No match” names (e.g. a doctor who has left) keep their own entry, so their revenue still counts; point them at the right
            person if you know who it was. Revenue is for {period}.
          </>
        }
        columns={aliasColumns}
        rows={aliasRows}
        rowKey={(row) => row.id}
        export={{ name: "staff-names", filter }}
        empty="Names appear here after the first sync that reads invoice lines."
        testId="staff-aliases"
      />
      <DataTable
        headingLevel={3}
        caption="Staff"
        description={METRIC_DEFINITIONS.doctorRanking}
        columns={staffColumns}
        rows={members}
        rowKey={(row) => row.id}
        empty="Staff appear here after the first sync."
        testId="staff-members"
      />
    </SettingsSection>
  );
}
