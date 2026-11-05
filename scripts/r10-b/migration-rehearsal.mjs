#!/usr/bin/env node
// ─── R10-B — Canonical Migration Rehearsal Harness (B3/B8) ───
//
// Repeatable rehearsal of the canonical migration chain against a FRESH,
// DISPOSABLE, NON-PRODUCTION MySQL database:
//
//   fresh disposable DB
//     → apply repository migrations in journal order (0000 … 0037)
//     → schema verification (Mission Control objects)
//     → data-integrity probes (unique anchors + CAS behaviour on canaries)
//
// Modes:
//   --static   No DB required. Verifies journal↔file chain integrity,
//              canonical-0037 authority markers, absence of retired
//              sibling 0037 provisionals, breakpoint integrity.
//   --live     Requires R10_B_REHEARSAL_URL (mysql://…). Fail-closed URL
//              guard: localhost/127.0.0.1/::1 hostnames ONLY, and the target
//              database name MUST start with `r10b_rehearsal_`. Creates a
//              fresh database, applies all migrations, verifies objects,
//              runs anchor/CAS probes, emits a JSON report, exits 0/1.
//
// HARD RULES: never executes against production; never reads DATABASE_URL;
// never mutates any database whose name does not start with r10b_rehearsal_.

import { createRequire } from "module";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const require = createRequire(import.meta.url);
const MIGRATIONS_DIR = path.resolve(process.cwd(), "db/migrations");
const JOURNAL_PATH = path.join(MIGRATIONS_DIR, "meta/_journal.json");

const MISSION_CONTROL_TABLES = [
  "mission_proposals",
  "mission_lifecycle_events",
  "mission_plans",
  "mission_plan_tasks",
  "mission_plan_lifecycle_events",
  "mission_task_plan_snapshots",
  "mission_dependency_edges",
  "mission_schedules",
  "mission_schedule_lifecycle_events",
  "execution_actions",
  "execution_attempts",
  "execution_lifecycle_events",
  "mission_state_records",
  "mission_task_states",
  "mission_recovery_candidates",
  "mission_operational_timeline_events",
  "mission_governance_decisions",
  "approval_requests",
];

// Durable unique anchors that MUST exist after 0037 (table → index names).
const EXPECTED_UNIQUE_INDEXES = {
  mission_proposals: ["mp_mission_identity_uidx", "mp_user_mission_uidx"],
  mission_plans: ["mplans_plan_identity_uidx", "mplans_user_plan_uidx", "mplans_user_mission_version_uidx"],
  mission_plan_tasks: ["mptasks_task_identity_uidx", "mptasks_user_task_uidx"],
  mission_task_plan_snapshots: ["mtps_plan_fingerprint_uidx", "mtps_coordinate_fingerprint_uidx"],
  mission_dependency_edges: ["mde_dependency_id_uidx", "mde_user_dependency_uidx", "mde_natural_key_uidx"],
  mission_schedules: ["msch_schedule_id_uidx", "msch_user_schedule_uidx"],
  execution_actions: ["exa_action_identity_uidx", "exa_user_action_uidx", "exa_user_idempotency_uidx"],
  execution_attempts: ["exr_attempt_identity_uidx", "exr_user_attempt_uidx", "exr_user_action_attempt_uidx"],
  execution_lifecycle_events: ["exl_lifecycle_identity_uidx"],
  mission_state_records: ["msr_state_identity_uidx", "msr_user_state_uidx"],
  mission_task_states: ["mts_state_identity_uidx", "mts_user_state_uidx"],
  mission_recovery_candidates: ["mrc_identity_uidx", "mrc_user_recovery_uidx"],
  mission_operational_timeline_events: ["mote_identity_uidx", "mote_user_timeline_uidx"],
  mission_governance_decisions: ["mgd_decision_id_idx"],
  approval_requests: ["approval_requests_idempotency_key_idx"],
  mission_lifecycle_events: ["mle_lifecycle_identity_uidx"],
  mission_plan_lifecycle_events: ["mpl_lifecycle_identity_uidx"],
  mission_schedule_lifecycle_events: ["msle_lifecycle_identity_uidx"],
};

// Tables the canonical 0037 migration itself must create (approval_requests
// is a pre-existing shared ledger from 0001_parallel_tinkerer — 0037 only
// extends its enum — so it is verified post-chain, not as a 0037 CREATE).
const TABLES_CREATED_BY_0037 = MISSION_CONTROL_TABLES.filter((t) => t !== "approval_requests");

const RETIRED_0037_PROVISIONALS = [
  "0037_r9_a_mission_authority_foundation",
  "0037_r9_b_mission_planning_foundation",
  "0037_r9_c_dependency_scheduling_foundation",
  "0037_r9_d_execution_coordination_foundation",
  "0037_r9_e_mission_state_recovery_foundation",
  "0037_r9_f_mission_governance_foundation",
];

const CANONICAL_0037 = "0037_r9_mission_control_foundation";
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const REQUIRED_DB_PREFIX = "r10b_rehearsal_";

function loadJournal() {
  return JSON.parse(fs.readFileSync(JOURNAL_PATH, "utf8"));
}

function sqlFilesOnDisk() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.replace(/\.sql$/, ""));
}

function splitStatements(sql) {
  return sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^(--[^\n]*\n?)+$/s.test(s.replace(/--> statement-breakpoint/g, "")) || /^\s*(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|SET)/m.test(s))
    .map((s) => {
      // strip pure comment lines, keep statements
      const lines = s.split("\n").filter((l) => !l.trim().startsWith("--"));
      return lines.join("\n").trim();
    })
    .filter((s) => s.length > 0);
}

// ─── Static verification (no DB) ───

function runStaticVerification() {
  const problems = [];
  const journal = loadJournal();
  const entries = journal.entries;
  const tags = entries.map((e) => e.tag);
  const files = sqlFilesOnDisk();
  const fileSet = new Set(files);

  // 1. Journal ↔ file chain integrity.
  if (entries.length !== files.length) {
    problems.push(`journal entries (${entries.length}) != sql files (${files.length})`);
  }
  for (const tag of tags) if (!fileSet.has(tag)) problems.push(`journal tag missing sql file: ${tag}`);
  for (const f of files) if (!tags.includes(f)) problems.push(`sql file missing from journal: ${f}`);
  const idxs = entries.map((e) => e.idx);
  if (new Set(idxs).size !== idxs.length) problems.push("duplicate journal idx values");

  // 2. Canonical 0037 authority markers.
  const last = entries[entries.length - 1];
  if (last.tag !== CANONICAL_0037) problems.push(`journal head is ${last.tag}, expected ${CANONICAL_0037}`);
  const canonicalSql = fs.readFileSync(path.join(MIGRATIONS_DIR, `${CANONICAL_0037}.sql`), "utf8");
  for (const table of TABLES_CREATED_BY_0037) {
    if (!canonicalSql.includes(`CREATE TABLE \`${table}\``)) {
      problems.push(`canonical 0037 does not create ${table}`);
    }
  }

  // 3. Retired sibling provisionals must not exist (in journal or on disk).
  for (const retired of RETIRED_0037_PROVISIONALS) {
    if (tags.includes(retired)) problems.push(`retired provisional present in journal: ${retired}`);
    if (fileSet.has(retired)) problems.push(`retired provisional present on disk: ${retired}`);
  }
  const archivedDir = path.join(MIGRATIONS_DIR, "archived");
  if (fs.existsSync(archivedDir)) {
    for (const retired of RETIRED_0037_PROVISIONALS) {
      if (fs.existsSync(path.join(archivedDir, `${retired}.sql`))) {
        problems.push(`retired provisional present in archived/: ${retired}`);
      }
    }
  }

  // 4. Breakpoint integrity: every file parses into ≥1 statement.
  for (const tag of tags) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, `${tag}.sql`), "utf8");
    const stmts = splitStatements(sql);
    if (stmts.length === 0) problems.push(`${tag}: no executable statements parsed`);
  }

  const report = {
    mode: "static",
    ok: problems.length === 0,
    journalEntries: entries.length,
    first: tags[0],
    last: tags[tags.length - 1],
    missionControlTablesVerified: MISSION_CONTROL_TABLES.length,
    retiredProvisionalsAbsent: RETIRED_0037_PROVISIONALS.length,
    problems,
  };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  return report.ok ? 0 : 1;
}

// ─── Live rehearsal (disposable DB only) ───

function parseRehearsalUrl(raw) {
  if (!raw) throw new Error("R10_B_REHEARSAL_URL is required for --live");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("R10_B_REHEARSAL_URL is not a valid URL");
  }
  if (url.protocol !== "mysql:") throw new Error(`R10_B_REHEARSAL_URL protocol must be mysql:, got ${url.protocol}`);
  const host = (url.hostname || "").toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    throw new Error(`FAIL-CLOSED: host '${url.hostname}' is not an allowed disposable-test host (localhost only)`);
  }
  const db = (url.pathname || "").replace(/^\//, "");
  if (!db.startsWith(REQUIRED_DB_PREFIX)) {
    throw new Error(`FAIL-CLOSED: database '${db}' must start with '${REQUIRED_DB_PREFIX}'`);
  }
  return url;
}

function sha(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

async function runLiveRehearsal() {
  const url = parseRehearsalUrl(process.env.R10_B_REHEARSAL_URL);
  const mysql = require("mysql2/promise");
  const report = {
    mode: "live",
    ok: false,
    steps: [],
    checks: [],
    problems: [],
  };
  const step = (name, detail) => report.steps.push({ name, ...detail });

  const admin = await mysql.createConnection({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username || "root"),
    password: decodeURIComponent(url.password || ""),
    multipleStatements: false,
  });
  const rehearsalDb = url.pathname.replace(/^\//, "");
  step("connect", { host: url.hostname, database: rehearsalDb });

  // 1. Fresh disposable DB (drop + create is safe: name is guarded).
  await admin.query(`DROP DATABASE IF EXISTS \`${rehearsalDb}\``);
  await admin.query(`CREATE DATABASE \`${rehearsalDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  step("fresh-database", { database: rehearsalDb });

  const db = await mysql.createConnection({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username || "root"),
    password: decodeURIComponent(url.password || ""),
    database: rehearsalDb,
    multipleStatements: false,
  });

  // 2. Apply migrations in journal order.
  const journal = loadJournal();
  let applied = 0;
  for (const entry of journal.entries) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, `${entry.tag}.sql`), "utf8");
    for (const stmt of splitStatements(sql)) {
      await db.query(stmt);
    }
    applied += 1;
  }
  step("migrations-applied", { count: applied, head: journal.entries[journal.entries.length - 1].tag });

  // 3. Schema verification.
  const [tables] = await db.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?", [rehearsalDb]);
  const tableNames = new Set(tables.map((t) => t.TABLE_NAME));
  for (const t of MISSION_CONTROL_TABLES) {
    const found = tableNames.has(t);
    report.checks.push({ check: `table:${t}`, ok: found });
    if (!found) report.problems.push(`missing table ${t}`);
  }

  const [indexes] = await db.query(
    "SELECT TABLE_NAME, INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND NON_UNIQUE = 0",
    [rehearsalDb]
  );
  const indexSet = new Set(indexes.map((i) => `${i.TABLE_NAME}:${i.INDEX_NAME}`));
  for (const [table, names] of Object.entries(EXPECTED_UNIQUE_INDEXES)) {
    for (const name of names) {
      const ok = indexSet.has(`${table}:${name}`);
      report.checks.push({ check: `unique-index:${table}.${name}`, ok });
      if (!ok) report.problems.push(`missing unique index ${table}.${name}`);
    }
  }

  const [approvalCol] = await db.query(
    "SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'approval_requests' AND COLUMN_NAME = 'approvalType'",
    [rehearsalDb]
  );
  const enumHasMissionAction =
    approvalCol.length === 1 && String(approvalCol[0].COLUMN_TYPE).includes("'mission_action'");
  report.checks.push({ check: "enum:approval_requests.approvalType[mission_action]", ok: enumHasMissionAction });
  if (!enumHasMissionAction) report.problems.push("approvalType enum missing mission_action");

  // 4. Data-integrity probes on canaries (disposable DB only).
  const H = (c) => c.repeat(64);
  const missionId = `mis1:${H("a1")}`;
  const now = new Date().toISOString().replace("T", " ").replace("Z", "");
  const baseMission = {
    missionId,
    objectiveId: `obj1:${H("b2")}`,
    userId: 900001,
    businessId: 900001,
    sourceCandidateId: `sor1:${H("c3")}`,
    sourceReasoningIds: JSON.stringify([]),
    missionType: "GROWTH_CAMPAIGN",
    objectiveType: "CONVERSION_LIFT",
    objectiveStatement: "probe",
    objectiveClientStatement: "probe",
    objectiveWordingDraft: null,
    modelAssistanceFlagged: 0,
    expectedOutcome: "probe",
    successCriteria: JSON.stringify([]),
    constraints: JSON.stringify([]),
    assumptions: JSON.stringify([]),
    scope: JSON.stringify({ subjectType: "BUSINESS", businessScope: 900001, channelScope: null, campaignScope: null, geography: null }),
    scopeKey: "probe",
    priorityContext: "NORMAL",
    strategicRiskClass: "MEDIUM",
    confidenceClass: "MODERATE",
    governanceDecisionId: null,
    governanceDecision: null,
    policyVersion: null,
    governanceRequirements: JSON.stringify([]),
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: "2027-01-01T00:00:00.000Z",
    limitations: JSON.stringify([]),
    lineageHash: H("d4"),
    missionFingerprint: H("e5"),
    objectiveFingerprint: H("f6"),
    constraintSetFingerprint: H("g7"),
    sourceProjection: JSON.stringify({}),
    sourceVersions: JSON.stringify({}),
    supersedesMissionId: null,
    status: "PROPOSED",
    version: 1,
  };
  const cols = Object.keys(baseMission);
  await db.query(`INSERT INTO mission_proposals (${cols.map((c) => `\`${c}\``).join(",")}) VALUES (${cols.map(() => "?").join(",")})`, Object.values(baseMission));
  let dupRejected = false;
  try {
    await db.query(`INSERT INTO mission_proposals (${cols.map((c) => `\`${c}\``).join(",")}) VALUES (${cols.map(() => "?").join(",")})`, Object.values(baseMission));
  } catch (e) {
    dupRejected = e.code === "ER_DUP_ENTRY" || e.errno === 1062;
  }
  report.checks.push({ check: "anchor:duplicate-mission-insert-rejected", ok: dupRejected });
  if (!dupRejected) report.problems.push("duplicate mission insert was not rejected by unique anchor");

  // CAS loser probe: version-guarded update.
  await db.query("UPDATE mission_proposals SET version = 2 WHERE userId = 900001 AND missionId = ? AND version = 1", [missionId]);
  const [casHeader] = await db.query("UPDATE mission_proposals SET version = 3 WHERE userId = 900001 AND missionId = ? AND version = 1", [missionId]);
  const casLoserRejected = Number(casHeader.affectedRows ?? casHeader[0]?.affectedRows ?? 0) === 0;
  report.checks.push({ check: "cas:stale-version-update-affects-zero-rows", ok: casLoserRejected });
  if (!casLoserRejected) report.problems.push("stale-version CAS update affected rows (anchor not enforced)");

  // Cross-tenant isolation probe: same missionId under a different tenant is a different row.
  const foreign = { ...baseMission, userId: 900002 };
  let crossTenantIsolated = true;
  try {
    await db.query(`INSERT INTO mission_proposals (${cols.map((c) => `\`${c}\``).join(",")}) VALUES (${cols.map(() => "?").join(",")})`, Object.values(foreign));
  } catch {
    crossTenantIsolated = false;
  }
  report.checks.push({ check: "isolation:cross-tenant-same-missionId-is-distinct-row", ok: crossTenantIsolated });
  if (!crossTenantIsolated) report.problems.push("cross-tenant same-missionId insert was blocked (anchor must be tenant-predicated, not global)");

  step("integrity-probes", { checks: report.checks.length });

  await db.end();
  await admin.end();

  report.ok = report.problems.length === 0;
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  return report.ok ? 0 : 1;
}

// ─── Entry ───

const mode = process.argv.includes("--live") ? "live" : "static";
try {
  const code = mode === "live" ? await runLiveRehearsal() : runStaticVerification();
  process.exit(code);
} catch (err) {
  process.stderr.write(
    JSON.stringify({ mode, ok: false, fatal: String(err && err.message ? err.message : err) }, null, 2) + "\n"
  );
  process.exit(1);
}
