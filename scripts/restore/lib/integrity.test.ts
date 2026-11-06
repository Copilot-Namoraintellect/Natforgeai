import { describe, expect, it } from "vitest";
import { assessIntegrity, TIER_A_TABLES, type RecoveryFacts } from "./integrity";

function okFacts(): RecoveryFacts {
  const tierACounts: Record<string, number> = {};
  for (const t of TIER_A_TABLES) tierACounts[t] = 7;
  return {
    presentTables: [...TIER_A_TABLES, "users", "campaigns"],
    missingTables: [],
    tableCount: TIER_A_TABLES.length + 2,
    migration: { expectedLatestTag: "0037_r9_mission_control_foundation", schemaMatchesRelease: true },
    tierACounts,
    expectedCounts: { ...tierACounts },
    audit: { count: 42, expectedCount: 42, fingerprintDuplicates: 0, idGaps: 0, expectedIdGaps: 0 },
    execution: { actions: 5, attempts: 6, succeededDuplicateActions: 0, uncertainPreserved: 1, uncertainExpected: 1 },
    identities: [
      { table: "mission_proposals", prefix: "mis1:", sampled: 20, valid: 20 },
      { table: "execution_actions", prefix: "exa1:", sampled: 20, valid: 20 },
      { table: "business_outcomes", prefix: "out1:", sampled: 20, valid: 20 },
    ],
    staleActiveClaims: 0,
  };
}

describe("assessIntegrity (G7)", () => {
  it("passes a faithful restore", () => {
    const r = assessIntegrity(okFacts());
    expect(r.verdict).toBe("INTEGRITY_PASS");
    expect(r.checks.every((c) => c.pass)).toBe(true);
  });

  it("fails when a Tier A table is missing", () => {
    const f = okFacts();
    f.missingTables = ["mission_governance_decisions"];
    f.presentTables = f.presentTables.filter((t) => t !== "mission_governance_decisions");
    const r = assessIntegrity(f);
    expect(r.verdict).toBe("INTEGRITY_FAIL");
    expect(r.checks.find((c) => c.id === "tier-a-presence")?.pass).toBe(false);
  });

  it("fails on migration identity drift", () => {
    const f = okFacts();
    f.migration.schemaMatchesRelease = false;
    const r = assessIntegrity(f);
    expect(r.verdict).toBe("INTEGRITY_FAIL");
    expect(r.checks.find((c) => c.id === "migration-identity")?.pass).toBe(false);
  });

  it("fails when authority row counts differ from pre-restore truth", () => {
    const f = okFacts();
    f.tierACounts.mission_proposals = 6; // one mission lost in restore
    const r = assessIntegrity(f);
    expect(r.verdict).toBe("INTEGRITY_FAIL");
    expect(r.checks.find((c) => c.id === "authority-counts-preserved")?.detail).toContain("mission_proposals: 6 != 7");
  });

  it("fails on audit fingerprint duplicates or count drift", () => {
    const dupes = okFacts();
    dupes.audit.fingerprintDuplicates = 3;
    expect(assessIntegrity(dupes).verdict).toBe("INTEGRITY_FAIL");

    const drift = okFacts();
    drift.audit.count = 41;
    expect(assessIntegrity(drift).verdict).toBe("INTEGRITY_FAIL");
  });

  it("allows audit id gaps up to the source's own gap count", () => {
    const f = okFacts();
    f.audit.idGaps = 2;
    f.audit.expectedIdGaps = 2; // source itself had 2 gaps; restore preserved them
    expect(assessIntegrity(f).checks.find((c) => c.id === "audit-id-monotonic")?.pass).toBe(true);
    f.audit.idGaps = 3; // restore introduced a NEW gap
    expect(assessIntegrity(f).checks.find((c) => c.id === "audit-id-monotonic")?.pass).toBe(false);
  });

  it("fails when a duplicate dispatch appears (two SUCCEEDED attempts for one action)", () => {
    const f = okFacts();
    f.execution.succeededDuplicateActions = 1;
    const r = assessIntegrity(f);
    expect(r.verdict).toBe("INTEGRITY_FAIL");
    expect(r.checks.find((c) => c.id === "no-duplicate-dispatch")?.pass).toBe(false);
  });

  it("fails when uncertainty is not preserved verbatim (healed or lost)", () => {
    const healed = okFacts();
    healed.execution.uncertainPreserved = 0; // a stale worker "resolved" it
    expect(assessIntegrity(healed).verdict).toBe("INTEGRITY_FAIL");

    const lost = okFacts();
    lost.execution.uncertainPreserved = 2; // phantom uncertain attempts
    expect(assessIntegrity(lost).verdict).toBe("INTEGRITY_FAIL");
  });

  it("fails on malformed identity samples", () => {
    const f = okFacts();
    f.identities[0] = { table: "mission_proposals", prefix: "mis1:", sampled: 20, valid: 19 };
    const r = assessIntegrity(f);
    expect(r.verdict).toBe("INTEGRITY_FAIL");
    expect(r.checks.find((c) => c.id === "identity-patterns")?.detail).toContain("19/20");
  });

  it("fails on stale active claims (worker would resume with old authority)", () => {
    const f = okFacts();
    f.staleActiveClaims = 4;
    expect(assessIntegrity(f).verdict).toBe("INTEGRITY_FAIL");
  });

  it("fails when information_schema table count disagrees with the set view", () => {
    const f = okFacts();
    f.tableCount = 100;
    expect(assessIntegrity(f).checks.find((c) => c.id === "table-count")?.pass).toBe(false);
  });
});
