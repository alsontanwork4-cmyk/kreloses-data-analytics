import { beforeEach, describe, expect, it } from "vitest";

import { useTestDatabase } from "@/db/testing";

import { acquireConnectionLease, releaseConnectionLease, renewConnectionLease, withConnectionLease, type ConnectionLease } from "./lock";

/**
 * The per-connection lease: at most one Kreloses session (a sync run or a login test) per
 * connection at a time, across server instances. Expiry follows the DATABASE clock, so "time
 * passing" is simulated by moving the lease's expiry into the past.
 */
describe("connection lease", () => {
  const db = useTestDatabase();
  let connectionId: string;

  beforeEach(async () => {
    await db.sql`delete from connections`;
    const [row] = await db.sql<{ id: string }[]>`
      insert into connections (label, kreloses_email, password_ciphertext)
      values ('North', 'north@clinic.example', 'v1.00000000.x.y.z')
      returning id::text as id
    `;
    connectionId = row!.id;
  });

  const acquired = (attempt: Awaited<ReturnType<typeof acquireConnectionLease>>): ConnectionLease => {
    if (attempt.status !== "acquired") throw new Error(`expected the lease, got ${JSON.stringify(attempt)}`);
    return attempt.lease;
  };
  /** As if the lease's TTL had run out. */
  const expire = () => db.sql`
    update connection_locks set acquired_at = now() - interval '10 minutes', expires_at = now() - interval '1 second'
    where connection_id = ${connectionId}
  `;
  const dbNow = async () => (await db.sql<{ now: Date }[]>`select now()`)[0]!.now;

  it("lets one holder in at a time and tells the next who holds it, and until when (database time)", async () => {
    const before = await dbNow();
    const first = acquired(await acquireConnectionLease(db.sql, connectionId, { purpose: "sync", ttlMs: 60_000 }));
    expect(first.expiresAt.getTime() - before.getTime()).toBeGreaterThanOrEqual(60_000);
    expect(first.expiresAt.getTime() - before.getTime()).toBeLessThan(70_000);

    const second = await acquireConnectionLease(db.sql, connectionId, { purpose: "login-test", ttlMs: 60_000 });
    expect(second).toEqual({ status: "busy", heldFor: "sync", until: first.expiresAt });

    await releaseConnectionLease(db.sql, first);
    expect(await acquireConnectionLease(db.sql, connectionId, { purpose: "login-test", ttlMs: 60_000 })).toMatchObject({ status: "acquired" });
  });

  it("frees an expired lease (its holder crashed) for the next holder", async () => {
    const crashed = acquired(await acquireConnectionLease(db.sql, connectionId, { purpose: "sync", ttlMs: 60_000 }));
    await expire();
    const next = await acquireConnectionLease(db.sql, connectionId, { purpose: "sync", ttlMs: 60_000 });
    expect(next).toMatchObject({ status: "acquired" });

    // The crashed holder coming back can neither release nor renew the new holder's lease.
    await releaseConnectionLease(db.sql, crashed);
    expect(await renewConnectionLease(db.sql, crashed, 60_000)).toBe(false);
    expect(await acquireConnectionLease(db.sql, connectionId, { purpose: "sync", ttlMs: 60_000 })).toMatchObject({ status: "busy" });
  });

  it("a holder renews its lease with each write, so it outlives its first TTL; renewing never shortens it", async () => {
    const lease = acquired(await acquireConnectionLease(db.sql, connectionId, { purpose: "sync", ttlMs: 1_000 }));
    const first = lease.expiresAt;
    expect(await renewConnectionLease(db.sql, lease, 240_000)).toBe(true);
    expect(lease.expiresAt.getTime()).toBeGreaterThan(first.getTime() + 200_000);
    const longer = lease.expiresAt;
    expect(await renewConnectionLease(db.sql, lease, 1_000)).toBe(true);
    expect(lease.expiresAt).toEqual(longer);

    // Even after it expired, a holder nobody replaced may carry on.
    await expire();
    expect(await renewConnectionLease(db.sql, lease, 60_000)).toBe(true);
    expect(await acquireConnectionLease(db.sql, connectionId, { purpose: "login-test", ttlMs: 60_000 })).toMatchObject({ status: "busy", heldFor: "sync" });
  });

  it("gives the lease to exactly one of several simultaneous requests", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => acquireConnectionLease(db.sql, connectionId, { purpose: "sync", ttlMs: 60_000 })),
    );
    expect(results.filter((result) => result.status === "acquired")).toHaveLength(1);
    expect(results.filter((result) => result.status === "busy")).toHaveLength(5);
  });

  it("reports a connection that does not exist", async () => {
    expect(await acquireConnectionLease(db.sql, "424242", { purpose: "sync", ttlMs: 60_000 })).toEqual({ status: "not_found" });
    expect(await acquireConnectionLease(db.sql, "nope", { purpose: "sync", ttlMs: 60_000 })).toEqual({ status: "not_found" });
  });

  it("runs work under the lease and always releases it, even when the work fails", async () => {
    const done = await withConnectionLease(db.sql, connectionId, { purpose: "login-test", ttlMs: 60_000 }, async () => "ok");
    expect(done).toEqual({ status: "done", value: "ok" });

    await expect(
      withConnectionLease(db.sql, connectionId, { purpose: "login-test", ttlMs: 60_000 }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const held = acquired(await acquireConnectionLease(db.sql, connectionId, { purpose: "sync", ttlMs: 60_000 }));
    expect(await withConnectionLease(db.sql, connectionId, { purpose: "login-test", ttlMs: 60_000 }, async () => "never")).toEqual({
      status: "busy",
      heldFor: "sync",
      until: held.expiresAt,
    });
  });

  it("goes away with its connection (a holder's renewal then fails)", async () => {
    const lease = acquired(await acquireConnectionLease(db.sql, connectionId, { purpose: "sync", ttlMs: 60_000 }));
    await db.sql`delete from connections where id = ${connectionId}`;
    expect(await db.sql`select 1 from connection_locks`).toHaveLength(0);
    expect(await renewConnectionLease(db.sql, lease, 60_000)).toBe(false);
  });
});
