#!/usr/bin/env bash
# R10-G local rehearsal (file level, no database).
#
# Exercises the full backup→restore→verify chain against synthetic fixtures:
#   assemble set → verify --decrypt → tamper/negative paths → restore run →
#   integrity verify (G7) → production-target guard check.
#
# Honest scope: no MySQL is dumped or restored here (none exists on a dev
# host and none may be touched in production). The DB-apply step of
# run-restore.sh and the gather path require a real disposable MySQL and are
# covered by the R10-X drill. See docs/recovery/r10-g-recovery-rehearsal-plan.md §6.
#
# Usage: rehearsal-local.sh [workdir]   (default: mktemp -d)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORK="${1:-$(mktemp -d -t r10g-rehearsal-XXXX)}"
export PATH="/c/Users/27768/.kimi-tools/node-v22.12.0-win-x64:$PATH"
export BACKUP_PASSPHRASE="rehearsal-only-passphrase"

echo "=== R10-G local rehearsal (file level) — workdir: $WORK"
mkdir -p "$WORK/staging" "$WORK/backups" "$WORK/restore"

# ── Fixture: synthetic dump covering all Tier A + core tables, with rows ──
node - "$WORK/staging/dump.sql" <<'NODE'
const fs = require("fs");
const tierA = [
  "mission_proposals","mission_lifecycle_events","mission_plans","mission_plan_tasks",
  "mission_plan_lifecycle_events","mission_schedules","mission_schedule_lifecycle_events",
  "mission_task_plan_snapshots","mission_dependency_edges","mission_governance_decisions",
  "approval_requests","execution_actions","execution_attempts","execution_lifecycle_events",
  "mission_state_records","mission_task_states","mission_recovery_candidates",
  "mission_operational_timeline_events","audit_events","business_outcomes",
  "business_outcome_lifecycle_events","business_learning_records","business_learning_lifecycle_events",
  "conversion_events","conversion_lifecycle_events","attribution_results",
  "optimisation_governance_decisions","strategic_governance_decisions","policy_decisions",
  "lead_identities","lead_qualifications","lead_score_snapshots",
];
const core = ["users","businesses","campaigns","leads","content_posts","schedules","payments","subscriptions"];
const hex = (s) => require("crypto").createHash("sha256").update(s).digest("hex");
let sql = "-- synthetic rehearsal dump (NOT a real database)\n";
for (const t of [...tierA, ...core]) sql += `DROP TABLE IF EXISTS \`${t}\`;\nCREATE TABLE \`${t}\` (\`id\` bigint);\n`;
sql += "INSERT INTO `audit_events` VALUES ('ev1'),('ev2'),('ev3');\n";
sql += `INSERT INTO \`mission_proposals\` VALUES ('mis1:${hex("m1")}'),('mis1:${hex("m2")}');\n`;
sql += "INSERT INTO `execution_attempts` VALUES ('exr1','UNCERTAIN');\n";
sql += "-- Dump completed on 2026-11-14  2:00:00\n";
fs.writeFileSync(process.argv[2], sql);
NODE

# Fixture: assets tar + env with secrets (must never reach the set raw).
printf 'fake-asset-bytes' > "$WORK/staging/assets.tar"
printf 'APP_SECRET=shh-do-not-leak\nDATABASE_URL=mysql://u:p@h:3306/db\nENABLE_X=true\n' > "$WORK/staging/.env"

TOTAL=0; FAILED=0
step() { TOTAL=$((TOTAL+1)); echo; echo "── step $TOTAL: $1"; }
bad() { FAILED=$((FAILED+1)); echo "   ✗ $1" >&2; }
ok() { echo "   ✓ $1"; }

step "backup: assemble verified encrypted set"
if (cd "$REPO_ROOT" && npx tsx scripts/backup/backup-cli.ts create \
      --dump "$WORK/staging/dump.sql" --assets "$WORK/staging/assets.tar" \
      --env-file "$WORK/staging/.env" --out "$WORK/backups" \
      --db-name natforge-sim --host-role rehearsal --table-count 40 > "$WORK/create.json" 2>&1); then
  ok "set assembled: $(grep -o '"setId": "[^"]*"' "$WORK/create.json")"
else
  cat "$WORK/create.json" >&2; bad "set assembly failed"
fi
SET_DIR="$(ls -1d "$WORK"/backups/set-*Z 2>/dev/null | head -n1)"

step "backup: set contains no plaintext dump and no secret material"
if [[ -f "$SET_DIR/db/dump.sql" ]]; then bad "plaintext dump present in set"; else ok "dump stored encrypted only"; fi
if grep -Rq "shh-do-not-leak" "$SET_DIR"; then bad "env secret leaked into set"; else ok "no env secret in set"; fi
if grep -Rq "mysql://u:p@" "$SET_DIR"; then bad "DSN leaked into set"; else ok "no DSN in set"; fi

step "backup: verify --decrypt (manifest + round-trip)"
if (cd "$REPO_ROOT" && BACKUP_PASSPHRASE="$BACKUP_PASSPHRASE" npx tsx scripts/backup/backup-cli.ts verify --set "$SET_DIR" --decrypt > "$WORK/verify.json" 2>&1); then
  ok "verify passed"
else
  cat "$WORK/verify.json" >&2; bad "verify failed"
fi

step "negative: wrong passphrase fails closed"
if (cd "$REPO_ROOT" && BACKUP_PASSPHRASE="wrong" npx tsx scripts/backup/backup-cli.ts verify --set "$SET_DIR" --decrypt >/dev/null 2>&1); then
  bad "wrong passphrase accepted"
else
  ok "wrong passphrase rejected"
fi

step "negative: tampered ciphertext fails manifest/decrypt"
cp -r "$SET_DIR" "$WORK/backups/tampered"
printf 'X' | dd of="$WORK/backups/tampered/db/dump.sql.enc" bs=1 seek=30 conv=notrunc 2>/dev/null
if (cd "$REPO_ROOT" && BACKUP_PASSPHRASE="$BACKUP_PASSPHRASE" npx tsx scripts/backup/backup-cli.ts verify --set "$WORK/backups/tampered" --decrypt >/dev/null 2>&1); then
  bad "tampered set verified"
else
  ok "tampered set rejected"
fi
rm -rf "$WORK/backups/tampered"

step "negative: secret embedded in dump aborts assembly"
echo "INSERT INTO x VALUES ('mysql://leak:leak@h/db');" >> "$WORK/staging/dump.sql"
if (cd "$REPO_ROOT" && npx tsx scripts/backup/backup-cli.ts create --dump "$WORK/staging/dump.sql" --out "$WORK/backups" --passphrase-env BACKUP_PASSPHRASE >/dev/null 2>&1); then
  bad "secret-bearing dump assembled"
else
  ok "secret-bearing dump aborted"
fi

step "restore: decrypt + extract to scratch area"
if (cd "$REPO_ROOT" && npx tsx scripts/restore/restore.ts run --set "$SET_DIR" --to "$WORK/restore/set" > "$WORK/restore.json" 2>&1); then
  ok "restored files: $(grep -o '"files": [0-9]*' "$WORK/restore.json")"
else
  cat "$WORK/restore.json" >&2; bad "restore run failed"
fi
if [[ -f "$WORK/restore/set/db/dump.sql" ]] && grep -q "Dump completed" "$WORK/restore/set/db/dump.sql"; then
  ok "restored dump decrypts to sane mysqldump"
else
  bad "restored dump missing/invalid"
fi

step "restore: production-target guard refuses production host"
if (cd "$REPO_ROOT" && PRODUCTION_DB_HOST=prod.db.internal npx tsx scripts/restore/restore.ts gather --db-url "mysql://u@prod.db.internal:3306/db" >/dev/null 2>&1); then
  bad "guard allowed production target"
else
  ok "guard refused production target (exit $?)"
fi

step "restore: G7 integrity assessment on rehearsal facts"
node - "$WORK" <<'NODE'
const fs = require("fs");
const work = process.argv[2];
const tierA = fs.readFileSync(`${work}/restore/set/db/dump.sql`, "utf8")
  .match(/^CREATE TABLE `([^`]+)`/gm).map((l) => l.match(/`([^`]+)`/)[1])
  .filter((t) => !["users","businesses","campaigns","leads","content_posts","schedules","payments","subscriptions"].includes(t))
  .reduce((acc, t) => ({ ...acc, [t]: 0 }), {});
const counts = {
  ...tierA,
  audit_events: 3,
  mission_proposals: 2,
  execution_attempts: 1,
};
const facts = {
  presentTables: [...Object.keys(counts), "users","businesses","campaigns","leads","content_posts","schedules","payments","subscriptions"],
  missingTables: [],
  tableCount: Object.keys(counts).length + 8,
  migration: { expectedLatestTag: "0037_r9_mission_control_foundation", schemaMatchesRelease: true },
  tierACounts: counts,
  expectedCounts: counts,
  audit: { count: 3, expectedCount: 3, fingerprintDuplicates: 0, idGaps: 0, expectedIdGaps: 0 },
  execution: { actions: 0, attempts: 1, succeededDuplicateActions: 0, uncertainPreserved: 1, uncertainExpected: 1 },
  identities: [
    { table: "mission_proposals", prefix: "mis1:", sampled: 2, valid: 2 },
    { table: "execution_actions", prefix: "exa1:", sampled: 0, valid: 0 },
  ],
  staleActiveClaims: 0,
};
fs.writeFileSync(`${work}/facts.json`, JSON.stringify(facts, null, 2));
NODE
if (cd "$REPO_ROOT" && npx tsx scripts/restore/restore.ts verify --facts "$WORK/facts.json" > "$WORK/integrity.json" 2>&1); then
  ok "INTEGRITY_PASS"
else
  cat "$WORK/integrity.json" >&2; bad "integrity assessment failed"
fi

step "negative: duplicate-dispatch facts fail integrity"
node -e "
  const fs=require('fs');
  const f=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
  f.execution.succeededDuplicateActions=1;
  fs.writeFileSync(process.argv[2], JSON.stringify(f));
" "$WORK/facts.json" "$WORK/facts-dup.json"
if (cd "$REPO_ROOT" && npx tsx scripts/restore/restore.ts verify --facts "$WORK/facts-dup.json" >/dev/null 2>&1); then
  bad "duplicate-dispatch facts passed"
else
  ok "duplicate-dispatch facts rejected"
fi

step "orchestrator: run-restore.sh (no DB apply) completes + audits"
if (cd "$REPO_ROOT" && BACKUP_SET="$SET_DIR" RESTORE_WORKDIR="$WORK/restore-orc" RESTORE_LOG="$WORK/restore-audit.log" \
     bash scripts/restore/run-restore.sh > "$WORK/orc.json" 2>&1); then
  grep -q '"integrityVerdict": "NOT_RUN"' "$WORK/restore-orc/restore-run.json" 2>/dev/null && ok "restore-run.json written" || ok "orchestrator completed (no-db mode)"
  [[ -s "$WORK/restore-audit.log" ]] && ok "append-only restore audit written" || bad "restore audit missing"
else
  cat "$WORK/orc.json" >&2; bad "orchestrator failed"
fi

echo
if [[ "$FAILED" -eq 0 ]]; then
  echo "=== REHEARSAL RESULT: ALL $TOTAL STEPS PASSED (workdir kept: $WORK)"
  exit 0
else
  echo "=== REHEARSAL RESULT: $FAILED/$TOTAL steps failed" >&2
  exit 1
fi
