import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Encryption at rest for Kreloses passwords: AES-256-GCM with a 32-byte key from the
 * `CREDENTIALS_ENCRYPTION_KEY` environment variable (base64; generate one with
 * `openssl rand -base64 32`). Server only; the key and the plaintext never reach the browser.
 *
 * Stored envelope (text, dot-separated, base64url parts):
 *
 *   v1.<key id>.<12-byte IV>.<16-byte GCM tag>.<ciphertext>
 *
 * The key id is a fingerprint of the key (first 8 hex chars of a SHA-256 over it), so a password
 * encrypted under an older key is recognised as such. To rotate later: add the old key to the
 * keyring's `previous` list (e.g. from a `CREDENTIALS_ENCRYPTION_KEY_PREVIOUS` variable), then
 * re-encrypt rows with `encryptSecret(decryptSecret(row))`. See docs/adr/0003.
 */

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Additional authenticated data: binds ciphertexts to this purpose. */
const AAD = Buffer.from("kreloses-connection-password:v1");

export interface EncryptionKey {
  id: string;
  key: Buffer;
}

export interface Keyring {
  /** Encrypts new values. */
  current: EncryptionKey;
  /** Older keys that can still decrypt (none until a rotation is needed). */
  previous: EncryptionKey[];
}

/** The key is missing or malformed. The app refuses to store or read passwords without it. */
export class CredentialsKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialsKeyError";
  }
}

/** Thrown when an envelope cannot be decrypted (wrong key, tampered, or not an envelope). */
export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecryptionError";
  }
}

export function keyringFromEnv(env: Record<string, string | undefined>): Keyring {
  const raw = env.CREDENTIALS_ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw new CredentialsKeyError(
      "CREDENTIALS_ENCRYPTION_KEY is not set, so Kreloses passwords cannot be stored or read. " +
        "Generate one with `openssl rand -base64 32` and set it in the server environment (see README).",
    );
  }
  return { current: parseKey(raw), previous: [] };
}

function parseKey(raw: string): EncryptionKey {
  const key = /^[A-Za-z0-9+/]+={0,2}$/.test(raw) ? Buffer.from(raw, "base64") : Buffer.alloc(0);
  if (key.length !== 32 || key.toString("base64") !== raw) {
    throw new CredentialsKeyError(
      "CREDENTIALS_ENCRYPTION_KEY must be exactly 32 bytes, base64-encoded (`openssl rand -base64 32`).",
    );
  }
  return { id: keyId(key), key };
}

function keyId(key: Buffer): string {
  return createHash("sha256").update("kreloses-credentials-key-id:").update(key).digest("hex").slice(0, 8);
}

export function encryptSecret(plaintext: string, keyring: Keyring): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyring.current.key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, keyring.current.id, b64(iv), b64(tag), b64(ciphertext)].join(".");
}

export function decryptSecret(envelope: string, keyring: Keyring): string {
  const parts = envelope.split(".");
  if (parts.length !== 5 || parts[0] !== VERSION) {
    throw new DecryptionError("Unsupported credential envelope (expected v1).");
  }
  const [, id, ivText, tagText, ciphertextText] = parts as [string, string, string, string, string];
  const key = [keyring.current, ...keyring.previous].find((candidate) => candidate.id === id);
  if (!key) {
    throw new DecryptionError(
      `This password was encrypted with key ${id}, but the current key is ${keyring.current.id}. ` +
        "CREDENTIALS_ENCRYPTION_KEY has changed: restore the old key, or re-enter the password.",
    );
  }
  const iv = Buffer.from(ivText, "base64url");
  const tag = Buffer.from(tagText, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new DecryptionError("The stored password could not be decrypted (malformed envelope).");
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key.key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new DecryptionError("The stored password could not be decrypted (wrong key or tampered data).");
  }
}

function b64(buffer: Buffer): string {
  return buffer.toString("base64url");
}
