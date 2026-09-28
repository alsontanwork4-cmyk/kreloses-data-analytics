import { describe, expect, it } from "vitest";

import { sqlOptionsFromEnv } from "./env";

const url = (port: number) => `postgresql://app:secret@db.example.test:${port}/postgres?sslmode=require`;

describe("sqlOptionsFromEnv", () => {
  it("requires DATABASE_URL", () => {
    expect(() => sqlOptionsFromEnv({})).toThrow(/DATABASE_URL is not set/);
  });

  it("uses prepared statements on a direct or session-mode connection", () => {
    expect(sqlOptionsFromEnv({ DATABASE_URL: url(5432) })).toMatchObject({ prepare: true, max: 3 });
  });

  it("turns prepared statements off behind Supabase's transaction pooler (port 6543)", () => {
    expect(sqlOptionsFromEnv({ DATABASE_URL: url(6543) })).toMatchObject({ prepare: false });
  });

  it("lets DATABASE_PREPARE override the default either way", () => {
    expect(sqlOptionsFromEnv({ DATABASE_URL: url(5432), DATABASE_PREPARE: "false" }).prepare).toBe(false);
    expect(sqlOptionsFromEnv({ DATABASE_URL: url(6543), DATABASE_PREPARE: "true" }).prepare).toBe(true);
  });

  it("reads the pool size, ignoring nonsense", () => {
    expect(sqlOptionsFromEnv({ DATABASE_URL: url(5432), DATABASE_POOL_MAX: "5" }).max).toBe(5);
    expect(sqlOptionsFromEnv({ DATABASE_URL: url(5432), DATABASE_POOL_MAX: "zero" }).max).toBe(3);
  });
});
