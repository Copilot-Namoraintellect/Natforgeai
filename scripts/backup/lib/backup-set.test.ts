import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assembleBackupSet } from "./backup-set";
import { parseManifest, verifyManifest } from "./manifest";
import { decryptBuffer } from "./encrypt";

const PASS = "rehearsal-passphrase-not-a-real-secret";

function syntheticDump(tableCount = 3): string {
  const tables = ["users", "audit_events", "mission_proposals"];
  let sql = "-- MySQL dump synthetic fixture\n";
  for (let i = 0; i < tableCount; i++) {
    sql += `DROP TABLE IF EXISTS \`${tables[i]}\`;\nCREATE TABLE \`${tables[i]}\` (\`id\` int);\n`;
  }
  sql += "-- Dump completed on 2026-11-14  2:00:00\n";
  return sql;
}

let root: string;
let staging: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "nfbk-set-"));
  staging = await mkdtemp(path.join(tmpdir(), "nfbk-stage-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(staging, { recursive: true, force: true });
});

describe("assembleBackupSet", () => {
  it("assembles a verified encrypted set with redacted config", async () => {
    const dump = path.join(staging, "dump.sql");
    await writeFile(dump, syntheticDump(3));
    const assets = path.join(staging, "assets.tar");
    await writeFile(assets, Buffer.from("tar-bytes"));

    const result = await assembleBackupSet({
      dumpPath: dump,
      assetTarPath: assets,
      envContent: "APP_SECRET=shh\nENABLE_X=true\n",
      outRoot: root,
      passphrase: PASS,
      release: { gitSha: "abc123", branch: "feature/r10-g-backup-dr", dirty: false },
      database: { hostRole: "recovery-sim", name: "natforge", tableCount: 3 },
      now: new Date("2026-11-14T02:00:00Z"),
    });

    expect(result.status).toBe("SUCCESS");
    expect(result.setId).toBe("set-20261114T020000Z");
    expect(result.verification.manifestOk).toBe(true);
    expect(result.verification.decryptRoundTripOk).toBe(true);
    expect(result.verification.dumpSanityOk).toBe(true);
    expect(result.source.database.dumpBytes).toBe(Buffer.byteLength(syntheticDump(3)));

    const setDir = path.join(root, result.setId);
    const names = await readdir(setDir);
    expect(names).toContain("MANIFEST.sha256");
    expect(names).toContain("backup-run.json");
    expect(names).not.toContain("set-20261114T020000Z.partial");

    // Encrypted payloads present, plaintext dump absent.
    const dbFiles = await readdir(path.join(setDir, "db"));
    expect(dbFiles).toEqual(["dump.sql.enc"]);

    // Config inventory redacted.
    const inv = JSON.parse(await readFile(path.join(setDir, "config", "env-inventory.redacted.json"), "utf8"));
    expect(inv.entries.find((e: { key: string }) => e.key === "APP_SECRET").value).toBe("<redacted>");

    // Manifest re-verifies independently; decrypting yields the original dump.
    const entries = parseManifest(await readFile(path.join(setDir, "MANIFEST.sha256"), "utf8"));
    expect((await verifyManifest(setDir, entries)).ok).toBe(true);
    const enc = await readFile(path.join(setDir, "db", "dump.sql.enc"));
    expect(decryptBuffer(enc, PASS).toString("utf8")).toContain("Dump completed");

    // Plaintext never lingers in staging-adjacent set dir: no file contains the secret.
    for (const rel of ["backup-run.json", "release-manifest.json"]) {
      const txt = await readFile(path.join(setDir, rel), "utf8");
      expect(txt.includes("shh")).toBe(false);
    }
  });

  it("fails closed and quarantines when the dump is not a sane mysqldump", async () => {
    const dump = path.join(staging, "dump.sql");
    await writeFile(dump, "garbage content, no footer");
    await expect(
      assembleBackupSet({
        dumpPath: dump,
        outRoot: root,
        passphrase: PASS,
        release: { gitSha: "x", branch: "y", dirty: false },
      }),
    ).rejects.toThrow(/DUMP_SANITY_FAILED/);
    const names = await readdir(root);
    expect(names.some((n) => n.endsWith(".partial"))).toBe(true);
    expect(names.some((n) => n.startsWith("set-") && !n.endsWith(".partial"))).toBe(false);
  });

  it("fails closed when a secret survives into a captured payload", async () => {
    const dump = path.join(staging, "dump.sql");
    // A leaked DSN row inside the dump text (simulated operator error).
    await writeFile(dump, syntheticDump(3) + "INSERT INTO notes VALUES ('mysql://u:leaked@h/db');\n");
    await expect(
      assembleBackupSet({
        dumpPath: dump,
        outRoot: root,
        passphrase: PASS,
        release: { gitSha: "x", branch: "y", dirty: false },
      }),
    ).rejects.toThrow(/SECRET_SCAN_HIT/);
  });

  it("fails closed when the dump file is missing", async () => {
    await expect(
      assembleBackupSet({
        dumpPath: path.join(staging, "nope.sql"),
        outRoot: root,
        passphrase: PASS,
        release: { gitSha: "x", branch: "y", dirty: false },
      }),
    ).rejects.toThrow();
  });

  it("detects table-count drift against the manifest expectation", async () => {
    const dump = path.join(staging, "dump.sql");
    await writeFile(dump, syntheticDump(3));
    await expect(
      assembleBackupSet({
        dumpPath: dump,
        outRoot: root,
        passphrase: PASS,
        release: { gitSha: "x", branch: "y", dirty: false },
        database: { hostRole: "r", name: "d", tableCount: 118 },
      }),
    ).rejects.toThrow(/DUMP_SANITY_FAILED/);
  });
});
