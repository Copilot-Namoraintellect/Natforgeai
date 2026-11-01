/**
 * Backup-set assembly: takes the night's captures (DB dump, redacted config
 * inventory, asset tar, release manifest) and produces a verified,
 * encrypted, manifest-bound backup set plus its `backup-run.json`.
 *
 * Fail-closed: any stage failure (missing input, secret-scan hit, encrypt
 * error, manifest mismatch) marks the set FAILED and leaves it quarantined
 * under `<setId>.partial/` — never reported as SUCCESS.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  MANIFEST_FILENAME,
  buildManifest,
  serializeManifest,
  verifyManifest,
  type ManifestEntry,
} from "./manifest";
import { encryptFile, decryptBuffer, isEncryptedName } from "./encrypt";
import { scanBuffer, type SecretScanResult } from "./secret-scan";
import { redactEnv } from "./redact-env";
import { runId, setId } from "./naming";

export interface ReleaseInfo {
  gitSha: string;
  branch: string;
  dirty: boolean;
  buildId?: string;
  nodeVersion?: string;
}

export interface BackupInputs {
  /** Path to the (unencrypted) mysqldump output. */
  dumpPath: string;
  /** Path to the asset tar (data/public + static uploads). */
  assetTarPath?: string;
  /** Raw .env content to redact into the inventory (content, not path —
   *  the caller reads the file so this module never touches secrets on disk). */
  envContent?: string;
  release: ReleaseInfo;
  outRoot: string;
  passphrase: string;
  database?: { hostRole: string; name: string; tableCount?: number };
  now?: Date;
}

export interface BackupRunResult {
  schemaVersion: 1;
  runId: string;
  setId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: "SUCCESS" | "FAILED" | "PARTIAL";
  failureStage: "dump" | "config" | "assets" | "manifest" | "scan" | "encrypt" | "verify" | "offsite" | null;
  source: {
    database: { hostRole: string; name: string; tableCount: number | null; dumpBytes: number; dumpSha256: string };
    config: { filesCaptured: number; redacted: boolean; scanClean: boolean };
    assets: { tarBytes: number | null; tarSha256: string | null; fileCount: null };
    release: ReleaseInfo;
  };
  verification: {
    manifestOk: boolean;
    rehashMismatches: number;
    decryptRoundTripOk: boolean;
    dumpSanityOk: boolean;
    verifiedAt: string;
  };
  secretScan: SecretScanResult;
  offsite: { pushed: boolean; ackAt: string | null };
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function copyEncrypted(src: string, destDir: string, name: string, passphrase: string): Promise<{ bytes: number; sha256: string }> {
  const raw = await fs.readFile(src);
  const encPath = path.join(destDir, `${name}.enc`);
  await encryptFile(src, encPath, passphrase);
  const enc = await fs.readFile(encPath);
  await fs.rm(src, { force: true });
  return { bytes: raw.length, sha256: sha256Hex(raw) };
}

function dumpLooksSane(sql: string, tableCount: number | null): boolean {
  if (!/^\s*(--|\/\*|DROP|CREATE|INSERT|SET|LOCK|UNLOCK|DELIMITER)/m.test(sql)) return false;
  if (!/Dump completed/.test(sql)) return false;
  const tables = new Set([...sql.matchAll(/^DROP TABLE IF EXISTS `([^`]+)`/gm)].map((m) => m[1]));
  if (tableCount !== null && tables.size > 0 && tables.size !== tableCount) return false;
  return true;
}

export async function assembleBackupSet(inputs: BackupInputs): Promise<BackupRunResult> {
  const started = inputs.now ?? new Date();
  const t0 = Date.now();
  const id = setId(started);
  const rid = runId(started);
  const workingDir = path.join(inputs.outRoot, `${id}.partial`);

  const result: BackupRunResult = {
    schemaVersion: 1,
    runId: rid,
    setId: id,
    startedAt: started.toISOString(),
    finishedAt: "",
    durationMs: 0,
    status: "FAILED",
    failureStage: null,
    source: {
      database: { hostRole: inputs.database?.hostRole ?? "unknown", name: inputs.database?.name ?? "unknown", tableCount: inputs.database?.tableCount ?? null, dumpBytes: 0, dumpSha256: "" },
      config: { filesCaptured: 0, redacted: true, scanClean: true },
      assets: { tarBytes: null, tarSha256: null, fileCount: null },
      release: inputs.release,
    },
    verification: { manifestOk: false, rehashMismatches: 0, decryptRoundTripOk: false, dumpSanityOk: false, verifiedAt: "" },
    secretScan: { clean: true, findings: [] },
    offsite: { pushed: false, ackAt: null },
  };

  const fail = async (stage: BackupRunResult["failureStage"], err: unknown) => {
    result.status = "FAILED";
    result.failureStage = stage;
    result.finishedAt = new Date().toISOString();
    result.durationMs = Date.now() - t0;
    await fs.mkdir(workingDir, { recursive: true }).catch(() => {});
    await fs.writeFile(path.join(workingDir, "backup-run.FAILED.json"), JSON.stringify(result, null, 2)).catch(() => {});
    throw err instanceof Error ? err : new Error(String(err));
  };

  try {
    await fs.mkdir(workingDir, { recursive: true });

    // 1. Database dump
    const dumpBuf = await fs.readFile(inputs.dumpPath).catch(async (e) => fail("dump", e));
    result.verification.dumpSanityOk = dumpLooksSane(dumpBuf.toString("utf8"), result.source.database.tableCount);
    if (!result.verification.dumpSanityOk) {
      await fail("dump", new Error("DUMP_SANITY_FAILED"));
    }
    const dumpScan = scanBuffer(dumpBuf, "db/dump.sql");
    if (!dumpScan.clean) {
      result.secretScan = dumpScan;
      await fail("scan", new Error("SECRET_SCAN_HIT: db/dump.sql"));
    }
    result.source.database.dumpBytes = dumpBuf.length;
    result.source.database.dumpSha256 = sha256Hex(dumpBuf);

    // 2. Config inventory (redacted) — scan the redacted output.
    if (inputs.envContent !== undefined) {
      const inventory = redactEnv(inputs.envContent);
      const invPath = path.join(workingDir, "config", "env-inventory.redacted.json");
      await fs.mkdir(path.dirname(invPath), { recursive: true });
      const invBuf = Buffer.from(JSON.stringify(inventory, null, 2));
      const invScan = scanBuffer(invBuf, "config/env-inventory.redacted.json");
      if (!invScan.clean) {
        result.secretScan = invScan;
        result.source.config.scanClean = false;
        await fail("scan", new Error("SECRET_SCAN_HIT: config inventory"));
      }
      await fs.writeFile(invPath, invBuf);
      result.source.config.filesCaptured += 1;
    }

    // 3. Assets
    if (inputs.assetTarPath) {
      const tarBuf = await fs.readFile(inputs.assetTarPath).catch(async (e) => fail("assets", e));
      const tarScan = scanBuffer(tarBuf, "assets/data-public.tar");
      if (!tarScan.clean) {
        result.secretScan = tarScan;
        await fail("scan", new Error("SECRET_SCAN_HIT: assets/data-public.tar"));
      }
      result.source.assets.tarBytes = tarBuf.length;
      result.source.assets.tarSha256 = sha256Hex(tarBuf);
    }

    // 4. Encrypt payloads (dump + asset tar). Manifest/config/release stay
    //    plaintext-small: hashes and redacted inventory are not sensitive.
    const dumpDest = path.join(workingDir, "db", "dump.sql");
    await fs.mkdir(path.dirname(dumpDest), { recursive: true });
    await fs.writeFile(dumpDest, dumpBuf);
    await encryptFile(dumpDest, `${dumpDest}.enc`, inputs.passphrase);
    await fs.rm(dumpDest);
    if (inputs.assetTarPath) {
      const assetsDest = path.join(workingDir, "assets", "data-public.tar");
      await fs.mkdir(path.dirname(assetsDest), { recursive: true });
      await fs.copyFile(inputs.assetTarPath, assetsDest);
      await encryptFile(assetsDest, `${assetsDest}.enc`, inputs.passphrase);
      await fs.rm(assetsDest);
    }

    // 5. Release manifest
    const relPath = path.join(workingDir, "release-manifest.json");
    await fs.writeFile(relPath, JSON.stringify({ generatedBy: "r10-g-capture-release", schemaVersion: 1, capturedAt: started.toISOString(), ...inputs.release }, null, 2));

    // 6. Whole-set secret scan (defence in depth — should be clean by construction)
    const all = await collectFiles(workingDir);
    for (const rel of all) {
      if (isEncryptedName(rel)) continue; // ciphertext is not scannable; plaintext inputs were scanned
      const buf = await fs.readFile(path.join(workingDir, ...rel.split("/")));
      const scan = scanBuffer(buf, rel);
      if (!scan.clean) {
        result.secretScan = scan;
        await fail("scan", new Error(`SECRET_SCAN_HIT: ${rel}`));
      }
    }

    // 7. Manifest + self-verify. backup-run.json is part of the set and
    //    covered by the manifest, so the run record reaches FINAL form
    //    first; the manifest is then built over the complete set.
    const firstEntries: ManifestEntry[] = await buildManifest(workingDir).catch(async (e) => fail("manifest", e));
    const firstCheck = await verifyManifest(workingDir, firstEntries);
    result.verification.manifestOk = firstCheck.ok;
    result.verification.rehashMismatches = firstCheck.hashMismatch.length + firstCheck.sizeMismatch.length;
    if (!firstCheck.ok) await fail("manifest", new Error("MANIFEST_SELF_VERIFY_FAILED"));

    // 8. Decrypt round-trip on the dump (proves the passphrase works today)
    const encDump = await fs.readFile(path.join(workingDir, "db", "dump.sql.enc"));
    const round = decryptBuffer(encDump, inputs.passphrase).toString("utf8");
    result.verification.decryptRoundTripOk = round.length === result.source.database.dumpBytes;
    if (!result.verification.decryptRoundTripOk) await fail("verify", new Error("DECRYPT_ROUNDTRIP_FAILED"));

    // 9. Final run record, then manifest over the complete set.
    result.status = "SUCCESS";
    result.finishedAt = new Date().toISOString();
    result.durationMs = Date.now() - t0;
    result.verification.verifiedAt = result.finishedAt;
    await fs.writeFile(path.join(workingDir, "backup-run.json"), JSON.stringify(result, null, 2));
    const entries: ManifestEntry[] = await buildManifest(workingDir).catch(async (e) => fail("manifest", e));
    await fs.writeFile(path.join(workingDir, MANIFEST_FILENAME), serializeManifest(entries));
    const finalCheck = await verifyManifest(workingDir, entries);
    if (!finalCheck.ok) await fail("manifest", new Error("MANIFEST_SELF_VERIFY_FAILED"));

    // 10. Promote to final name — no further writes into the set.
    const finalDir = path.join(inputs.outRoot, id);
    await fs.rename(workingDir, finalDir);

    return result;
  } catch (err) {
    // `fail` already recorded; rethrow for the caller's alert path.
    if (result.finishedAt === "") {
      result.finishedAt = new Date().toISOString();
      result.durationMs = Date.now() - t0;
    }
    throw err;
  }
}

async function collectFiles(root: string, base = root, out: string[] = []): Promise<string[]> {
  for (const e of await fs.readdir(root, { withFileTypes: true })) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) await collectFiles(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}
