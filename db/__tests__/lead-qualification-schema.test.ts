import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const schemaPath = resolve(__dirname, "../schema.ts");
// R6-X canonical convergence (docs/recovery/r6-migration-convergence.md): the
// six stream-local provisional 0034 artefacts were merged into the single
// canonical 0034_r6_lead_autonomy_foundation; C's accepted anchors are verified
// against that canonical migration.
const migrationPath = resolve(__dirname, "../migrations/0034_r6_lead_autonomy_foundation.sql");

// Blocker-4 (real-MySQL concurrency) structural evidence: the deterministic
// in-memory executors mirror these durable anchors. The exact-once
// convergence, one-review-per-decision and optimistic-CAS semantics proven in
// the qualification store/acceptance suites hold on a real MySQL only because
// these constraints exist there; R6-X must re-run the concurrency cases
// against a disposable MySQL before deployed acceptance (see
// docs/recovery/r6-c-lead-qualification-acceptance-report.md).

function tableBlock(source: string, name: string): string {
  const match = source.match(
    new RegExp(`export const ${name} = mysqlTable\\([\\s\\S]*?\\n\\);`)
  );
  expect(match, name).toBeTruthy();
  return match?.[0] ?? "";
}

describe("lead qualification schema — exact-once anchors", () => {
  // Line-ending normalisation: the working-tree schema file may carry CRLF
  // (git core.autocrlf); the structural assertions below are exact either way.
  const schema = readFileSync(schemaPath, "utf8").replace(/\r\n/g, "\n");

  it("lead_qualifications enforces unique (userId, qualificationId) convergence", () => {
    const block = tableBlock(schema, "leadQualifications");
    expect(block).toMatch(/uniqueIndex\("lqd_convergence_uidx"\)\.on\(t\.userId,\s*t\.qualificationId\)/);
    expect(block).toContain('mysqlTable(\n  "lead_qualifications"');
  });

  it("lead_qualification_reviews enforces one review per decision + CAS version", () => {
    const block = tableBlock(schema, "leadQualificationReviews");
    expect(block).toMatch(/uniqueIndex\("lqr_review_uidx"\)\.on\(t\.userId,\s*t\.reviewId\)/);
    expect(block).toMatch(/uniqueIndex\("lqr_qualification_uidx"\)\.on\(t\.userId,\s*t\.qualificationId\)/);
    expect(block).toMatch(/version: int\("version"\)\.notNull\(\)\.default\(1\)/);
  });

  it("lead_qualification_reviews carries the human-review challenge binding columns", () => {
    const block = tableBlock(schema, "leadQualificationReviews");
    expect(block).toContain('pendingChallengeToken: varchar("pendingChallengeToken", { length: 255 })');
    expect(block).toContain('challengeExpiresAt: varchar("challengeExpiresAt", { length: 32 })');
  });

  it("two_factor_challenges enforces the single-use challenge token anchor", () => {
    const block = tableBlock(schema, "twoFactorChallenges");
    expect(block).toContain('challengeToken: varchar("challengeToken", { length: 255 }).notNull().unique()');
    expect(block).toMatch(/maxAttempts: int\("maxAttempts"\)\.default\(5\)/);
  });
});

describe("lead qualification schema — canonical migration parity", () => {
  it("0034 carries the same anchors and challenge binding columns", () => {
    const migration = readFileSync(migrationPath, "utf8");
    expect(migration).toMatch(/CONSTRAINT `lqd_convergence_uidx` UNIQUE\(`userId`,`qualificationId`\)/);
    expect(migration).toMatch(/CONSTRAINT `lqr_review_uidx` UNIQUE\(`userId`,`reviewId`\)/);
    expect(migration).toMatch(/CONSTRAINT `lqr_qualification_uidx` UNIQUE\(`userId`,`qualificationId`\)/);
    expect(migration).toContain("`pendingChallengeToken` varchar(255)");
    expect(migration).toContain("`challengeExpiresAt` varchar(32)");
  });
});
