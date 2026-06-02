import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { env } from "./env";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

function getKey(): Buffer {
  const key = env.tokenEncryptionKey;
  if (!key) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY is not set. It must be a 32-byte hex string (64 characters)."
    );
  }
  if (key.length !== 64) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes). Got ${key.length}.`
    );
  }
  return Buffer.from(key, "hex");
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns hex string: iv + authTag + ciphertext
 */
export function encryptToken(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  // Concatenate: iv (16) + tag (16) + ciphertext
  const result = Buffer.concat([iv, tag, encrypted]);
  return result.toString("hex");
}

/**
 * Decrypt a hex string produced by encryptToken.
 */
export function decryptToken(encryptedHex: string): string {
  const key = getKey();
  const data = Buffer.from(encryptedHex, "hex");

  if (data.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error("Invalid encrypted token: data too short");
  }

  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

/**
 * Validate encryption is available. Call at startup.
 */
export function validateEncryption(): void {
  try {
    getKey();
    const test = "test";
    const encrypted = encryptToken(test);
    const decrypted = decryptToken(encrypted);
    if (decrypted !== test) {
      throw new Error("Encryption self-test failed");
    }
  } catch (err: any) {
    throw new Error(`Token encryption validation failed: ${err.message}`);
  }
}
