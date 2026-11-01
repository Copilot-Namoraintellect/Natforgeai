/**
 * Backup payload encryption: AES-256-GCM with a scrypt-derived key.
 *
 * File format (binary):
 *   magic  "NFBK1" (5 bytes)
 *   salt   16 bytes (scrypt salt, unique per file)
 *   iv     12 bytes (GCM nonce)
 *   ciphertext || 16-byte GCM auth tag
 *
 * The passphrase is supplied by the caller (backup job environment via the
 * secret store). It is never persisted, never logged, never written into
 * the encrypted file.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { promises as fs } from "node:fs";

const MAGIC = Buffer.from("NFBK1", "ascii");
const SALT_LEN = 16;
const IV_LEN = 12;
const KEY_LEN = 32;

export const ENCRYPTED_EXTENSION = ".enc";

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN);
}

export function encryptBuffer(plain: Buffer, passphrase: string): Buffer {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, salt, iv, body, tag]);
}

export function decryptBuffer(payload: Buffer, passphrase: string): Buffer {
  if (payload.length < MAGIC.length + SALT_LEN + IV_LEN + 16) {
    throw new Error("ENCRYPTED_PAYLOAD_TOO_SHORT");
  }
  if (!payload.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("ENCRYPTED_MAGIC_MISMATCH");
  }
  const salt = payload.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
  const iv = payload.subarray(MAGIC.length + SALT_LEN, MAGIC.length + SALT_LEN + IV_LEN);
  const body = payload.subarray(MAGIC.length + SALT_LEN + IV_LEN, payload.length - 16);
  const tag = payload.subarray(payload.length - 16);
  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

export async function encryptFile(src: string, dest: string, passphrase: string): Promise<void> {
  const plain = await fs.readFile(src);
  await fs.writeFile(dest, encryptBuffer(plain, passphrase));
}

export async function decryptFile(src: string, dest: string, passphrase: string): Promise<void> {
  const payload = await fs.readFile(src);
  await fs.writeFile(dest, decryptBuffer(payload, passphrase));
}

/** True when a filename carries the encrypted extension. */
export function isEncryptedName(name: string): boolean {
  return name.endsWith(ENCRYPTED_EXTENSION);
}
