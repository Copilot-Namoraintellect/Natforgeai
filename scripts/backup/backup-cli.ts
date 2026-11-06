/**
 * Backup harness CLI (R10-G). Entry point for the shell wrappers; also
 * runnable directly in a recovery/dev environment.
 *
 *   tsx scripts/backup/backup-cli.ts create \
 *     --dump /tmp/night/dump.sql --assets /tmp/night/assets.tar \
 *     --env-file /var/www/app/.env --out /var/backups/natforge \
 *     --passphrase-env BACKUP_PASSPHRASE --db-name natforge --host-role production
 *
 *   tsx scripts/backup/backup-cli.ts verify --set /var/backups/natforge/set-...Z
 *   tsx scripts/backup/backup-cli.ts prune --root /var/backups/natforge [--apply]
 *   tsx scripts/backup/backup-cli.ts decrypt --set <set> --to /tmp/restore [--include-db]
 *
 * Credentials policy: the passphrase is read ONLY from the environment
 * variable named by --passphrase-env (default BACKUP_PASSPHRASE). The dump
 * is produced by backup-database.sh, never by this CLI.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { MANIFEST_FILENAME, parseManifest, verifyManifest } from "./lib/manifest";
import { decryptFile, decryptBuffer, isEncryptedName, ENCRYPTED_EXTENSION } from "./lib/encrypt";
import { prunePlan, DEFAULT_RETENTION, type RetentionCandidate } from "./lib/retention";
import { assembleBackupSet } from "./lib/backup-set";
import { isValidSetId, setIdToDate } from "./lib/naming";

function arg(name: string, args: string[]): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function passphraseFromEnv(name: string | undefined): string {
  const envName = name ?? "BACKUP_PASSPHRASE";
  const v = process.env[envName];
  if (!v) {
    console.error(`ERROR: passphrase environment variable ${envName} is not set`);
    process.exit(2);
  }
  return v;
}

function releaseInfo(): { gitSha: string; branch: string; dirty: boolean; buildId?: string; nodeVersion: string } {
  let gitSha = "unknown";
  let branch = "unknown";
  let dirty = false;
  try {
    gitSha = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
    branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
    dirty = execSync("git status --porcelain", { encoding: "utf8" }).trim().length > 0;
  } catch {
    /* outside a git checkout — keep unknowns */
  }
  return { gitSha, branch, dirty, nodeVersion: process.version };
}

async function cmdCreate(args: string[]): Promise<void> {
  const dump = arg("--dump", args);
  const assets = arg("--assets", args);
  const envFile = arg("--env-file", args);
  const out = arg("--out", args);
  if (!dump || !out) {
    console.error("ERROR: create requires --dump and --out");
    process.exit(2);
  }
  let envContent: string | undefined;
  if (envFile) {
    envContent = await fs.readFile(envFile, "utf8");
  }
  const passphrase = passphraseFromEnv(arg("--passphrase-env", args));
  const tableCountRaw = arg("--table-count", args);
  const result = await assembleBackupSet({
    dumpPath: dump,
    assetTarPath: assets,
    envContent,
    outRoot: out,
    passphrase,
    release: releaseInfo(),
    database: {
      hostRole: arg("--host-role", args) ?? "unknown",
      name: arg("--db-name", args) ?? "unknown",
      tableCount: tableCountRaw !== undefined ? Number(tableCountRaw) : undefined,
    },
  });
  console.log(JSON.stringify({ status: result.status, setId: result.setId, runId: result.runId, durationMs: result.durationMs, verification: result.verification }, null, 2));
  if (result.status !== "SUCCESS") process.exit(1);
}

async function cmdVerify(args: string[]): Promise<void> {
  const setDir = arg("--set", args);
  if (!setDir) {
    console.error("ERROR: verify requires --set");
    process.exit(2);
  }
  const manifestPath = path.join(setDir, MANIFEST_FILENAME);
  const entries = parseManifest(await fs.readFile(manifestPath, "utf8"));
  const check = await verifyManifest(setDir, entries);
  const report: Record<string, unknown> = {
    set: path.basename(setDir),
    manifestOk: check.ok,
    entriesChecked: check.entriesChecked,
    missing: check.missing,
    extra: check.extra,
    hashMismatch: check.hashMismatch,
    sizeMismatch: check.sizeMismatch,
    decryptRoundTripOk: null as boolean | null,
  };
  const withDecrypt = args.includes("--decrypt");
  if (withDecrypt) {
    const passphrase = passphraseFromEnv(arg("--passphrase-env", args));
    const encFiles = entries.filter((e) => isEncryptedName(e.path));
    let ok = true;
    for (const e of encFiles) {
      try {
        const buf = await fs.readFile(path.join(setDir, ...e.path.split("/")));
        decryptBuffer(buf, passphrase);
      } catch {
        ok = false;
        break;
      }
    }
    report.decryptRoundTripOk = ok && encFiles.length > 0;
  }
  console.log(JSON.stringify(report, null, 2));
  if (!check.ok || report.decryptRoundTripOk === false) process.exit(1);
}

async function cmdPrune(args: string[]): Promise<void> {
  const root = arg("--root", args);
  if (!root) {
    console.error("ERROR: prune requires --root");
    process.exit(2);
  }
  const policy = {
    daily: Number(arg("--daily", args) ?? DEFAULT_RETENTION.daily),
    weekly: Number(arg("--weekly", args) ?? DEFAULT_RETENTION.weekly),
    monthly: Number(arg("--monthly", args) ?? DEFAULT_RETENTION.monthly),
  };
  const sets: RetentionCandidate[] = [];
  for (const name of await fs.readdir(root)) {
    if (!isValidSetId(name)) continue;
    const d = setIdToDate(name);
    if (d) sets.push({ id: name, createdAt: d });
  }
  const plan = prunePlan(sets, policy);
  const report = { policy, kept: plan.keep.length, pruned: plan.prune, keptSets: plan.keep, reasons: plan.reason };
  console.log(JSON.stringify(report, null, 2));
  if (args.includes("--apply")) {
    for (const id of plan.prune) {
      await fs.rm(path.join(root, id), { recursive: true, force: true });
      console.error(`pruned ${id}`);
    }
  }
}

async function cmdDecrypt(args: string[]): Promise<void> {
  const setDir = arg("--set", args);
  const to = arg("--to", args);
  if (!setDir || !to) {
    console.error("ERROR: decrypt requires --set and --to");
    process.exit(2);
  }
  const passphrase = passphraseFromEnv(arg("--passphrase-env", args));
  await fs.mkdir(to, { recursive: true });
  const manifest = parseManifest(await fs.readFile(path.join(setDir, MANIFEST_FILENAME), "utf8"));
  // Verify hashes BEFORE releasing anything into the restore area.
  const check = await verifyManifest(setDir, manifest);
  if (!check.ok) {
    console.error(`ERROR: set fails manifest verification: ${JSON.stringify(check)}`);
    process.exit(1);
  }
  let copied = 0;
  for (const e of manifest) {
    const src = path.join(setDir, ...e.path.split("/"));
    const relDest = isEncryptedName(e.path) ? e.path.slice(0, -ENCRYPTED_EXTENSION.length) : e.path;
    const dest = path.join(to, ...relDest.split("/"));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    if (isEncryptedName(e.path)) {
      await decryptFile(src, dest, passphrase);
    } else {
      await fs.copyFile(src, dest);
    }
    copied += 1;
  }
  console.log(JSON.stringify({ decryptedTo: to, files: copied, manifestOk: true }, null, 2));
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "create": await cmdCreate(rest); break;
  case "verify": await cmdVerify(rest); break;
  case "prune": await cmdPrune(rest); break;
  case "decrypt": await cmdDecrypt(rest); break;
  default:
    console.error("usage: backup-cli.ts create|verify|prune|decrypt …");
    process.exit(2);
}
