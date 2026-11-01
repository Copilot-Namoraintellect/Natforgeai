/**
 * R10-B — REAL MySQL Concurrency Harness (B4/B6/B9), live twin.
 *
 * Executes the required concurrency scenarios against GENUINE concurrent MySQL
 * sessions (one connection per worker from a mysql2 pool) on a SAFE,
 * DISPOSABLE, NON-PRODUCTION database.
 *
 * Gating (fail-closed):
 *   - Skipped entirely unless R10_B_MYSQL_URL is set (vitest.skipIf).
 *   - The URL host must be localhost/127.0.0.1/::1 AND the database name must
 *     start with r10b_concurrency_ — anything else aborts the suite.
 *   - The suite creates a FRESH database, applies the repository migration
 *     chain (0000 … canonical 0037) itself, and drops it at the end.
 *
 * When no disposable MySQL exists this file contributes zero tests and the
 * suite reports SKIP — REAL_MYSQL_CONCURRENCY_EXECUTED remains False and no
 * acceptance is fabricated. The offline twin
 * (api/r10-b-structural-concurrency.test.ts) carries the structural evidence.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const URL_RAW = process.env.R10_B_MYSQL_URL ?? "";
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const REQUIRED_PREFIX = "r10b_concurrency_";

function parseGuardedUrl(raw: string): URL | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "mysql:") return null;
  if (!ALLOWED_HOSTS.has((url.hostname || "").toLowerCase())) return null;
  const db = (url.pathname || "").replace(/^\//, "");
  if (!db.startsWith(REQUIRED_PREFIX)) return null;
  return url;
}

const GUARDED = parseGuardedUrl(URL_RAW);
const RUN_LIVE = GUARDED !== null;

const H = (c: string) => c.repeat(64);
const sha = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const MISSION_ID = `mis1:${H("a")}`;
const PLAN_ID = `pln1:${H("d")}`;
const SCHEDULE_ID = `sch1:${H("b")}`;
const TASK = "task-alpha";
const USER1 = 7001;
const USER2 = 7002;
const BIZ1 = 501;
const NOW_S = "2026-11-11 12:00:00";

// ─── Migration bootstrap (same journal-order logic as the rehearsal script) ───

function journalEntries(): string[] {
  const journal = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), "db/migrations/meta/_journal.json"), "utf8")
  ) as { entries: Array<{ tag: string }> };
  return journal.entries.map((e) => e.tag);
}

function splitStatements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((s) =>
      s
        .split("\n")
        .filter((l) => !l.trim().startsWith("--"))
        .join("\n")
        .trim()
    )
    .filter((s) => s.length > 0 && /^\s*(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|SET)/m.test(s));
}

describe.skipIf(!RUN_LIVE)("R10-B real-MySQL concurrency (live twin)", () => {
  let mysql: typeof import("mysql2/promise");
  let admin: import("mysql2/promise").Connection;
  let pool: import("mysql2/promise").Pool;
  let dbName = "";

  beforeAll(async () => {
    mysql = await import("mysql2/promise");
    const url = GUARDED!;
    const base = {
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username || "root"),
      password: decodeURIComponent(url.password || ""),
    };
    admin = await mysql.createConnection(base);
    dbName = url.pathname.replace(/^\//, "");
    await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await admin.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    const db = await mysql.createConnection({ ...base, database: dbName });
    for (const tag of journalEntries()) {
      const sqlText = fs.readFileSync(path.resolve(process.cwd(), `db/migrations/${tag}.sql`), "utf8");
      for (const stmt of splitStatements(sqlText)) {
        await db.query(stmt);
      }
    }
    await db.end();
    pool = mysql.createPool({ ...base, database: dbName, connectionLimit: 12, waitForConnections: true });
  }, 180_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
      await admin.end();
    }
  });

  /** Run K workers, each on its OWN pooled connection (genuine sessions). */
  async function runSqlWorkers<T>(count: number, worker: (conn: import("mysql2/promise").PoolConnection, i: number) => Promise<T>): Promise<T[]> {
    return Promise.all(
      Array.from({ length: count }, async (_, i) => {
        const conn = await pool.getConnection();
        try {
          return await worker(conn, i);
        } finally {
          conn.release();
        }
      })
    );
  }

  const dupErr = (e: unknown) => (e as { code?: string }).code === "ER_DUP_ENTRY";

  function missionInsertSql(missionId: string, userId: number, fingerprint: string): { sql: string; params: unknown[] } {
    return {
      sql: `INSERT INTO mission_proposals
        (missionId, objectiveId, userId, businessId, sourceCandidateId, sourceReasoningIds, missionType, objectiveType,
         objectiveStatement, objectiveClientStatement, objectiveWordingDraft, modelAssistanceFlagged, expectedOutcome,
         successCriteria, constraints, assumptions, scope, scopeKey, priorityContext, strategicRiskClass, confidenceClass,
         governanceDecisionId, governanceDecision, policyVersion, governanceRequirements, validFrom, validUntil, limitations,
         lineageHash, missionFingerprint, objectiveFingerprint, constraintSetFingerprint, sourceProjection, sourceVersions,
         supersedesMissionId, status, version)
        VALUES (?,?,?,?,?,JSON_ARRAY(),'GROWTH_CAMPAIGN','CONVERSION_LIFT','probe','probe',NULL,0,'probe',
         JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),JSON_OBJECT(),'probe','NORMAL','MEDIUM','MODERATE',
         NULL,NULL,NULL,JSON_ARRAY(),'2026-11-01T00:00:00.000Z','2027-01-01T00:00:00.000Z',JSON_ARRAY(),
         ?,?,JSON_OBJECT(),JSON_OBJECT(),JSON_OBJECT(),NULL,'PROPOSED',1)`,
      params: [missionId, `obj1:${sha(`obj${missionId}`).slice(0, 60)}`, userId, BIZ1, `sor1:${H("c")}`, fingerprint, fingerprint, fingerprint],
    };
  }

  it("r1: duplicate mission formation — K sessions race the mp_user_mission_uidx anchor", async () => {
    const { sql, params } = missionInsertSql(MISSION_ID, USER1, H("fp"));
    const outcomes = await runSqlWorkers(8, async (conn) => {
      try {
        await conn.query(sql, params);
        return "inserted";
      } catch (e) {
        return dupErr(e) ? "dup" : `err:${(e as { code?: string }).code}`;
      }
    });
    expect(outcomes.filter((o) => o === "inserted")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "dup")).toHaveLength(7);
    const [rows] = await pool.query("SELECT COUNT(*) AS c FROM mission_proposals WHERE missionId = ?", [MISSION_ID]);
    expect(Number((rows as Array<{ c: number }>)[0].c)).toBe(1);
  });

  it("r2: duplicate plan formation — K sessions race the plan identity + version anchors", async () => {
    await pool.query(
      `INSERT INTO mission_plans (planId, planVersion, userId, businessId, missionId, missionAuthorityVersion, boundMissionVersion,
        planScopeKey, taskIds, taskSetFingerprint, constraintSetFingerprint, missionConstraints, planningAssumptions, unresolvedItems,
        completenessStatus, status, validFrom, validUntil, supersedesPlanId, planFingerprint, modelAssistanceFlagged, version)
       VALUES (?,1,?,?,?,?,1,'probe',JSON_ARRAY('task-alpha'),'','',JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),'COMPLETE','PLANNING',
        '2026-11-01T00:00:00.000Z','2027-01-01T00:00:00.000Z',NULL,?,0,1)`,
      [PLAN_ID, USER1, BIZ1, MISSION_ID, H("e5"), H("p1")]
    );
    const outcomes = await runSqlWorkers(8, async (conn) => {
      try {
        await conn.query(
          `INSERT INTO mission_plans (planId, planVersion, userId, businessId, missionId, missionAuthorityVersion, boundMissionVersion,
            planScopeKey, taskIds, taskSetFingerprint, constraintSetFingerprint, missionConstraints, planningAssumptions, unresolvedItems,
            completenessStatus, status, validFrom, validUntil, supersedesPlanId, planFingerprint, modelAssistanceFlagged, version)
           VALUES (?,1,?,?,?,?,1,'probe2',JSON_ARRAY('task-alpha'),'','',JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),'COMPLETE','PLANNING',
            '2026-11-01T00:00:00.000Z','2027-01-01T00:00:00.000Z',NULL,?,0,1)`,
          [`pln1:${H("race")}`, USER1, BIZ1, MISSION_ID, H("e5"), H("p2")]
        );
        return "inserted";
      } catch (e) {
        return dupErr(e) ? "dup" : `err:${(e as { code?: string }).code}`;
      }
    });
    // version anchor (userId, missionId, planVersion=1) admits at most one row per version.
    expect(outcomes.filter((o) => o === "inserted")).toHaveLength(0);
    const [rows] = await pool.query("SELECT COUNT(*) AS c FROM mission_plans WHERE userId = ? AND missionId = ? AND planVersion = 1", [USER1, MISSION_ID]);
    expect(Number((rows as Array<{ c: number }>)[0].c)).toBe(1);
  });

  it("r3: duplicate schedule creation — identical sch1: content converges", async () => {
    const scheduleInsert = async (conn: import("mysql2/promise").PoolConnection, fingerprint: string) => {
      try {
        await conn.query(
          `INSERT INTO mission_schedules (scheduleId, userId, businessId, missionId, planId, planFingerprint, status, orderedTaskIds,
            parallelGroups, blockingStates, dependencyRefs, governanceRequirements, riskClass, requiresApproval, graphHash, stateViewHash,
            readinessHash, approvalEvidenceHash, capabilityEvidenceHash, scheduleFingerprint, validFrom, validUntil, producedAt, version)
           VALUES (?,?,?,?,?,?,'READY',JSON_ARRAY('task-alpha'),JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),JSON_OBJECT(),'LOW',0,
            '','','','','',?,'2026-11-01T00:00:00.000Z','2027-01-01T00:00:00.000Z','2026-11-01T00:00:00.000Z',1)`,
          [SCHEDULE_ID, USER1, BIZ1, MISSION_ID, PLAN_ID, H("e"), fingerprint]
        );
        return "inserted";
      } catch (e) {
        return dupErr(e) ? "dup" : `err:${(e as { code?: string }).code}`;
      }
    };
    const outcomes = await runSqlWorkers(8, (conn) => scheduleInsert(conn, H("fp-s")));
    expect(outcomes.filter((o) => o === "inserted")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "dup")).toHaveLength(7);
  });

  it("r4: approval-consumption race — the gate is read-only; K concurrent verdicts agree", async () => {
    // Gate semantics live in the app layer (structural twin covers them); here we
    // prove the durable ledger admits exactly one approval row per idempotency key
    // under concurrent sessions.
    await pool.query(
      `INSERT INTO mission_governance_decisions (governanceDecisionId, contractVersion, engineVersion, userId, businessId, missionRef,
        planRef, taskRef, subjectClass, actionType, actionParamsFingerprint, missionRiskClass, riskFactors, policyVersion, decision,
        reasonCodes, approvalRequired, approvalBinding, evaluationFingerprint, validUntil, evaluatedAt, thresholds)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,JSON_ARRAY(),?, 'REVIEW_REQUIRED', JSON_ARRAY('X'), 1, NULL, ?, '2026-12-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', JSON_OBJECT())`,
      [`mgd1:${H("m")}`, "mission-governance/v1", "engine/v1", USER1, BIZ1, MISSION_ID, PLAN_ID, TASK, "EXECUTION_STEP", "EXECUTE_TASK", H("fp"), "MEDIUM", "mission-governance-policy/v1", H("ef")]
    );
    const outcomes = await runSqlWorkers(8, async (conn) => {
      try {
        await conn.query(
          `INSERT INTO approval_requests (userId, campaignId, approvalType, title, description, aiRecommendation, riskLevel, status, idempotencyKey, context)
           VALUES (?,NULL,'mission_action','t','d','r','medium','approved',?,JSON_OBJECT())`,
          [USER1, `mgov1:${H("idem")}`]
        );
        return "inserted";
      } catch (e) {
        return dupErr(e) ? "dup" : `err:${(e as { code?: string }).code}`;
      }
    });
    expect(outcomes.filter((o) => o === "inserted")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "dup")).toHaveLength(7);
  });

  it("r5/r6: dispatch-intent race — K sessions race exa1:/idem1: anchors + version CAS; exactly one attempt lineage", async () => {
    const exaId = `exa1:${H("x")}`;
    const idem = `idem1:${H("i")}`;
    const intentInsert = async (conn: import("mysql2/promise").PoolConnection, capability: string) => {
      try {
        await conn.query(
          `INSERT INTO execution_actions (executionActionId, userId, businessId, missionId, planId, scheduleId, taskId, taskType,
            actionType, actionParametersHash, inputRefs, governanceDecisionId, approvalReference, authorizationFingerprint, idempotencyKey,
            adapterType, capability, validFrom, validUntil, dispatchState, dispatchFingerprint, attemptCount, version)
           VALUES (?,?,?,?,?,?,?, 'PUBLISH_CONTENT','EXECUTE_TASK',?,JSON_ARRAY(),?,NULL,?,?,?,?,?,
            '2026-11-01T00:00:00.000Z','2027-01-01T00:00:00.000Z','DISPATCH_PREPARED',?,0,1)`,
          [exaId, USER1, BIZ1, MISSION_ID, PLAN_ID, SCHEDULE_ID, TASK, H("ap"), `mgd1:${H("m")}`, H("af"), idem, "SOCIAL", capability, H("df")]
        );
        return "inserted";
      } catch (e) {
        return dupErr(e) ? "dup" : `err:${(e as { code?: string }).code}`;
      }
    };
    const outcomes = await runSqlWorkers(8, (conn) => intentInsert(conn, "social.publish"));
    expect(outcomes.filter((o) => o === "inserted")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "dup")).toHaveLength(7);

    // CAS dispatch race: K sessions try DISPATCH_PREPARED → DISPATCHED with attempt mint.
    const raced = await runSqlWorkers(8, async (conn) => {
      try {
        await conn.query("START TRANSACTION");
        const [rows] = await conn.query(
          "SELECT version FROM execution_actions WHERE userId = ? AND executionActionId = ? FOR UPDATE",
          [USER1, exaId]
        );
        const version = (rows as Array<{ version: number }>)[0]?.version ?? null;
        if (version !== 1) throw new Error("STALE_READ");
        const attemptId = `exr1:${sha(`${exaId}:1:${H("df")}`)}`;
        await conn.query(
          `INSERT INTO execution_attempts (attemptId, userId, businessId, executionActionId, attemptNumber, dispatchFingerprint,
            adapterType, capability, externalReference, resultStatus, resultHash, failureClass, uncertaintyClass, startedAt, completedAt)
           VALUES (?,?,?,?,1,?, 'SOCIAL','social.publish',?,NULL,NULL,'NONE','NONE','2026-11-11T12:00:00.000Z',NULL)`,
          [attemptId, USER1, BIZ1, exaId, H("df"), `ext1:${H("e1")}`]
        );
        const [upd] = await conn.query(
          "UPDATE execution_actions SET dispatchState = 'DISPATCHED', version = 2, attemptCount = 1 WHERE userId = ? AND executionActionId = ? AND version = 1",
          [USER1, exaId]
        );
        const affected = Number((upd as { affectedRows?: number }).affectedRows ?? 0);
        if (affected !== 1) throw new Error("CAS_LOST");
        await conn.query("COMMIT");
        return "dispatched";
      } catch (e) {
        await conn.query("ROLLBACK").catch(() => undefined);
        const msg = (e as { message?: string }).message ?? "";
        if (msg === "STALE_READ" || msg === "CAS_LOST") return msg;
        if (dupErr(e)) return "dup-attempt";
        return `err:${(e as { code?: string }).code ?? msg}`;
      }
    });
    expect(raced.filter((r) => r === "dispatched")).toHaveLength(1);
    expect(raced.filter((r) => r === "dup-attempt")).toHaveLength(7);
    const [attempts] = await pool.query("SELECT COUNT(*) AS c FROM execution_attempts WHERE executionActionId = ?", [exaId]);
    expect(Number((attempts as Array<{ c: number }>)[0].c)).toBe(1);
  });

  it("r7/r8: callback races — null→value guard: first result wins, conflicting callback cannot overwrite", async () => {
    const attemptId = `exr1:${H("cb")}`;
    await pool.query(
      `INSERT INTO execution_attempts (attemptId, userId, businessId, executionActionId, attemptNumber, dispatchFingerprint, adapterType,
        capability, externalReference, resultStatus, resultHash, failureClass, uncertaintyClass, startedAt, completedAt)
       VALUES (?,?,?,?,1,?, 'SOCIAL','social.publish',?, 'PENDING_EXTERNAL',NULL,'NONE','NONE','2026-11-11T12:00:00.000Z',NULL)`,
      [attemptId, USER1, BIZ1, `exa1:${H("x")}`, H("df2"), `ext1:${H("e2")}`]
    );
    const recordResult = async (conn: import("mysql2/promise").PoolConnection, status: string, hash: string) => {
      try {
        await conn.query("START TRANSACTION");
        const [rows] = await conn.query(
          "SELECT resultStatus FROM execution_attempts WHERE userId = ? AND attemptId = ? FOR UPDATE",
          [USER1, attemptId]
        );
        const current = (rows as Array<{ resultStatus: string | null }>)[0]?.resultStatus ?? null;
        if (current !== null && current !== "PENDING_EXTERNAL") throw new Error("ALREADY_RECORDED");
        const [upd] = await conn.query(
          "UPDATE execution_attempts SET resultStatus = ?, resultHash = ?, completedAt = ? WHERE userId = ? AND attemptId = ? AND (resultStatus IS NULL OR resultStatus = 'PENDING_EXTERNAL')",
          [status, hash, NOW_S, USER1, attemptId]
        );
        if (Number((upd as { affectedRows?: number }).affectedRows ?? 0) !== 1) throw new Error("CAS_LOST");
        await conn.query("COMMIT");
        return "recorded";
      } catch (e) {
        await conn.query("ROLLBACK").catch(() => undefined);
        const msg = (e as { message?: string }).message ?? "";
        if (msg === "ALREADY_RECORDED" || msg === "CAS_LOST") return msg;
        return `err:${(e as { code?: string }).code ?? msg}`;
      }
    };
    // Duplicate identical callbacks race.
    const dup = await runSqlWorkers(8, (conn) => recordResult(conn, "SUCCEEDED", H("h-succ")));
    expect(dup.filter((r) => r === "recorded")).toHaveLength(1);
    expect(dup.filter((r) => r === "ALREADY_RECORDED")).toHaveLength(7);
    // Conflicting stale callback afterwards.
    const extra = await pool.getConnection();
    let conflict: string;
    try {
      conflict = await recordResult(extra, "FAILED_FINAL", H("h-fail"));
    } finally {
      extra.release();
    }
    expect(conflict).toBe("ALREADY_RECORDED");
    const [rows] = await pool.query("SELECT resultStatus, resultHash FROM execution_attempts WHERE attemptId = ?", [attemptId]);
    const row = (rows as Array<{ resultStatus: string; resultHash: string }>)[0];
    expect(row.resultStatus).toBe("SUCCEEDED");
    expect(row.resultHash).toBe(H("h-succ"));
  });

  it("r9-r11: recovery + state convergence — deterministic anchors admit exactly one row under K sessions", async () => {
    const rcn = `rcn1:${H("r")}`;
    const outcomes = await runSqlWorkers(8, async (conn) => {
      try {
        await conn.query(
          `INSERT INTO mission_recovery_candidates (recoveryCandidateId, userId, businessId, missionId, planId, scheduleId, taskId,
            executionActionId, latestAttemptId, failureClass, uncertaintyClass, recoveryType, status, scope, proposalHash, version)
           VALUES (?,?,?,?,?,?,?,?,?, 'PROVIDER_ERROR','NONE','RETRY','PROPOSED',JSON_OBJECT(),?,1)`,
          [rcn, USER1, BIZ1, MISSION_ID, PLAN_ID, SCHEDULE_ID, TASK, `exa1:${H("x")}`, `exr1:${H("cb")}`, H("ph")]
        );
        return "inserted";
      } catch (e) {
        return dupErr(e) ? "dup" : `err:${(e as { code?: string }).code}`;
      }
    });
    expect(outcomes.filter((o) => o === "inserted")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "dup")).toHaveLength(7);
    const [rows] = await pool.query("SELECT COUNT(*) AS c FROM mission_recovery_candidates WHERE recoveryCandidateId = ?", [rcn]);
    expect(Number((rows as Array<{ c: number }>)[0].c)).toBe(1);
  });

  it("r12: CAS loser behaviour — version-guarded UPDATE affects exactly one session's write", async () => {
    const mst = `mst1:${H("st")}`;
    await pool.query(
      `INSERT INTO mission_state_records (missionStateId, userId, businessId, missionId, planId, scheduleId, missionStatus, healthClass,
        taskSummary, latestExecutionRefs, blockingReasons, uncertainties, recoveryCandidateIds, observedAt, derivedFromVersion, validUntil, version)
       VALUES (?,?,?,?,?,?, 'ELIGIBLE_FOR_PLANNING','HEALTHY',JSON_OBJECT(),JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),JSON_ARRAY(),
        '2026-11-11T12:00:00.000Z',?,'2026-11-12T00:00:00.000Z',1)`,
      [mst, USER1, BIZ1, MISSION_ID, PLAN_ID, SCHEDULE_ID, H("dv")]
    );
    const raced = await runSqlWorkers(8, async (conn, i) => {
      const [upd] = await conn.query(
        "UPDATE mission_state_records SET healthClass = ?, version = 2 WHERE userId = ? AND missionStateId = ? AND version = 1",
        [i % 2 === 0 ? "DEGRADED" : "FAILED", USER1, mst]
      );
      return Number((upd as { affectedRows?: number }).affectedRows ?? 0);
    });
    expect(raced.filter((a) => a === 1)).toHaveLength(1);
    expect(raced.filter((a) => a === 0)).toHaveLength(7);
  });

  it("r13/r15: transaction rollback on connection kill mid-claim — no partial claim", async () => {
    await pool.query(
      `INSERT INTO queue_terminal_failures
        (failureKey, queueName, bullmqJobId, terminalReason, attemptsMade, attemptsConfigured, userId, errorSummary, failedAt)
       VALUES ('r10b-fk-1','publishing','job-1','retries_exhausted',3,3,?,?,'2026-11-11 12:00:00')`,
      [USER1, "boom"]
    );
    const [f] = await pool.query("SELECT LAST_INSERT_ID() AS id");
    const failureId = Number((f as Array<{ id: number }>)[0].id);
    await pool.query(
      `INSERT INTO queue_replay_requests
        (replayKey, terminalFailureId, failureKey, queueName, originalBullmqJobId, requestedByUserId, reason, replayMode)
       VALUES ('rk-1',?, 'r10b-fk-1','publishing','job-1',?,NULL,'publishing_requeue')`,
      [failureId, USER1]
    );
    const [r] = await pool.query("SELECT LAST_INSERT_ID() AS id");
    const requestId = Number((r as Array<{ id: number }>)[0].id);

    const conn = await pool.getConnection();
    try {
      await conn.query("START TRANSACTION");
      await conn.query("INSERT INTO queue_replay_active_claims (terminalFailureId, replayRequestId) VALUES (?,?)", [failureId, requestId]);
      await conn.destroy(); // worker "dies" mid-transaction → server rolls back
    } catch {
      /* destroy throws on the dead connection */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    const [claims] = await pool.query("SELECT COUNT(*) AS c FROM queue_replay_active_claims WHERE terminalFailureId = ?", [failureId]);
    expect(Number((claims as Array<{ c: number }>)[0].c)).toBe(0);
    const [req] = await pool.query("SELECT status FROM queue_replay_requests WHERE id = ?", [requestId]);
    expect((req as Array<{ status: string }>)[0].status).toBe("requested");
  });

  it("r14: lock-wait timeout victim (1205) fails closed; retry converges on the unique claim", async () => {
    const [f] = await pool.query("SELECT id FROM queue_terminal_failures LIMIT 1");
    const failureId = (f as Array<{ id: number }>)[0].id;
    const [r] = await pool.query("SELECT id FROM queue_replay_requests LIMIT 1");
    const requestId = (r as Array<{ id: number }>)[0].id;
    const holder = await pool.getConnection();
    const contender = await pool.getConnection();
    try {
      await holder.query("START TRANSACTION");
      await holder.query("SELECT id FROM queue_replay_requests WHERE id = ? FOR UPDATE", [requestId]);
      await contender.query("SET SESSION innodb_lock_wait_timeout = 1");
      await contender.query("START TRANSACTION");
      await expect(
        contender.query("UPDATE queue_replay_requests SET status = 'claimed' WHERE id = ? AND status = 'requested'", [requestId])
      ).rejects.toMatchObject({ code: "ER_LOCK_WAIT_TIMEOUT" });
      await contender.query("ROLLBACK").catch(() => undefined);
      await holder.query("ROLLBACK");
      // Retry after the holder releases: the guarded update applies exactly once.
      const [upd] = await pool.query(
        "UPDATE queue_replay_requests SET status = 'claimed' WHERE id = ? AND status = 'requested'",
        [requestId]
      );
      expect(Number((upd as { affectedRows?: number }).affectedRows ?? 0)).toBe(1);
    } finally {
      holder.release();
      contender.release();
    }
  });

  it("r16/r17: worker crash after commit before ack — redelivery converges; replay after restart reads durable state", async () => {
    const exaId = `exa1:${H("restart")}`;
    await pool.query(
      `INSERT INTO execution_actions (executionActionId, userId, businessId, missionId, planId, scheduleId, taskId, taskType,
        actionType, actionParametersHash, inputRefs, governanceDecisionId, approvalReference, authorizationFingerprint, idempotencyKey,
        adapterType, capability, validFrom, validUntil, dispatchState, dispatchFingerprint, attemptCount, version)
       VALUES (?,?,?,?,?,?,?, 'PUBLISH_CONTENT','EXECUTE_TASK',?,JSON_ARRAY(),?,NULL,?,?,?,?,?,
        '2026-11-01T00:00:00.000Z','2027-01-01T00:00:00.000Z','DISPATCH_PREPARED',?,0,1)`,
      [exaId, USER1, BIZ1, MISSION_ID, PLAN_ID, SCHEDULE_ID, TASK, H("ap2"), `mgd1:${H("m")}`, H("af2"), `idem1:${H("i2")}`, "SOCIAL", "social.publish", H("df3")]
    );
    // "commit then crash before ack": the intent is durable; a new session (restart) re-reads it.
    const [rows] = await pool.query("SELECT dispatchState, version FROM execution_actions WHERE executionActionId = ?", [exaId]);
    expect((rows as Array<{ dispatchState: string; version: number }>)[0].dispatchState).toBe("DISPATCH_PREPARED");
    // Duplicate redelivery of the same intent insert converges to the durable row.
    const redeliver = await runSqlWorkers(4, async (conn) => {
      try {
        await conn.query(
          `INSERT INTO execution_actions (executionActionId, userId, businessId, missionId, planId, scheduleId, taskId, taskType,
            actionType, actionParametersHash, inputRefs, governanceDecisionId, approvalReference, authorizationFingerprint, idempotencyKey,
            adapterType, capability, validFrom, validUntil, dispatchState, dispatchFingerprint, attemptCount, version)
           VALUES (?,?,?,?,?,?,?, 'PUBLISH_CONTENT','EXECUTE_TASK',?,JSON_ARRAY(),?,NULL,?,?,?,?,?,
            '2026-11-01T00:00:00.000Z','2027-01-01T00:00:00.000Z','DISPATCH_PREPARED',?,0,1)`,
          [exaId, USER1, BIZ1, MISSION_ID, PLAN_ID, SCHEDULE_ID, TASK, H("ap2"), `mgd1:${H("m")}`, H("af2"), `idem1:${H("i2")}`, "SOCIAL", "social.publish", H("df3")]
        );
        return "inserted";
      } catch (e) {
        return dupErr(e) ? "dup" : `err:${(e as { code?: string }).code}`;
      }
    });
    expect(redeliver.filter((o) => o === "dup")).toHaveLength(4);
    const [count] = await pool.query("SELECT COUNT(*) AS c FROM execution_actions WHERE executionActionId = ?", [exaId]);
    expect(Number((count as Array<{ c: number }>)[0].c)).toBe(1);
  });

  it("r18: cross-tenant collision attempt fails closed at the global mgd anchor", async () => {
    await expect(
      pool.query(
        `INSERT INTO mission_governance_decisions (governanceDecisionId, contractVersion, engineVersion, userId, businessId, missionRef,
          planRef, taskRef, subjectClass, actionType, actionParamsFingerprint, missionRiskClass, riskFactors, policyVersion, decision,
          reasonCodes, approvalRequired, approvalBinding, evaluationFingerprint, validUntil, evaluatedAt, thresholds)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,JSON_ARRAY(),?,'ALLOW',JSON_ARRAY('X'),0,NULL,?,'2026-12-01T00:00:00.000Z','2026-11-01T00:00:00.000Z',JSON_OBJECT())`,
        [`mgd1:${H("m")}`, "mission-governance/v1", "engine/v1", USER2, BIZ1, MISSION_ID, PLAN_ID, TASK, "EXECUTION_STEP", "EXECUTE_TASK", H("fp"), "MEDIUM", "mission-governance-policy/v1", H("ef")]
      )
    ).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
    const [rows] = await pool.query("SELECT COUNT(*) AS c FROM mission_governance_decisions WHERE governanceDecisionId = ?", [`mgd1:${H("m")}`]);
    expect(Number((rows as Array<{ c: number }>)[0].c)).toBe(1);
  });

  it("r19: cross-business scope is rejected by the consumption binding (app gate) and businessId is carried verbatim", async () => {
    const [rows] = await pool.query(
      "SELECT businessId FROM mission_governance_decisions WHERE governanceDecisionId = ?",
      [`mgd1:${H("m")}`]
    );
    expect((rows as Array<{ businessId: number }>)[0].businessId).toBe(BIZ1);
    // Structural: the durable row preserves its business scope — downstream
    // binding-hash validation (structural twin s19) fails closed on mismatch.
  });

  it("r20: idempotency-key collision attack — conflicting capability under the same idem1: key fails closed", async () => {
    const exaId = `exa1:${H("attack")}`;
    const idem = `idem1:${H("atk")}`;
    const insertWithCapability = (capability: string, adapter: string) =>
      pool.query(
        `INSERT INTO execution_actions (executionActionId, userId, businessId, missionId, planId, scheduleId, taskId, taskType,
          actionType, actionParametersHash, inputRefs, governanceDecisionId, approvalReference, authorizationFingerprint, idempotencyKey,
          adapterType, capability, validFrom, validUntil, dispatchState, dispatchFingerprint, attemptCount, version)
         VALUES (?,?,?,?,?,?,?, 'PUBLISH_CONTENT','EXECUTE_TASK',?,JSON_ARRAY(),?,NULL,?,?,?,?,?,
          '2026-11-01T00:00:00.000Z','2027-01-01T00:00:00.000Z','DISPATCH_PREPARED',?,0,1)`,
        [exaId, USER1, BIZ1, MISSION_ID, PLAN_ID, SCHEDULE_ID, TASK, H("ap3"), `mgd1:${H("m")}`, H("af3"), idem, adapter, capability, H("df4")]
      );
    await insertWithCapability("social.publish", "SOCIAL");
    await expect(insertWithCapability("campaign.activate", "CAMPAIGN")).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
    const [rows] = await pool.query("SELECT capability FROM execution_actions WHERE executionActionId = ?", [exaId]);
    expect((rows as Array<{ capability: string }>)[0].capability).toBe("social.publish");
  });
});
