import { test, expect } from "bun:test";

process.env.SECRET_KEY = "test-phase-key";
const { encrypt, decrypt, isEncrypted, encryptionEnabled } = await import(
  "../src/crypto"
);

test("encryption enabled when SECRET_KEY set", () => {
  expect(encryptionEnabled()).toBe(true);
});

test("roundtrip", () => {
  const plain = "postgres://user:pass@host/db";
  const enc = encrypt(plain);
  expect(enc).toStartWith("enc:v1:");
  expect(isEncrypted(enc)).toBe(true);
  expect(decrypt(enc)).toBe(plain);
});

test("plaintext passthrough", () => {
  expect(decrypt("just-plaintext")).toBe("just-plaintext");
  expect(isEncrypted("just-plaintext")).toBe(false);
});

test("tampered ciphertext fails closed", () => {
  const enc = encrypt("secret");
  const tampered = enc.slice(0, -4) + "AAAA";
  expect(decrypt(tampered)).toBeUndefined();
});

test("distinct ciphertexts for same plaintext", () => {
  expect(encrypt("same")).not.toBe(encrypt("same"));
});
