import { beforeEach, describe, expect, it } from "vitest";

import { useTestDatabase } from "@/db/testing";

import { acquireConnectionLease, releaseConnectionLease, withConnectionLease } from "./lock";

/**
 * The per-connection lease: at most one Kreloses session (a sync run or a login test) per
 * connection at a time, across server instances.
 */
describe("connection lease", () => {
  const db = useTestDatabase();
  let connectionId: string;
  const t0 = new Date("2026-09-28T01:00:00Z");
  const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);

  beforeEach(async () => {
    await db.sql`delete from connections`;
    const [row] = await db.sql<{ id: string }[]>`
      insert into connections (label, kreloses_email, password_ciphertext)
      values ('North', 'north@clinic.example', 'v1.00000000.x.y.z')
      returning id::text as id
    `;
    connectionId = row!.id;
  });

  it("lets one holder in at a time and tells the next who holds it", async () => {
    const first = await acquireConnectionLease(db.sql, connectionId, { purpose: "sync", ttlMs: 60_000, now: t0 });
    expect(first).toMatchObject({ status: "acquired", lease: { connectionId, expiresAt: at(60) } });

    const second = await acquireConnectionLease(db.sql, connectionId, { purpose: "login-test", ttlMs: 60_000, now: at(10) });
    expect(second).toEqual({ status: "busy", heldFor: "sync", until: at(60) });

    await releaseConnectionLease(db.sql, first.status === "acquired" ? first.lease : null!);
    expect(await acquireConnectionLease(db.sql, connectionId, { purpose: "login-test", ttlMs: 60_000, now: at(11) })).toMatchObject({
      status: "acquired",
    });
  });

  it("frees an expired lease (its holder crashed) for the next holder", async () => {
    const crashed = await acquireConnectionLease(db.sql, connectionId, { purpose: "sync", ttlMs: 60_000, now: t0 });
    const next = await acquireConnectionLease(db.sql, connectionId, { purpose: "sync", ttlMs: 60_000, now: at(61) });
    expect(next).toMatchObject({ status: "acquired" });

    // The crashed holder coming back cannot release the new holder's lease.
    await releaseConnectionLease(db.sql, crashed.status === "acquired" ? crashed.lease : null!);
    expect(await acquireConnectionLease(db.sql, connectionId, { purpose: "sync", ttlMs: 60_000, now: at(62) })).toMatchObject({
      status: "busy",
    });
  });

  it("gives the lease to exactly one of several simultaneous requests", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => acquireConnectionLease(db.sql, connectionId, { purpose: "sync", ttlMs: 60_000, now: t0 })),
    );
    expect(results.filter((result) => result.status === "acquired")).toHaveLength(1);
    expect(results.filter((result) => result.status === "busy")).toHaveLength(5);
  });

  it("reports a connection that does not exist", async () => {
    expect(await acquireConnectionLease(db.sql, "424242", { purpose: "sync", ttlMs: 60_000, now: t0 })).toEqual({ status: "not_found" });
    expect(await acquireConnectionLease(db.sql, "nope", { purpose: "sync", ttlMs: 60_000, now: t0 })).toEqual({ status: "not_found" });
  });

  it("runs work under the lease and always releases it, even when the work fails", async () => {
    const done = await withConnectionLease(db.sql, connectionId, { purpose: "login-test", ttlMs: 60_000, now: () => t0 }, async () => "ok");
    expect(done).toEqual({ status: "done", value: "ok" });

    await expect(
      withConnectionLease(db.sql, connectionId, { purpose: "login-test", ttlMs: 60_000, now: () => t0 }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const held = await acquireConnectionLease(db.sql, connectionId, { purpose: "sync", ttlMs: 60_000, now: t0 });
    expect(held).toMatchObject({ status: "acquired" });
    expect(
      await withConnectionLease(db.sql, connectionId, { purpose: "login-test", ttlMs: 60_000, now: () => t0 }, async () => "never"),
    ).toEqual({ status: "busy", heldFor: "sync", until: at(60) });
  });

  it("goes away with its connection", async () => {
    await acquireConnectionLease(db.sql, connectionId, { purpose: "sync", ttlMs: 60_000, now: t0 });
    await db.sql`delete from connections where id = ${connectionId}`;
    expect(await db.sql`select 1 from connection_locks`).toHaveLength(0);
  });
});
