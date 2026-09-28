import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { CredentialsKeyError, decryptSecret, encryptSecret, keyringFromEnv } from "./encryption";

const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64");
const keyA = keyringFromEnv({ CREDENTIALS_ENCRYPTION_KEY: KEY_A });
const keyB = keyringFromEnv({ CREDENTIALS_ENCRYPTION_KEY: KEY_B });

describe("credential encryption (AES-256-GCM)", () => {
  it("round-trips a password, including non-ASCII characters", () => {
    for (const password of ["hunter2", "pässwörd with spaces & symbols !@#$%^&*()", "密码", ""]) {
      const envelope = encryptSecret(password, keyA);
      expect(envelope).not.toContain(password || "\u0000");
      expect(decryptSecret(envelope, keyA)).toBe(password);
    }
  });

  it("stores a versioned envelope with a key id, and a fresh IV every time", () => {
    const first = encryptSecret("same password", keyA);
    const second = encryptSecret("same password", keyA);
    expect(first).not.toBe(second);
    const [version, keyId, iv, tag, ciphertext] = first.split(".");
    expect(version).toBe("v1");
    expect(keyId).toBe(keyA.current.id);
    expect(keyId).toMatch(/^[0-9a-f]{8}$/);
    expect(Buffer.from(iv!, "base64url")).toHaveLength(12);
    expect(Buffer.from(tag!, "base64url")).toHaveLength(16);
    expect(ciphertext!.length).toBeGreaterThan(0);
    expect(first.split(".")[1]).toBe(second.split(".")[1]);
  });

  it("detects tampering with any part of the envelope", () => {
    const envelope = encryptSecret("do not touch", keyA);
    const parts = envelope.split(".");
    for (const index of [2, 3, 4]) {
      const bytes = Buffer.from(parts[index]!, "base64url");
      bytes[0] = bytes[0]! ^ 0x01;
      const tampered = [...parts];
      tampered[index] = bytes.toString("base64url");
      expect(() => decryptSecret(tampered.join("."), keyA)).toThrow(/could not be decrypted/);
    }
    expect(() => decryptSecret(`v9.${parts.slice(1).join(".")}`, keyA)).toThrow(/Unsupported/);
    expect(() => decryptSecret("not an envelope", keyA)).toThrow(/Unsupported/);
  });

  it("refuses to decrypt with a different key, naming the key ids", () => {
    const envelope = encryptSecret("secret", keyA);
    expect(() => decryptSecret(envelope, keyB)).toThrow(
      new RegExp(`encrypted with key ${keyA.current.id}.*current key is ${keyB.current.id}`),
    );
    // Even a forged key id does not help: the GCM tag still fails.
    const forged = envelope.replace(`.${keyA.current.id}.`, `.${keyB.current.id}.`);
    expect(() => decryptSecret(forged, keyB)).toThrow(/could not be decrypted/);
  });

  it("fails closed with a clear error when the key is missing or invalid", () => {
    expect(() => keyringFromEnv({})).toThrow(CredentialsKeyError);
    expect(() => keyringFromEnv({})).toThrow(/CREDENTIALS_ENCRYPTION_KEY is not set.*openssl rand -base64 32/);
    expect(() => keyringFromEnv({ CREDENTIALS_ENCRYPTION_KEY: "  " })).toThrow(/is not set/);
    expect(() => keyringFromEnv({ CREDENTIALS_ENCRYPTION_KEY: randomBytes(16).toString("base64") })).toThrow(
      /32 bytes/,
    );
    expect(() => keyringFromEnv({ CREDENTIALS_ENCRYPTION_KEY: "not base64 at all!!" })).toThrow(/32 bytes/);
    // The key itself never appears in the error.
    const short = randomBytes(16).toString("base64");
    let message = "";
    try {
      keyringFromEnv({ CREDENTIALS_ENCRYPTION_KEY: short });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/32 bytes/);
    expect(message).not.toContain(short);
  });
});
