import { describe, expect, it } from "vitest";

import { useTestDatabase } from "@/db/testing";

import { addAppUser, checkAccess, isValidEmail, removeAppUser, upsertOwner } from "./allow-list";

describe("isValidEmail", () => {
  it.each(["owner@example.test", "first.last+tag@sub.example.co", "a@b.c"])("accepts %s", (email) => {
    expect(isValidEmail(email)).toBe(true);
  });

  it.each([
    ["an empty string", ""],
    ["no @", "owner.example.test"],
    ["no dot in the domain", "owner@localhost"],
    ["two @", "a@b@example.test"],
    ["a space", "own er@example.test"],
    ["an empty domain label", "name@gmail..com"],
    ["a leading dot in the domain", "name@.gmail.com"],
    ["a trailing dot in the domain", "name@gmail.com."],
    ["an empty local part", "@example.test"],
    ["over 254 characters", `${"a".repeat(250)}@example.test`],
  ])("rejects %s", (_label, email) => {
    expect(isValidEmail(email)).toBe(false);
  });
});

describe("sign-in allow-list", () => {
  const db = useTestDatabase();

  it("treats a request with no signed-in email as anonymous", async () => {
    expect(await checkAccess(db.sql, null)).toEqual({ status: "anonymous" });
  });

  it("denies an email that is not on the list", async () => {
    expect(await checkAccess(db.sql, "stranger@example.test")).toEqual({
      status: "denied",
      email: "stranger@example.test",
    });
  });

  it("seeds the owner idempotently and matches their email case-insensitively", async () => {
    await upsertOwner(db.sql, "  Owner.One@Example.TEST ");
    await upsertOwner(db.sql, "owner.one@example.test");

    expect(await checkAccess(db.sql, "OWNER.ONE@example.test")).toEqual({
      status: "allowed",
      user: { email: "owner.one@example.test", role: "owner" },
    });
    const [{ count }] = await db.sql<{ count: number }[]>`
      select count(*)::int as count from app_users where email = 'owner.one@example.test'
    `;
    expect(count).toBe(1);
  });

  it("promotes an existing manager to owner when they are the configured owner", async () => {
    await addAppUser(db.sql, "promoted@example.test", "manager");
    await upsertOwner(db.sql, "Promoted@example.test");
    expect(await checkAccess(db.sql, "promoted@example.test")).toMatchObject({
      status: "allowed",
      user: { role: "owner" },
    });
  });

  it("lets a manager in until they are removed", async () => {
    await addAppUser(db.sql, "Manager.A@example.test", "manager");
    expect(await checkAccess(db.sql, "manager.a@example.test")).toEqual({
      status: "allowed",
      user: { email: "manager.a@example.test", role: "manager" },
    });

    expect(await removeAppUser(db.sql, "MANAGER.A@example.test")).toBe(true);
    expect(await checkAccess(db.sql, "manager.a@example.test")).toEqual({
      status: "denied",
      email: "manager.a@example.test",
    });
  });

  it("stamps updated_at when a row changes", async () => {
    await addAppUser(db.sql, "stamped@example.test", "manager");
    const [before] = await db.sql<{ createdAt: Date; updatedAt: Date }[]>`
      select created_at, updated_at from app_users where email = 'stamped@example.test'
    `;
    await addAppUser(db.sql, "stamped@example.test", "owner");
    const [after] = await db.sql<{ createdAt: Date; updatedAt: Date }[]>`
      select created_at, updated_at from app_users where email = 'stamped@example.test'
    `;
    expect(after!.createdAt).toEqual(before!.createdAt);
    expect(after!.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime());
  });

  it("rejects rows that bypass normalisation or use an unknown role", async () => {
    await expect(
      db.sql`insert into app_users (email, role) values ('Mixed@Example.test', 'manager')`,
    ).rejects.toThrow(/app_users_email_normalised/);
    await expect(
      db.sql`insert into app_users (email, role) values ('x@example.test', 'admin')`,
    ).rejects.toThrow(/app_users_role_valid/);
  });
});
