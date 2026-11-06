import { describe, expect, it } from "vitest";
import { scanText, scanBuffer } from "./secret-scan";

describe("secret-scan", () => {
  it("passes clean operational content", () => {
    const clean = [
      "CREATE TABLE `missions` (`id` bigint NOT NULL);",
      "APP_SECRET=", // empty assignment — no value, no finding
      "DATABASE_URL=mysql://user@localhost:3306/app", // no password in userinfo
      "ENABLE_PREMIUM_VIDEO=false",
      "set-20261114T020000Z",
    ].join("\n");
    const r = scanText(clean, "dump.sql");
    expect(r.clean).toBe(true);
    expect(r.findings).toEqual([]);
  });

  it("flags AWS access keys", () => {
    const r = scanText("key = AKIAIOSFODNN7EXAMPLE", "f.txt");
    expect(r.clean).toBe(false);
    expect(r.findings[0].pattern).toBe("f.txt:AWS_ACCESS_KEY_ID");
  });

  it("flags private key blocks", () => {
    const r = scanText("-----BEGIN RSA PRIVATE KEY-----\nMII…", "f.txt");
    expect(r.findings.some((f) => f.pattern.includes("PRIVATE_KEY_BLOCK"))).toBe(true);
  });

  it("flags MySQL DSNs containing passwords", () => {
    const r = scanText("DATABASE_URL=mysql://app:S3cret@db.internal:3306/natforge", "f.txt");
    expect(r.findings.some((f) => f.pattern.includes("MYSQL_DSN_WITH_PASSWORD"))).toBe(true);
  });

  it("flags secret env assignments and masks the value in the excerpt", () => {
    const r = scanText("APP_SECRET=supersecretvalue123456", "env.txt");
    const f = r.findings.find((x) => x.pattern.includes("ENV_SECRET_ASSIGNMENT"));
    expect(f).toBeDefined();
    expect(f!.excerpt).not.toContain("supersecretvalue");
    expect(f!.excerpt).toContain("********");
  });

  it("flags OpenAI-style keys and JWTs", () => {
    expect(scanText("OPENAI_API_KEY=sk-abcdefghij0123456789ABCDEFGHIJ", "e").findings.some((f) => f.pattern.includes("OPENAI_API_KEY"))).toBe(true);
    expect(scanText("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghabcdefghabcdefgh", "e").findings.some((f) => f.pattern.includes("JWT_BEARER"))).toBe(true);
  });

  it("scans binary buffers without crashing", () => {
    const buf = Buffer.from("-----BEGIN OPENSSH PRIVATE KEY-----\x00\x01\x02", "binary");
    const r = scanBuffer(buf, "key.bin");
    expect(r.clean).toBe(false);
  });

  it("reports source labels on findings", () => {
    const r = scanText("MYSQL_PASSWORD=hunter2", "cfg.txt");
    expect(r.findings[0].pattern.startsWith("cfg.txt:")).toBe(true);
  });
});
