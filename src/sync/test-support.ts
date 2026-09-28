import { randomBytes } from "node:crypto";

import { keyringFromEnv } from "@/connections/encryption";
import { loginAsConnection, saveConnection, type ConnectionsContext } from "@/connections/service";
import type { Sql } from "@/db/sql";
import { createFakeKreloses, type FakeKreloses, type FakeKrelosesOptions } from "@/kreloses/testing/fake-kreloses";

import type { SyncDeps } from "./engine";

/**
 * Test harness for the Sync Engine (Seam 1): a fake Kreloses (synthetic Sale List fixtures), a
 * connections context pointed at it, a controllable clock and a `sleep` that only advances it.
 */
export interface SyncHarness {
  fake: FakeKreloses;
  context: ConnectionsContext;
  clock: { now: Date; advance(ms: number): void };
  /** Every wait the engine asked for, in ms. */
  sleeps: number[];
  deps(overrides?: Partial<SyncDeps>): SyncDeps;
  /** Saves (and login-tests) a connection for a synthetic account; returns its id. */
  connect(account: { email: string; password: string }, label?: string): Promise<string>;
}

export function createSyncHarness(sql: Sql, options: { fake?: FakeKrelosesOptions; now?: Date } = {}): SyncHarness {
  const fake = createFakeKreloses(options.fake);
  const keyring = keyringFromEnv({ CREDENTIALS_ENCRYPTION_KEY: randomBytes(32).toString("base64") });
  const context: ConnectionsContext = { sql, keyring: () => keyring, reader: { requestDelayMs: 0, transport: fake.transport } };
  const clock = {
    now: options.now ?? new Date("2026-10-01T02:00:00Z"),
    advance(ms: number) {
      clock.now = new Date(clock.now.getTime() + ms);
    },
  };
  const sleeps: number[] = [];
  return {
    fake,
    context,
    clock,
    sleeps,
    deps: (overrides = {}) => ({
      sql,
      login: (id) => loginAsConnection(context, id),
      now: () => clock.now,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock.advance(ms);
      },
      ...overrides,
    }),
    async connect(account, label = account.email) {
      const saved = await saveConnection(context, { label, email: account.email, password: account.password });
      if (!saved.ok) throw new Error(`could not save the test connection: ${JSON.stringify(saved)}`);
      return saved.connection.id;
    },
  };
}

/** Empties every table the sync writes (and connections), children first. */
export async function clearSyncTables(sql: Sql): Promise<void> {
  await sql`delete from invoices`; // cascades to invoice_lines and credited_lines
  await sql`delete from staff_aliases`;
  await sql`delete from staff`;
  await sql`delete from customers`;
  await sql`delete from sync_runs`;
  await sql`delete from branches`;
  await sql`delete from connections`;
}
