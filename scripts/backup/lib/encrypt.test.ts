import { describe, expect, it } from "vitest";
import { encryptBuffer, decryptBuffer, ENCRYPTED_EXTENSION, isEncryptedName } from "./encrypt";

const PASS = "correct horse battery staple";

describe("encrypt (AES-256-GCM + scrypt)", () => {
  it("round-trips arbitrary bytes", () => {
    const plain = Buffer.from("CREATE TABLE missions (…);\n" + "x".repeat(4096));
    const enc = encryptBuffer(plain, PASS);
    expect(enc.subarray(0, 5).toString("ascii")).toBe("NFBK1");
    expect(decryptBuffer(enc, PASS).equals(plain)).toBe(true);
  });

  it("produces distinct ciphertext per call (random salt+iv)", () => {
    const a = encryptBuffer(Buffer.from("same"), PASS);
    const b = encryptBuffer(Buffer.from("same"), PASS);
    expect(a.equals(b)).toBe(false);
  });

  it("fails closed on wrong passphrase", () => {
    const enc = encryptBuffer(Buffer.from("payload"), PASS);
    expect(() => decryptBuffer(enc, "wrong passphrase")).toThrow();
  });

  it("fails closed on tampered ciphertext or tag", () => {
    const enc = encryptBuffer(Buffer.from("payload"), PASS);
    const tampered = Buffer.from(enc);
    tampered[tampered.length - 1] ^= 0xff; // auth tag
    expect(() => decryptBuffer(tampered, PASS)).toThrow();
    const flipped = Buffer.from(enc);
    flipped[25] ^= 0x01; // body
    expect(() => decryptBuffer(flipped, PASS)).toThrow();
  });

  it("rejects truncated payloads and wrong magic", () => {
    expect(() => decryptBuffer(Buffer.from("short"), PASS)).toThrow(/TOO_SHORT/);
    const enc = encryptBuffer(Buffer.from("payload"), PASS);
    enc[0] = 0x58; // 'X'
    expect(() => decryptBuffer(enc, PASS)).toThrow(/MAGIC/);
  });

  it("name helpers recognise the encrypted extension", () => {
    expect(isEncryptedName("db/dump.sql.enc")).toBe(true);
    expect(isEncryptedName("release-manifest.json")).toBe(false);
    expect(ENCRYPTED_EXTENSION).toBe(".enc");
  });
});
