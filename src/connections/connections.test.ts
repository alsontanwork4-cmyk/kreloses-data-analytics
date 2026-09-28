import { randomBytes } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import { useTestDatabase } from "@/db/testing";
import { listLocations } from "@/kreloses";
import { SYNTHETIC_ACCOUNTS, createFakeKreloses, type FakeKreloses } from "@/kreloses/testing/fake-kreloses";

import { keyringFromEnv } from "./encryption";
import {
  ConnectionNotFound,
  deleteConnection,
  listConnections,
  loginAsConnection,
  saveConnection,
  testConnection,
  type ConnectionsContext,
} from "./service";

/**
 * The Connections feature end to end below the UI: validate → encrypt → store → live login test
 * (against the fake Kreloses) → stored status and visible branches.
 */
const { north, south, both, oneTimeCode, down } = SYNTHETIC_ACCOUNTS;

describe("Kreloses connections", () => {
  const db = useTestDatabase();
  let fake: FakeKreloses;
  let context: ConnectionsContext;

  beforeEach(async () => {
    await db.sql`delete from connections`;
    fake = createFakeKreloses();
    const keyring = keyringFromEnv({ CREDENTIALS_ENCRYPTION_KEY: randomBytes(32).toString("base64") });
    context = { sql: db.sql, keyring: () => keyring, reader: { requestDelayMs: 0, transport: fake.transport } };
  });

  it("saves a login, tests it, and stores OK with the branches it can see", async () => {
    const result = await saveConnection(context, { label: " Branch North ", email: " North.Branch@Clinic.example ", password: north.password });
    expect(result).toMatchObject({
      ok: true,
      connection: {
        label: "Branch North",
        email: north.email,
        status: "ok",
        lastError: null,
        lastErrorCode: null,
        visibleLocations: [{ id: "1101", name: "Branch North" }],
      },
    });
    const [connection] = await listConnections(db.sql);
    expect(connection).toEqual(result.ok && result.connection);
    expect(connection!.lastTestedAt).toBeInstanceOf(Date);
  });

  it("stores the password encrypted, and never returns it (or its ciphertext) in the connection list", async () => {
    await saveConnection(context, { label: "Branch North", email: north.email, password: north.password });

    const [row] = await db.sql<{ passwordCiphertext: string }[]>`select password_ciphertext from connections`;
    expect(row!.passwordCiphertext).toMatch(/^v1\.[0-9a-f]{8}\./);
    expect(row!.passwordCiphertext).not.toContain(north.password);

    const list = await listConnections(db.sql);
    const payload = JSON.stringify(list);
    expect(payload).not.toContain(north.password);
    expect(payload).not.toContain(row!.passwordCiphertext);
    for (const connection of list) {
      expect(Object.keys(connection).filter((key) => /password|cipher|secret/i.test(key))).toEqual([]);
    }
  });

  it("still saves a login that fails its test, with a clear reason", async () => {
    const wrong = await saveConnection(context, { label: "Branch South", email: south.email, password: "not-the-password" });
    expect(wrong).toMatchObject({
      ok: true,
      connection: { status: "failed", lastErrorCode: "bad_credentials", visibleLocations: [] },
    });
    expect(wrong.ok && wrong.connection.lastError).toMatch(/rejected this email or password/);
    expect(wrong.ok && wrong.connection.lastError).toContain("Invalid login attempt.");

    const otp = await saveConnection(context, { label: "Two step", email: oneTimeCode.email, password: oneTimeCode.password });
    expect(otp).toMatchObject({ ok: true, connection: { status: "failed", lastErrorCode: "unexpected_step" } });
    expect(otp.ok && otp.connection.lastError).toMatch(/one-time code/);

    const unreachable = await saveConnection(context, { label: "Down", email: down.email, password: down.password });
    expect(unreachable).toMatchObject({ ok: true, connection: { status: "failed", lastErrorCode: "unreachable" } });
    expect(unreachable.ok && unreachable.connection.lastError).toBe(
      "Couldn't reach Kreloses (Kreloses answered HTTP 503 to POST www.kreloses.com/account/login). Check the internet connection or try again in a few minutes.",
    );

    expect(await listConnections(db.sql)).toHaveLength(3);
  });

  it("supports several connections, one per branch login", async () => {
    await saveConnection(context, { label: "Branch South", email: south.email, password: south.password });
    await saveConnection(context, { label: "Branch North", email: north.email, password: north.password });
    const list = await listConnections(db.sql);
    expect(list.map((connection) => [connection.label, connection.status, connection.visibleLocations])).toEqual([
      ["Branch North", "ok", [{ id: "1101", name: "Branch North" }]],
      ["Branch South", "ok", [{ id: "1102", name: "Branch South" }]],
    ]);
  });

  it("refuses a second connection for the same Kreloses login or with the same name", async () => {
    await saveConnection(context, { label: "Branch North", email: north.email, password: north.password });
    expect(await saveConnection(context, { label: "Other", email: "NORTH.branch@clinic.example", password: "x" })).toEqual({
      ok: false,
      fieldErrors: { email: "There is already a connection for this Kreloses login." },
    });
    expect(await saveConnection(context, { label: "branch north", email: south.email, password: "x" })).toEqual({
      ok: false,
      fieldErrors: { label: "There is already a connection with this name." },
    });
  });

  it("validates the form", async () => {
    expect(await saveConnection(context, { label: "", email: "nope", password: "" })).toEqual({
      ok: false,
      fieldErrors: {
        label: "Enter a name for this connection.",
        email: "Enter the email address you sign in to Kreloses with.",
        password: "Enter the Kreloses password.",
      },
    });
    expect(await saveConnection(context, { label: "x".repeat(81), email: north.email, password: "p" })).toMatchObject({
      ok: false,
      fieldErrors: { label: "Keep the name to 80 characters or fewer." },
    });
    expect(await listConnections(db.sql)).toEqual([]);
  });

  it("edits a connection: a blank password keeps the stored one", async () => {
    const created = await saveConnection(context, { label: "Branch", email: both.email, password: both.password });
    const id = created.ok ? created.connection.id : "";
    const [before] = await db.sql<{ passwordCiphertext: string }[]>`select password_ciphertext from connections`;

    const renamed = await saveConnection(context, { id, label: "Both branches", email: both.email, password: "" });
    expect(renamed).toMatchObject({
      ok: true,
      connection: { id, label: "Both branches", status: "ok", visibleLocations: [{ id: "1101" }, { id: "1102" }] },
    });
    const [after] = await db.sql<{ passwordCiphertext: string }[]>`select password_ciphertext from connections`;
    expect(after!.passwordCiphertext).toBe(before!.passwordCiphertext);
  });

  it("edits a connection: a new email and password are tested again", async () => {
    const created = await saveConnection(context, { label: "South", email: south.email, password: "wrong" });
    expect(created).toMatchObject({ ok: true, connection: { status: "failed" } });
    const id = created.ok ? created.connection.id : "";

    const fixed = await saveConnection(context, { id, label: "South", email: south.email, password: south.password });
    expect(fixed).toMatchObject({
      ok: true,
      connection: { id, status: "ok", lastError: null, visibleLocations: [{ id: "1102", name: "Branch South" }] },
    });

    const moved = await saveConnection(context, { id, label: "South", email: north.email, password: "" });
    expect(moved).toMatchObject({ ok: true, connection: { email: north.email, status: "failed", lastErrorCode: "bad_credentials" } });
  });

  it("reports an edit of a connection that no longer exists", async () => {
    expect(await saveConnection(context, { id: "999999", label: "Gone", email: north.email, password: "" })).toEqual({
      ok: false,
      formError: "That connection no longer exists. Reload the page.",
    });
    expect(await saveConnection(context, { id: "abc", label: "Gone", email: north.email, password: "" })).toMatchObject({
      ok: false,
    });
  });

  it("tests a saved connection again on demand", async () => {
    const created = await saveConnection(context, { label: "North", email: north.email, password: north.password });
    const id = created.ok ? created.connection.id : "";
    const firstTestedAt = created.ok ? created.connection.lastTestedAt! : new Date(0);

    fake.intercept((request) =>
      request.method === "POST" && request.url.pathname === "/account/login" ? new Response("busy", { status: 429 }) : undefined,
    );
    const retested = await testConnection(context, id);
    expect(retested).toMatchObject({ status: "failed", lastErrorCode: "rate_limited", visibleLocations: [] });
    expect(retested!.lastTestedAt!.getTime()).toBeGreaterThanOrEqual(firstTestedAt.getTime());
    expect(await testConnection(context, "424242")).toBeNull();
  });

  it("fails closed when the encryption key is missing", async () => {
    const missingKey: ConnectionsContext = {
      ...context,
      keyring: () => keyringFromEnv({}),
    };
    expect(await saveConnection(missingKey, { label: "North", email: north.email, password: north.password })).toEqual({
      ok: false,
      formError: expect.stringMatching(/CREDENTIALS_ENCRYPTION_KEY is not set/),
    });
    expect(await listConnections(db.sql)).toEqual([]);
  });

  it("marks a connection failed when its password can no longer be decrypted (key changed)", async () => {
    const created = await saveConnection(context, { label: "North", email: north.email, password: north.password });
    const id = created.ok ? created.connection.id : "";
    const otherKey = keyringFromEnv({ CREDENTIALS_ENCRYPTION_KEY: randomBytes(32).toString("base64") });
    const retested = await testConnection({ ...context, keyring: () => otherKey }, id);
    expect(retested).toMatchObject({ status: "failed", lastErrorCode: "key_problem" });
    expect(retested!.lastError).toMatch(/CREDENTIALS_ENCRYPTION_KEY has changed/);
  });

  it("logs in as a saved connection (for the Sync Engine)", async () => {
    const created = await saveConnection(context, { label: "Both", email: both.email, password: both.password });
    const id = created.ok ? created.connection.id : "";
    const session = await loginAsConnection(context, id);
    expect(await listLocations(session)).toHaveLength(2);
    await expect(loginAsConnection(context, "424242")).rejects.toBeInstanceOf(ConnectionNotFound);
  });

  it("deletes a connection", async () => {
    const created = await saveConnection(context, { label: "North", email: north.email, password: north.password });
    const id = created.ok ? created.connection.id : "";
    expect(await deleteConnection(db.sql, id)).toBe(true);
    expect(await deleteConnection(db.sql, id)).toBe(false);
    expect(await deleteConnection(db.sql, "not-an-id")).toBe(false);
    expect(await listConnections(db.sql)).toEqual([]);
  });
});
