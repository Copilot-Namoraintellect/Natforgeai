/**
 * Post-restore recovery-integrity assessment (pure).
 *
 * Consumes facts about the restored database (gathered either by querying a
 * real recovery instance or supplied from a rehearsal fixture) and verifies
 * the G7 invariants:
 *
 *   - mission / planning / schedule identities unchanged (counts + identity
 *     pattern sampling);
 *   - approval history preserved;
 *   - execution history preserved;
 *   - uncertainty preserved verbatim (no uncertain attempt "healed" itself);
 *   - audit timeline preserved (fingerprints unique, id monotonic);
 *   - no duplicate dispatch introduced (≤ 1 SUCCEEDED attempt per action);
 *   - no migration-identity drift vs the pinned release.
 *
 * Verdict is INTEGRITY_PASS only when every check passes. Nothing here
 * mutates anything; assessment is read-only over supplied facts.
 */

export interface IdentitySample {
  table: string;
  /** Expected identity prefix, e.g. "mis1:". */
  prefix: string;
  sampled: number;
  valid: number;
}

export interface RecoveryFacts {
  /** Tables present in the restored database. */
  presentTables: string[];
  /** Tables expected but absent → immediate fail. */
  missingTables: string[];
  /** Total table count (for information_schema cross-check). */
  tableCount: number;
  migration: {
    /** Latest journal tag the release expects (e.g. "0037_r9_mission_control_foundation"). */
    expectedLatestTag: string;
    /** Whether the restored schema carries that migration identity. */
    schemaMatchesRelease: boolean;
  };
  /** Row counts per Tier A authority table. */
  tierACounts: Record<string, number>;
  /** Expected counts (pre-restore truth). Absent keys → presence-only check. */
  expectedCounts?: Record<string, number>;
  audit: {
    count: number;
    expectedCount?: number;
    fingerprintDuplicates: number;
    /** id gaps beyond the source's own gap count (dump/restore must preserve ids exactly). */
    idGaps: number;
    expectedIdGaps?: number;
  };
  execution: {
    actions: number;
    attempts: number;
    /** Actions with more than one SUCCEEDED attempt — must be 0. */
    succeededDuplicateActions: number;
    /** UNCERTAIN/PENDING_EXTERNAL attempts present post-restore. */
    uncertainPreserved: number;
    /** Same count pre-restore — must match exactly. */
    uncertainExpected: number;
  };
  identities: IdentitySample[];
  /** Active queue-replay claims that outlived their lease — must be 0 before workers start. */
  staleActiveClaims: number;
}

export interface IntegrityCheck {
  id: string;
  pass: boolean;
  detail: string;
}

export interface IntegrityReport {
  verdict: "INTEGRITY_PASS" | "INTEGRITY_FAIL";
  checks: IntegrityCheck[];
}

export const TIER_A_TABLES = [
  "mission_proposals",
  "mission_lifecycle_events",
  "mission_plans",
  "mission_plan_tasks",
  "mission_plan_lifecycle_events",
  "mission_schedules",
  "mission_schedule_lifecycle_events",
  "mission_task_plan_snapshots",
  "mission_dependency_edges",
  "mission_governance_decisions",
  "approval_requests",
  "execution_actions",
  "execution_attempts",
  "execution_lifecycle_events",
  "mission_state_records",
  "mission_task_states",
  "mission_recovery_candidates",
  "mission_operational_timeline_events",
  "audit_events",
  "business_outcomes",
  "business_outcome_lifecycle_events",
  "business_learning_records",
  "business_learning_lifecycle_events",
  "conversion_events",
  "conversion_lifecycle_events",
  "attribution_results",
  "optimisation_governance_decisions",
  "strategic_governance_decisions",
  "policy_decisions",
  "lead_identities",
  "lead_qualifications",
  "lead_score_snapshots",
] as const;

const IDENTITY_RE = (prefix: string) => new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[0-9a-f]{64}$`);

export function assessIntegrity(facts: RecoveryFacts): IntegrityReport {
  const checks: IntegrityCheck[] = [];
  const check = (id: string, pass: boolean, detail: string) => checks.push({ id, pass, detail });

  // 1. Tier A tables all present.
  check(
    "tier-a-presence",
    facts.missingTables.length === 0,
    facts.missingTables.length === 0
      ? `all ${TIER_A_TABLES.length} Tier A tables present`
      : `missing tables: ${facts.missingTables.join(", ")}`,
  );

  // 2. Table count cross-check (information_schema view agrees).
  const expectedTotal = facts.presentTables.length;
  check(
    "table-count",
    facts.tableCount === expectedTotal,
    `information_schema reports ${facts.tableCount}, set view reports ${expectedTotal}`,
  );

  // 3. Migration identity vs pinned release.
  check(
    "migration-identity",
    facts.migration.schemaMatchesRelease,
    `expected latest tag ${facts.migration.expectedLatestTag}; schema match=${facts.migration.schemaMatchesRelease}`,
  );

  // 4. Per-table counts vs pre-restore truth.
  const mismatches: string[] = [];
  for (const table of TIER_A_TABLES) {
    const actual = facts.tierACounts[table];
    if (actual === undefined) {
      mismatches.push(`${table}: absent from facts`);
      continue;
    }
    const expected = facts.expectedCounts?.[table];
    if (expected !== undefined && actual !== expected) {
      mismatches.push(`${table}: ${actual} != ${expected}`);
    }
  }
  check("authority-counts-preserved", mismatches.length === 0, mismatches.length ? mismatches.join("; ") : "all Tier A counts match pre-restore truth");

  // 5. Audit timeline.
  check("audit-fingerprints-unique", facts.audit.fingerprintDuplicates === 0, `${facts.audit.fingerprintDuplicates} duplicate fingerprints`);
  const expectedAudit = facts.audit.expectedCount;
  check(
    "audit-count-preserved",
    expectedAudit === undefined || facts.audit.count === expectedAudit,
    `audit_events ${facts.audit.count}${expectedAudit !== undefined ? ` (expected ${expectedAudit})` : ""}`,
  );
  const allowedGaps = facts.audit.expectedIdGaps ?? 0;
  check("audit-id-monotonic", facts.audit.idGaps <= allowedGaps, `${facts.audit.idGaps} id gaps (allowed ${allowedGaps})`);

  // 6. Execution integrity (G7: no duplicate dispatch, uncertainty preserved).
  check(
    "no-duplicate-dispatch",
    facts.execution.succeededDuplicateActions === 0,
    `${facts.execution.succeededDuplicateActions} actions with multiple SUCCEEDED attempts`,
  );
  check(
    "uncertainty-preserved",
    facts.execution.uncertainPreserved === facts.execution.uncertainExpected,
    `uncertain attempts ${facts.execution.uncertainPreserved} (expected ${facts.execution.uncertainExpected})`,
  );

  // 7. Identity pattern sampling (mis1:/exa1:/out1:/mgd1: …).
  const badIdentities = facts.identities.filter((s) => s.valid !== s.sampled);
  check(
    "identity-patterns",
    badIdentities.length === 0 && facts.identities.length > 0,
    badIdentities.length
      ? badIdentities.map((s) => `${s.table}: ${s.valid}/${s.sampled} valid`).join("; ")
      : `${facts.identities.reduce((n, s) => n + s.sampled, 0)} sampled identities all well-formed`,
  );

  // 8. No stale worker claims (workers must not resume with old authority).
  check("no-stale-claims", facts.staleActiveClaims === 0, `${facts.staleActiveClaims} stale active claims`);

  return {
    verdict: checks.every((c) => c.pass) ? "INTEGRITY_PASS" : "INTEGRITY_FAIL",
    checks,
  };
}
