import { beforeEach, describe, expect, it } from "vitest";

import { useTestDatabase } from "@/db/testing";

import { addAppUser, checkAccess, listAllowList, recordSignIn, upsertOwner, type Access } from "./allow-list";
import { inviteManager, removeManager, type SignInLinkSender } from "./managers";

const OWNER = "owner@example.test";
const OTHER_OWNER = "second.owner@example.test";

const asOwner: Access = { status: "allowed", user: { email: OWNER, role: "owner" } };
const asManager: Access = { status: "allowed", user: { email: "manager@example.test", role: "manager" } };
const notAllowListed: Access = { status: "denied", email: "stranger@example.test" };
const anonymous: Access = { status: "anonymous" };

/** A fake mailer: records who was sent a sign-in link, or fails like Supabase Auth would. */
function fakeMailer(behaviour: "deliver" | "fail" | "throw" = "deliver") {
  const sentTo: string[] = [];
  const send: SignInLinkSender = async (email) => {
    if (behaviour === "throw") throw new Error("network down");
    if (behaviour === "fail") return { ok: false, message: "Email rate limit exceeded" };
    sentTo.push(email);
    return { ok: true };
  };
  return { send, sentTo };
}

describe("inviting and removing managers", () => {
  const db = useTestDatabase();

  beforeEach(async () => {
    await db.sql`delete from app_users`;
    await upsertOwner(db.sql, OWNER);
    await addAppUser(db.sql, "manager@example.test", "manager");
  });

  describe("inviteManager", () => {
    it("adds the email as a manager, records who invited them, and emails them a sign-in link", async () => {
      const mailer = fakeMailer();
      const result = await inviteManager(
        { sql: db.sql, actor: asOwner, sendSignInLink: mailer.send },
        "  New.Manager@Example.TEST ",
      );

      expect(result).toEqual({ status: "invited", email: "new.manager@example.test", emailSent: true });
      expect(mailer.sentTo).toEqual(["new.manager@example.test"]);
      expect(await checkAccess(db.sql, "NEW.MANAGER@example.test")).toEqual({
        status: "allowed",
        user: { email: "new.manager@example.test", role: "manager" },
      });
      const entry = (await listAllowList(db.sql)).find((row) => row.email === "new.manager@example.test");
      expect(entry).toMatchObject({ role: "manager", invitedBy: OWNER, lastSignInAt: null });
      expect(entry!.addedAt).toBeInstanceOf(Date);
    });

    it("keeps the invite when the email cannot be sent, and says so", async () => {
      const result = await inviteManager(
        { sql: db.sql, actor: asOwner, sendSignInLink: fakeMailer("fail").send },
        "unlucky@example.test",
      );
      expect(result).toEqual({
        status: "invited",
        email: "unlucky@example.test",
        emailSent: false,
        emailError: "Email rate limit exceeded",
      });
      expect(await checkAccess(db.sql, "unlucky@example.test")).toMatchObject({ status: "allowed" });
    });

    it("keeps the invite when sending throws", async () => {
      const result = await inviteManager(
        { sql: db.sql, actor: asOwner, sendSignInLink: fakeMailer("throw").send },
        "offline@example.test",
      );
      expect(result).toMatchObject({ status: "invited", email: "offline@example.test", emailSent: false });
      expect(await checkAccess(db.sql, "offline@example.test")).toMatchObject({ status: "allowed" });
    });

    it.each([
      ["an empty value", ""],
      ["no @", "not-an-email"],
      ["no domain dot", "someone@localhost"],
      ["spaces inside", "some one@example.test"],
      ["two @", "a@b@example.test"],
      ["a missing value", null],
      ["a non-string value", 42],
      ["an over-long address", `${"a".repeat(250)}@example.test`],
    ])("refuses %s without touching the allow-list or sending email", async (_label, value) => {
      const mailer = fakeMailer();
      const result = await inviteManager({ sql: db.sql, actor: asOwner, sendSignInLink: mailer.send }, value);
      expect(result.status).toBe("invalid-email");
      expect(mailer.sentTo).toEqual([]);
      expect(await listAllowList(db.sql)).toHaveLength(2);
    });

    it("treats inviting someone already on the list as a no-op (case-insensitively)", async () => {
      const mailer = fakeMailer();
      const result = await inviteManager(
        { sql: db.sql, actor: asOwner, sendSignInLink: mailer.send },
        "MANAGER@example.test",
      );
      expect(result).toEqual({ status: "already-listed", email: "manager@example.test", role: "manager" });
      expect(mailer.sentTo).toEqual([]);
      expect(await listAllowList(db.sql)).toHaveLength(2);
    });

    it("never demotes an owner who is 'invited' as a manager", async () => {
      await upsertOwner(db.sql, OTHER_OWNER);
      const result = await inviteManager(
        { sql: db.sql, actor: asOwner, sendSignInLink: fakeMailer().send },
        OTHER_OWNER.toUpperCase(),
      );
      expect(result).toEqual({ status: "already-listed", email: OTHER_OWNER, role: "owner" });
      expect(await checkAccess(db.sql, OTHER_OWNER)).toMatchObject({ user: { role: "owner" } });
    });

    it.each([
      ["a manager", asManager],
      ["someone signed in but not on the allow-list", notAllowListed],
      ["an anonymous visitor", anonymous],
    ])("refuses %s: nothing is added and no email is sent", async (_label, actor) => {
      const mailer = fakeMailer();
      const result = await inviteManager({ sql: db.sql, actor, sendSignInLink: mailer.send }, "sneaky@example.test");
      expect(result).toEqual({ status: "forbidden" });
      expect(mailer.sentTo).toEqual([]);
      expect(await checkAccess(db.sql, "sneaky@example.test")).toMatchObject({ status: "denied" });
    });
  });

  describe("removeManager", () => {
    it("removes a manager, who is refused from then on", async () => {
      const result = await removeManager({ sql: db.sql, actor: asOwner, ownerEmail: OWNER }, " Manager@Example.test ");
      expect(result).toEqual({ status: "removed", email: "manager@example.test" });
      expect(await checkAccess(db.sql, "manager@example.test")).toEqual({
        status: "denied",
        email: "manager@example.test",
      });
    });

    it("refuses to remove the signed-in owner themselves", async () => {
      const result = await removeManager({ sql: db.sql, actor: asOwner, ownerEmail: null }, OWNER.toUpperCase());
      expect(result).toEqual({ status: "protected", email: OWNER, reason: "yourself" });
      expect(await checkAccess(db.sql, OWNER)).toMatchObject({ status: "allowed", user: { role: "owner" } });
    });

    it("refuses to remove the owner configured in OWNER_EMAIL", async () => {
      await upsertOwner(db.sql, OTHER_OWNER);
      const result = await removeManager(
        { sql: db.sql, actor: asOwner, ownerEmail: " Second.Owner@Example.TEST " },
        OTHER_OWNER,
      );
      expect(result).toEqual({ status: "protected", email: OTHER_OWNER, reason: "configured-owner" });
      expect(await checkAccess(db.sql, OTHER_OWNER)).toMatchObject({ status: "allowed" });
    });

    it("refuses to remove any other owner", async () => {
      await upsertOwner(db.sql, OTHER_OWNER);
      const result = await removeManager({ sql: db.sql, actor: asOwner, ownerEmail: OWNER }, OTHER_OWNER);
      expect(result).toEqual({ status: "protected", email: OTHER_OWNER, reason: "owner" });
      expect(await checkAccess(db.sql, OTHER_OWNER)).toMatchObject({ user: { role: "owner" } });
    });

    it("reports an email that is not on the list", async () => {
      const result = await removeManager({ sql: db.sql, actor: asOwner, ownerEmail: OWNER }, "ghost@example.test");
      expect(result).toEqual({ status: "not-listed", email: "ghost@example.test" });
    });

    it("refuses a value that is not an email", async () => {
      const result = await removeManager({ sql: db.sql, actor: asOwner, ownerEmail: OWNER }, null);
      expect(result).toEqual({ status: "not-listed", email: "" });
      expect(await listAllowList(db.sql)).toHaveLength(2);
    });

    it.each([
      ["a manager", asManager],
      ["someone signed in but not on the allow-list", notAllowListed],
      ["an anonymous visitor", anonymous],
    ])("refuses %s: the manager keeps access", async (_label, actor) => {
      await addAppUser(db.sql, "colleague@example.test", "manager");
      const result = await removeManager({ sql: db.sql, actor, ownerEmail: OWNER }, "colleague@example.test");
      expect(result).toEqual({ status: "forbidden" });
      expect(await checkAccess(db.sql, "colleague@example.test")).toMatchObject({ status: "allowed" });
    });
  });

  describe("listAllowList", () => {
    it("lists owners first, then managers in the order they were added", async () => {
      await inviteManager({ sql: db.sql, actor: asOwner, sendSignInLink: fakeMailer().send }, "b.later@example.test");
      await upsertOwner(db.sql, OTHER_OWNER);
      expect((await listAllowList(db.sql)).map(({ email, role }) => `${role}:${email}`)).toEqual([
        `owner:${OWNER}`,
        `owner:${OTHER_OWNER}`,
        "manager:manager@example.test",
        "manager:b.later@example.test",
      ]);
    });

    it("shows when someone last signed in", async () => {
      await recordSignIn(db.sql, "Manager@Example.test");
      await recordSignIn(db.sql, "not-listed@example.test"); // ignored: not on the list
      const rows = await listAllowList(db.sql);
      expect(rows.find((row) => row.email === "manager@example.test")!.lastSignInAt).toBeInstanceOf(Date);
      expect(rows.find((row) => row.email === OWNER)!.lastSignInAt).toBeNull();
      expect(rows).toHaveLength(2);
    });
  });
});
