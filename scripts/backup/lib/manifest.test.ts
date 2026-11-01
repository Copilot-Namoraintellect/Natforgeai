import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildManifest, parseManifest, serializeManifest, verifyManifest, MANIFEST_FILENAME } from "./manifest";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "nfbk-manifest-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("manifest", () => {
  it("builds a deterministic sorted manifest excluding itself", async () => {
    await mkdir(path.join(dir, "db"));
    await writeFile(path.join(dir, "db", "dump.sql.enc"), Buffer.from("cipher"));
    await writeFile(path.join(dir, "release-manifest.json"), Buffer.from("{}"));
    await writeFile(path.join(dir, MANIFEST_FILENAME), "legacy  MANIFEST.sha256\n");
    const m1 = await buildManifest(dir);
    const m2 = await buildManifest(dir);
    expect(m1.map((e) => e.path)).toEqual(["db/dump.sql.enc", "release-manifest.json"]);
    expect(serializeManifest(m1)).toBe(serializeManifest(m2));
    expect(m1.every((e) => e.sha256.length === 64 && e.size > 0)).toBe(true);
  });

  it("verifies a clean set and round-trips through parse/serialize", async () => {
    await writeFile(path.join(dir, "a.txt"), "hello");
    const entries = await buildManifest(dir);
    await writeFile(path.join(dir, MANIFEST_FILENAME), serializeManifest(entries));
    const parsed = parseManifest(await readFile(path.join(dir, MANIFEST_FILENAME), "utf8"));
    const check = await verifyManifest(dir, parsed);
    expect(check.ok).toBe(true);
    expect(check.entriesChecked).toBe(1);
  });

  it("detects tampering (hash), size drift, missing and extra files", async () => {
    await writeFile(path.join(dir, "a.txt"), "hello");
    await mkdir(path.join(dir, "sub"));
    await writeFile(path.join(dir, "sub", "b.txt"), "world");
    const entries = await buildManifest(dir);
    await writeFile(path.join(dir, MANIFEST_FILENAME), serializeManifest(entries));

    await writeFile(path.join(dir, "a.txt"), "HELLO"); // hash mismatch
    await writeFile(path.join(dir, "sub", "b.txt"), "longer than before"); // size mismatch
    await rm(path.join(dir, "a.txt")); // also missing
    await writeFile(path.join(dir, "extra.txt"), "new"); // extra

    const parsed = parseManifest(await readFile(path.join(dir, MANIFEST_FILENAME), "utf8"));
    const check = await verifyManifest(dir, parsed);
    expect(check.ok).toBe(false);
    expect(check.hashMismatch).toEqual(["sub/b.txt"]);
    expect(check.sizeMismatch).toEqual([]);
    expect(check.missing).toEqual(["a.txt"]);
    expect(check.extra).toEqual(["extra.txt"]);
  });

  it("rejects malformed manifest lines", () => {
    expect(() => parseManifest("not-a-hash  file\n")).toThrow(/MANIFEST_MALFORMED_LINE/);
  });
});
