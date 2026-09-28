import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createDatabase,
  databaseExists,
  databaseUrl,
  dropDatabase,
  dropStaleDatabases,
  timestampedDatabaseName,
} from "./admin";
import { createSql } from "./sql";

describe("dropStaleDatabases", () => {
  it("drops only old, generated, unused throwaway databases", async () => {
    const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
    const staleIdle = timestampedDatabaseName("kx_test_", threeHoursAgo);
    const staleInUse = timestampedDatabaseName("kx_test_", threeHoursAgo);
    const recent = timestampedDatabaseName("kx_test_");
    const handNamed = `kx_test_manual_${randomBytes(4).toString("hex")}`;
    const all = [staleIdle, staleInUse, recent, handNamed];

    for (const name of all) await createDatabase(name);
    // e.g. a long `playwright test --ui` session in another worktree
    const openConnection = createSql(databaseUrl(staleInUse), { max: 1 });
    try {
      await openConnection`select 1`;

      const dropped = await dropStaleDatabases("kx_test_", 2 * 60 * 60 * 1000);

      expect(dropped).toContain(staleIdle);
      expect(dropped).not.toContain(staleInUse);
      expect(dropped).not.toContain(recent);
      expect(dropped).not.toContain(handNamed);
      expect(await databaseExists(staleIdle)).toBe(false);
      expect(await databaseExists(staleInUse)).toBe(true);
      expect(await databaseExists(recent)).toBe(true);
      expect(await databaseExists(handNamed)).toBe(true);
    } finally {
      await openConnection.end({ timeout: 5 });
      for (const name of all) await dropDatabase(name);
    }
  });
});
