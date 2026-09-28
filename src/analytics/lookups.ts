import type { Sql } from "@/db/sql";

/**
 * Directory lookups for turning what someone types ("North", "Dr Alpha") into the global filter's
 * ids (MCP tools, #17). Not metrics: which branches and doctors exist, and what they are called.
 */

/** Every synced branch, by name; `id` is `branches.id` (what `GlobalFilter.branchIds` holds). */
export async function listBranches(sql: Sql): Promise<{ id: string; name: string }[]> {
  return sql<{ id: string; name: string }[]>`select id::text as id, name from branches order by lower(name), id`;
}

/**
 * The doctors the global filter offers (`listDoctors`: kind doctor, seen on invoice lines), each
 * with the short staff names on invoice lines credited to them ("Dr Ong"), by name.
 */
export async function listDoctorNames(sql: Sql): Promise<{ id: string; name: string; lineNames: string[] }[]> {
  return sql<{ id: string; name: string; lineNames: string[] }[]>`
    select s.id::text as id, s.full_name as name, array_agg(a.raw_name order by a.raw_name) as line_names
    from staff s join staff_aliases a on a.staff_id = s.id
    where s.kind = 'doctor'
    group by s.id, s.full_name
    order by lower(s.full_name), s.id
  `;
}
