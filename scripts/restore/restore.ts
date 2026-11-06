/**
 * R10-G restore harness CLI.
 *
 *   tsx scripts/restore/restore.ts run \
 *     --set /backups/natforge/set-…Z --to /tmp/recovery/set [--passphrase-env BACKUP_PASSPHRASE]
 *       → manifest re-verify → decrypt → extract payloads + config + release
 *         manifest into the restore area. No database is touched.
 *
 *   tsx scripts/restore/restore.ts gather --db-url mysql://… [--sample 20] [--lease-seconds 3600]
 *       → read-only fact gathering from a RECOVERY database instance.
 *
 *   tsx scripts/restore/restore.ts verify --facts facts.json [--expected expected.json]
 *       → pure G7 integrity assessment; exit 0 only on INTEGRITY_PASS.
 *
 * Production guard: gather/apply refuse a --db-url whose host equals
 * PRODUCTION_DB_HOST unless DISASTER_RECOVERY=1 is set (declared event).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { MANIFEST_FILENAME, parseManifest, verifyManifest } from "../backup/lib/manifest";
import { decryptFile, decryptBuffer, isEncryptedName, ENCRYPTED_EXTENSION } from "../backup/lib/encrypt";
import { assessIntegrity, TIER_A_TABLES, type RecoveryFacts } from "./lib/integrity";

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

/** G6 guard: never point the restore at the production DB by accident. */
export function assertRestoreTargetAllowed(dbUrl: string): void {
  const prodHost = process.env.PRODUCTION_DB_HOST;
  if (!prodHost) return; // guard disabled in dev/rehearsal environments
  let host = "";
  try {
    const u = new URL(dbUrl);
    host = u.hostname;
  } catch {
    console.error("ERROR: --db-url is not a valid URL");
    process.exit(2);
  }
  if (host === prodHost && process.env.DISASTER_RECOVERY !== "1") {
    console.error(
      "ERROR: restore target matches PRODUCTION_DB_HOST and DISASTER_RECOVERY != 1.\n" +
        "Refusing. This harness only restores into disposable recovery environments.",
    );
    process.exit(3);
  }
}

async function cmdRun(args: string[]): Promise<void> {
  const setDir = arg("--set", args);
  const to = arg("--to", args);
  if (!setDir || !to) {
    console.error("ERROR: run requires --set and --to");
    process.exit(2);
  }
  const passphrase = passphraseFromEnv(arg("--passphrase-env", args));

  const manifest = parseManifest(await fs.readFile(path.join(setDir, MANIFEST_FILENAME), "utf8"));
  const check = await verifyManifest(setDir, manifest);
  if (!check.ok) {
    console.error(`ERROR: set fails manifest verification: ${JSON.stringify(check)}`);
    process.exit(1);
  }

  await fs.mkdir(to, { recursive: true });
  let files = 0;
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
    files += 1;
  }
  console.log(JSON.stringify({ restoredTo: to, set: path.basename(setDir), files, manifestOk: true }, null, 2));
}

const CORE_TABLES = [
  "users",
  "businesses",
  "campaigns",
  "leads",
  "content_posts",
  "schedules",
  "payments",
  "subscriptions",
  "audit_events",
];

const IDENTITY_SAMPLE_SPECS: { table: string; column: string; prefix: string }[] = [
  { table: "mission_proposals", column: "missionId", prefix: "mis1:" },
  { table: "execution_actions", column: "executionActionId", prefix: "exa1:" },
  { table: "business_outcomes", column: "outcomeId", prefix: "out1:" },
  { table: "mission_governance_decisions", column: "governanceDecisionId", prefix: "mgd1:" },
];

async function cmdGather(args: string[]): Promise<void> {
  const dbUrl = arg("--db-url", args) ?? process.env.RESTORE_DATABASE_URL;
  if (!dbUrl) {
    console.error("ERROR: gather requires --db-url or RESTORE_DATABASE_URL");
    process.exit(2);
  }
  assertRestoreTargetAllowed(dbUrl);
  const sampleSize = Number(arg("--sample", args) ?? "20");
  const leaseSeconds = Number(arg("--lease-seconds", args) ?? "3600");

  const mysql = (await import("mysql2/promise")).default;
  const conn = await mysql.createConnection(dbUrl);
  try {
    const [dbRows] = await conn.query("SELECT DATABASE() AS db");
    const dbName = (dbRows as { db: string }[])[0].db;

    const [trows] = await conn.query(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?",
      [dbName],
    );
    const presentTables = (trows as { TABLE_NAME: string }[]).map((r) => r.TABLE_NAME);
    const present = new Set(presentTables);
    const missingTables = [...TIER_A_TABLES, ...CORE_TABLES].filter((t) => !present.has(t));

    const tierACounts: Record<string, number> = {};
    for (const t of TIER_A_TABLES) {
      if (!present.has(t)) continue;
      const [rows] = await conn.query(`SELECT COUNT(*) AS c FROM \`${t}\``);
      tierACounts[t] = Number((rows as { c: number }[])[0].c);
    }

    const [aCount] = await conn.query("SELECT COUNT(*) AS c, COALESCE(MAX(id)-MIN(id)+1-COUNT(*),0) AS gaps FROM audit_events");
    const auditRow = (aCount as { c: number; gaps: number }[])[0];
    const [dupRows] = await conn.query(
      "SELECT COUNT(*) AS c FROM (SELECT eventFingerprint FROM audit_events GROUP BY eventFingerprint HAVING COUNT(*) > 1) d",
    );

    const identities: RecoveryFacts["identities"] = [];
    for (const spec of IDENTITY_SAMPLE_SPECS) {
      if (!present.has(spec.table)) continue;
      const [rows] = await conn.query(
        `SELECT \`${spec.column}\` AS v FROM \`${spec.table}\` ORDER BY RAND() LIMIT ?`,
        [sampleSize],
      );
      const vals = rows as { v: string }[];
      const re = new RegExp(`^${spec.prefix.replace(":", "\\:")}[0-9a-f]{64}$`);
      identities.push({
        table: spec.table,
        prefix: spec.prefix,
        sampled: vals.length,
        valid: vals.filter((r) => re.test(r.v ?? "")).length,
      });
    }

    const [execRows] = await conn.query("SELECT COUNT(*) AS c FROM execution_actions");
    const [attemptRows] = await conn.query("SELECT COUNT(*) AS c FROM execution_attempts");
    const [dupSucc] = await conn.query(
      "SELECT COUNT(*) AS c FROM (SELECT executionActionId FROM execution_attempts WHERE resultStatus = 'SUCCEEDED' GROUP BY executionActionId HAVING COUNT(*) > 1) d",
    );
    const [uncRows] = await conn.query(
      "SELECT COUNT(*) AS c FROM execution_attempts WHERE resultStatus IN ('UNCERTAIN','PENDING_EXTERNAL')",
    );

    let staleActiveClaims = 0;
    if (present.has("queue_replay_active_claims")) {
      const [claimRows] = await conn.query(
        "SELECT COUNT(*) AS c FROM queue_replay_active_claims WHERE createdAt < (NOW() - INTERVAL ? SECOND)",
        [leaseSeconds],
      );
      staleActiveClaims = Number((claimRows as { c: number }[])[0].c);
    }

    // Migration identity: the restored schema must carry the pinned release's
    // newest tables (0037 migration applied ⇒ R9 tables exist).
    let expectedLatestTag = "unknown";
    try {
      const journal = JSON.parse(await fs.readFile(path.resolve("db/migrations/meta/_journal.json"), "utf8")) as {
        entries: { tag: string }[];
      };
      expectedLatestTag = journal.entries[journal.entries.length - 1]?.tag ?? "unknown";
    } catch {
      /* journal unavailable — tag stays unknown, schema check still runs */
    }

    const facts: RecoveryFacts = {
      presentTables,
      missingTables,
      tableCount: presentTables.length,
      migration: {
        expectedLatestTag,
        schemaMatchesRelease: missingTables.length === 0,
      },
      tierACounts,
      audit: {
        count: Number(auditRow.c),
        fingerprintDuplicates: Number((dupRows as { c: number }[])[0].c),
        idGaps: Number(auditRow.gaps),
      },
      execution: {
        actions: Number((execRows as { c: number }[])[0].c),
        attempts: Number((attemptRows as { c: number }[])[0].c),
        succeededDuplicateActions: Number((dupSucc as { c: number }[])[0].c),
        uncertainPreserved: Number((uncRows as { c: number }[])[0].c),
        uncertainExpected: -1, // caller must supply pre-restore truth via --expected
      },
      identities,
      staleActiveClaims,
    };
    console.log(JSON.stringify(facts, null, 2));
  } finally {
    await conn.end();
  }
}

async function cmdVerify(args: string[]): Promise<void> {
  const factsPath = arg("--facts", args);
  if (!factsPath) {
    console.error("ERROR: verify requires --facts");
    process.exit(2);
  }
  const facts = JSON.parse(await fs.readFile(factsPath, "utf8")) as RecoveryFacts;
  const expectedPath = arg("--expected", args);
  if (expectedPath) {
    facts.expectedCounts = JSON.parse(await fs.readFile(expectedPath, "utf8")) as Record<string, number>;
    if (facts.expectedCounts.audit_events !== undefined) {
      facts.audit.expectedCount = facts.expectedCounts.audit_events;
    }
  }
  if (arg("--uncertain-expected", args)) {
    facts.execution.uncertainExpected = Number(arg("--uncertain-expected", args));
  }
  const report = assessIntegrity(facts);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.verdict === "INTEGRITY_PASS" ? 0 : 1);
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "run": await cmdRun(rest); break;
  case "gather": await cmdGather(rest); break;
  case "verify": await cmdVerify(rest); break;
  default:
    console.error("usage: restore.ts run|gather|verify …");
    process.exit(2);
}
