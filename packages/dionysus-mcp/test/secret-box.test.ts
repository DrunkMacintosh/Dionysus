import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret, CONFIG_KEY_ENV } from "../src/lib/secret-box.js";

// A deterministic 32-byte key, base64-encoded (AES-256).
const KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
const env = { [CONFIG_KEY_ENV]: KEY };

describe("secret-box", () => {
  it("round-trips a secret through encrypt → decrypt", () => {
    const secret = JSON.stringify({ apiKey: "plausible-abc123", endpoint: "https://plausible.io/api" });
    const blob = encryptSecret(secret, env);
    expect(decryptSecret(blob, env)).toBe(secret);
  });

  it("never emits the plaintext in the ciphertext blob", () => {
    const blob = encryptSecret("super-secret-token", env);
    expect(blob).not.toContain("super-secret-token");
    expect(blob.startsWith("v1.")).toBe(true);
  });

  it("produces a DIFFERENT ciphertext each call (random IV) for the same plaintext", () => {
    const a = encryptSecret("same", env);
    const b = encryptSecret("same", env);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, env)).toBe("same");
    expect(decryptSecret(b, env)).toBe("same");
  });

  it("rejects a tampered ciphertext (GCM auth tag) — no silent plaintext", () => {
    const blob = encryptSecret("secret", env);
    const parts = blob.split(".");
    const ct = Buffer.from(parts[3]!, "base64");
    ct[0] = ct[0]! ^ 0xff;
    const tampered = [parts[0], parts[1], parts[2], ct.toString("base64")].join(".");
    expect(() => decryptSecret(tampered, env)).toThrow();
  });

  it("is fail-closed when the key is missing", () => {
    expect(() => encryptSecret("x", {})).toThrow(/DIONYSUS_CONFIG_KEY/);
    const blob = encryptSecret("x", env);
    expect(() => decryptSecret(blob, {})).toThrow(/DIONYSUS_CONFIG_KEY/);
  });

  it("is fail-closed when the key is the wrong length (not 32 bytes)", () => {
    const shortKey = { [CONFIG_KEY_ENV]: Buffer.from("too-short").toString("base64") };
    expect(() => encryptSecret("x", shortKey)).toThrow(/32/);
  });

  it("cannot decrypt with a different key", () => {
    const blob = encryptSecret("secret", env);
    const otherKey = { [CONFIG_KEY_ENV]: Buffer.from("fedcba9876543210fedcba9876543210").toString("base64") };
    expect(() => decryptSecret(blob, otherKey)).toThrow();
  });
});
