// D21 / §10 — secrets encrypted at rest. AES-256-GCM authenticated encryption for
// Integration credentials. The key comes from env DIONYSUS_CONFIG_KEY (base64 of 32
// bytes); a missing/malformed key is FAIL-CLOSED (throws — never a silent plaintext
// fallback). Each encryption uses a fresh random 12-byte IV; the 16-byte GCM auth tag
// makes any tamper a decrypt failure. Blob format: `v1.<ivB64>.<tagB64>.<ctB64>`.
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

export const CONFIG_KEY_ENV = "DIONYSUS_CONFIG_KEY";
const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const TAG_BYTES = 16;
const VERSION = "v1";

/** Load + validate the 32-byte key from env. Fail-closed: throws on missing/wrong-length. */
function loadKey(env: Record<string, string | undefined>): Buffer {
  const raw = env[CONFIG_KEY_ENV];
  if (!raw) throw new Error(`${CONFIG_KEY_ENV} is not set — cannot encrypt/decrypt integration secrets.`);
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new Error(`${CONFIG_KEY_ENV} is not valid base64.`);
  }
  if (key.length !== KEY_BYTES) throw new Error(`${CONFIG_KEY_ENV} must decode to ${KEY_BYTES} bytes (got ${key.length}).`);
  return key;
}

export function encryptSecret(plaintext: string, env: Record<string, string | undefined> = process.env): string {
  const key = loadKey(env);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(".");
}

export function decryptSecret(blob: string, env: Record<string, string | undefined> = process.env): string {
  const key = loadKey(env);
  const parts = blob.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("Malformed secret blob.");
  const iv = Buffer.from(parts[1]!, "base64");
  const tag = Buffer.from(parts[2]!, "base64");
  const ct = Buffer.from(parts[3]!, "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error("Malformed secret blob.");
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8"); // .final() throws on a bad tag
}
