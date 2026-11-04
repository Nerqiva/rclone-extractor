import {
  scryptSync,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { SECRET_KEY } from "./config";

const PREFIX = "enc:v1:";
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

export function encryptionEnabled(): boolean {
  return SECRET_KEY.length > 0;
}

function deriveKey(salt: Buffer): Buffer {
  return scryptSync(SECRET_KEY, salt, KEY_LEN);
}

export function encrypt(plain: string): string {
  if (!encryptionEnabled()) return plain;
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([salt, iv, tag, ciphertext]);
  return PREFIX + payload.toString("base64");
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function decrypt(stored: string): string | undefined {
  if (!isEncrypted(stored)) return stored;
  if (!encryptionEnabled()) return undefined;
  try {
    const payload = Buffer.from(stored.slice(PREFIX.length), "base64");
    const salt = payload.subarray(0, SALT_LEN);
    const iv = payload.subarray(SALT_LEN, SALT_LEN + IV_LEN);
    const tag = payload.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN);
    const ciphertext = payload.subarray(SALT_LEN + IV_LEN + TAG_LEN);
    const key = deriveKey(salt);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return plain.toString("utf8");
  } catch {
    console.warn("decrypt failed: wrong SECRET_KEY or corrupted value");
    return undefined;
  }
}
