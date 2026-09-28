import type { Queryable, Sql } from "@/db/sql";

import type { ConnectionErrorCode } from "./messages";

/**
 * Data access for `connections`. The summary type and the list query deliberately exclude the
 * encrypted password: only `readPasswordEnvelope` reads it, for the server-side login test.
 */
export type ConnectionStatus = "untested" | "ok" | "failed";

/** A Kreloses location (branch) a connection's login can see. */
export interface VisibleLocation {
  id: string;
  name: string;
}

/** Everything the Connections page may show. Never contains the password or its ciphertext. */
export interface ConnectionSummary {
  id: string;
  label: string;
  /** The Kreloses sign-in email. */
  email: string;
  status: ConnectionStatus;
  lastErrorCode: ConnectionErrorCode | null;
  lastError: string | null;
  lastTestedAt: Date | null;
  visibleLocations: VisibleLocation[];
  createdAt: Date;
  updatedAt: Date;
}

const ID = /^[1-9][0-9]{0,17}$/;

/** Connection ids are bigint identities, handled as strings; anything else matches nothing. */
export function isConnectionId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

function summaryColumns(sql: Queryable) {
  return sql`
    id::text as id, label, kreloses_email as email, status, last_error_code, last_error,
    last_tested_at, visible_locations, created_at, updated_at
  `;
}

export async function listConnections(sql: Sql): Promise<ConnectionSummary[]> {
  return sql<ConnectionSummary[]>`
    select ${summaryColumns(sql)} from connections order by lower(label), id
  `;
}

export async function readCredentials(
  sql: Sql,
  id: string,
): Promise<{ email: string; passwordCiphertext: string } | null> {
  if (!isConnectionId(id)) return null;
  const [row] = await sql<{ email: string; passwordCiphertext: string }[]>`
    select kreloses_email as email, password_ciphertext from connections where id = ${id}
  `;
  return row ?? null;
}

/** Inserts a connection, awaiting its first login test. */
export async function insertConnection(
  sql: Sql,
  values: { label: string; email: string; passwordCiphertext: string },
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into connections (label, kreloses_email, password_ciphertext)
    values (${values.label}, ${values.email}, ${values.passwordCiphertext})
    returning id::text as id
  `;
  return row!.id;
}

/**
 * Updates a connection's details (and password, when given) and resets it to "untested" until the
 * next login test. Returns false if it no longer exists.
 */
export async function updateConnectionDetails(
  sql: Sql,
  id: string,
  values: { label: string; email: string; passwordCiphertext: string | null },
): Promise<boolean> {
  if (!isConnectionId(id)) return false;
  const rows = await sql`
    update connections set
      label = ${values.label},
      kreloses_email = ${values.email},
      password_ciphertext = coalesce(${values.passwordCiphertext}, password_ciphertext),
      status = 'untested',
      last_error_code = null,
      last_error = null,
      last_tested_at = null,
      visible_locations = '[]'::jsonb
    where id = ${id}
  `;
  return rows.count > 0;
}

export type TestOutcome =
  | { status: "ok"; visibleLocations: VisibleLocation[] }
  | { status: "failed"; code: ConnectionErrorCode; message: string };

/** Stores the result of a login test. Returns the updated summary, or null if the row is gone. */
export async function recordTestOutcome(sql: Queryable, id: string, outcome: TestOutcome): Promise<ConnectionSummary | null> {
  if (!isConnectionId(id)) return null;
  const failed = outcome.status === "failed";
  const [row] = await sql<ConnectionSummary[]>`
    update connections set
      status = ${outcome.status},
      last_error_code = ${failed ? outcome.code : null},
      last_error = ${failed ? outcome.message : null},
      last_tested_at = now(),
      visible_locations = ${sql.json(failed ? [] : outcome.visibleLocations.map(({ id: locationId, name }) => ({ id: locationId, name })))}
    where id = ${id}
    returning ${summaryColumns(sql)}
  `;
  return row ?? null;
}

export async function deleteConnectionRow(sql: Sql, id: string): Promise<boolean> {
  if (!isConnectionId(id)) return false;
  const rows = await sql`delete from connections where id = ${id}`;
  return rows.count > 0;
}
