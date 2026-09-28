import postgres from "postgres";

/**
 * The one place that decides how the app talks to Postgres. The app client, the test harness and
 * the scripts all build their connections here, so every caller sees identical behaviour:
 *
 * - Result column names come back camelCased (`created_at` -> `createdAt`); write SQL in
 *   snake_case. `sql(object)` insert/update helpers map camelCase keys back to snake_case.
 *   JSON values are left untouched.
 * - `date` columns come back as `'YYYY-MM-DD'` strings (clinic-local calendar dates), never as JS
 *   Dates, so no time-zone shift can creep in. `timestamptz` comes back as a JS Date.
 * - `numeric` and `bigint` (including `count(*)`) come back as strings, as postgres.js does by
 *   default. Convert deliberately (e.g. `count(*)::int`, or `Number(...)` for display).
 * - Never rely on the session `TimeZone`; convert explicitly with
 *   `at time zone 'Asia/Kuala_Lumpur'`.
 */
export function createSql(url: string, options: SqlOptions = {}) {
  return postgres(url, {
    max: options.max ?? 3,
    // Supabase's transaction pooler (port 6543) cannot use prepared statements.
    prepare: options.prepare ?? true,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
    transform: { column: { from: postgres.toCamel, to: postgres.fromCamel } },
    types: {
      date: {
        to: 1082,
        from: [1082],
        serialize: (value: string) => value,
        parse: (value: string) => value,
      },
    },
  });
}

export interface SqlOptions {
  /** Maximum pooled connections. Keep small: many worktrees share one local cluster. */
  max?: number;
  /** Set false behind a transaction-mode pooler (Supabase pooler port 6543). */
  prepare?: boolean;
}

export type Sql = ReturnType<typeof createSql>;

type SqlTypes = Sql extends postgres.Sql<infer Types> ? Types : never;

/** Something queries run on: the pool (`Sql`) or the transaction inside `sql.begin(tx => …)`. */
export type Queryable = Sql | postgres.TransactionSql<SqlTypes>;

/** A value for `sql.json(...)` (postgres.js's JSON type). */
export type JsonValue = postgres.JSONValue;
