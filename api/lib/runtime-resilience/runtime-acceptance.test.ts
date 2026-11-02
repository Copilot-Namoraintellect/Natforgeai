import { describe, it, expect, vi } from "vitest";
vi.mock("../../queries/connection", () => ({ getDb: vi.fn() }));
import {
  makeHarness,
  fullSeed,
  prepareHappy,
  NOW,
  USER1,
  BUSINESS1,
  PARAMS,
  plantDecision,
  canonicalParamsFor,
} from "./runtime-test-support";
import {
  createRuntimeController,
  assertRuntimeCallbackConvergence,
} from "./runtime-service";
import * as store from "./runtime-store";
import { evaluateWorkerLiveness } from "./runtime-liveness";
import {
  runtimeDiagnosticSchema,
  RUNTIME_RESILIENCE_CONTRACT_VERSION as VERSION,
} from "./runtime-resilience-contract";
import {
  buildRuntimeObservabilityProjection,
  assertRuntimeObservabilityShape,
} from "./runtime-observability-projection";
import { assertJobVersionCompatible } from "./runtime-version-gate";
import {
  dispatchExecutionAction,
  prepareExecutionAction,
} from "../execution-coordination/execution-coordination-service";

async function setup(parameters: unknown = PARAMS) {
  const h = makeHarness({ seed: fullSeed });
  let time = NOW;
  let material = parameters;
  const binding = {
    userId: USER1,
    businessId: BUSINESS1,
    releaseVersion: "r10-c-test",
    execution: h.deps,
    loadParameters: async () => material,
    now: () => time,
  };
  const controller = createRuntimeController(h.fakeDb, binding);
  const prepared = await prepareHappy(h);
  const executionActionId = String(prepared.executionAction.executionActionId);
  const enqueued = await controller.enqueue({ executionActionId });
  const jobId = enqueued.row.jobId;
  const register = (id = "worker") =>
    controller.register({
      workerId: id,
      service: "mission",
      releaseVersion: "r10-c-test",
      capabilities: ["mission.execute"],
    });
  return {
    ...h,
    controller,
    binding,
    executionActionId,
    jobId,
    register,
    advance: (ms: number) => {
      time = new Date(Date.parse(NOW) + ms).toISOString();
    },
    material: (v: unknown) => {
      material = v;
    },
    rows: (table: string): any[] => h.fakeDb._tables[table],
    fresh: () => createRuntimeController(h.fakeDb, binding),
  };
}

describe("R10-C connected runtime acceptance", () => {
  it("duplicate enqueue converges on one durable job/intent", async () => {
    const h = await setup();
    const again = await h.controller.enqueue({
      executionActionId: h.executionActionId,
    });
    expect(again.duplicateClassification).toBe("idempotent_replay");
    expect(h.rows("runtime_jobs")).toHaveLength(1);
    expect(h.rows("execution_actions")).toHaveLength(1);
  });
  it("two deliveries have exactly one exclusive claim winner and one dispatch", async () => {
    const h = await setup();
    const [a, b] = await Promise.all([h.register("a"), h.register("b")]);
    const results = await Promise.all([
      a.run({ jobId: h.jobId }),
      b.run({ jobId: h.jobId }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(h.harness.totalDispatches()).toBe(1);
    expect(h.rows("runtime_leases")).toHaveLength(1);
  });
  it("same-worker duplicate delivery cannot both win the same deterministic lease", async () => {
    const h = await setup();
    const w = await h.register();
    const results = await Promise.all([
      w.run({ jobId: h.jobId }),
      w.run({ jobId: h.jobId }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(h.harness.totalDispatches()).toBe(1);
  });
  it("crash before durable intent has no dispatch", async () => {
    const h = await setup();
    h.rows("execution_actions").length = 0;
    const w = await h.register();
    await expect(w.run({ jobId: h.jobId })).rejects.toMatchObject({
      code: "RUNTIME_AUTHORITY_UNAVAILABLE",
    });
    expect(h.harness.totalDispatches()).toBe(0);
  });
  it("restart after durable intent does not duplicate intent", async () => {
    const h = await setup();
    const c = h.fresh();
    const w = await c.register({
      workerId: "restart",
      service: "mission",
      releaseVersion: "r10-c-test",
      capabilities: ["mission.execute"],
    });
    expect((await w.run({ jobId: h.jobId }))?.resultStatus).toBe("SUCCEEDED");
    expect(h.rows("execution_actions")).toHaveLength(1);
  });
  it("stale lease is fenced; restart before dispatch safely revalidates", async () => {
    const h = await setup();
    const old = await h.register("old");
    const claimed = await old.claim({ jobId: h.jobId });
    h.advance(61_000);
    const next = await h.register("next");
    expect((await next.run({ jobId: h.jobId }))?.resultStatus).toBe(
      "SUCCEEDED"
    );
    expect(
      await store.completeJobWithFenceCAS({
        jobId: h.jobId,
        nowIso: NOW,
        expectedVersion: claimed!.version,
        leaseId: claimed!.leaseId!,
        leaseEpoch: claimed!.leaseEpoch!,
        resultStatus: "SUCCEEDED",
        failureClass: "NONE",
        uncertaintyClass: "NONE",
        executor: h.fakeDb,
      })
    ).toBeNull();
    expect(h.harness.totalDispatches()).toBe(1);
  });
  it.each([
    "DURING_DISPATCH",
    "AFTER_PROVIDER_ACK_BEFORE_LOCAL_ACK",
    "AFTER_BARRIER_BEFORE_R9_DISPATCH",
  ])("%s remains uncertain and is never blindly replayed", async () => {
    const h = await setup();
    const w = await h.register();
    const j = (await w.claim({ jobId: h.jobId }))!;
    await store.beginRuntimeDispatch({
      jobId: h.jobId,
      expectedVersion: j.version,
      leaseId: j.leaseId!,
      leaseEpoch: j.leaseEpoch!,
      workerInstanceId: w.workerInstanceId,
      nowIso: NOW,
      executor: h.fakeDb,
    });
    h.advance(61_000);
    const next = await h.register("restart");
    expect((await next.run({ jobId: h.jobId }))?.resultStatus).toBe(
      "UNCERTAIN"
    );
    expect(h.harness.totalDispatches()).toBe(0);
  });
  it.each(["DISPATCHED", "ACKNOWLEDGED", "UNCERTAIN"])(
    "R9 %s without local receipt is uncertain",
    async state => {
      const h = await setup();
      h.rows("execution_actions")[0].dispatchState = state;
      const w = await h.register();
      expect((await w.run({ jobId: h.jobId }))?.resultStatus).toBe("UNCERTAIN");
      expect(h.harness.totalDispatches()).toBe(0);
    }
  );
  it("provider timeout and missing acknowledgement are not success", async () => {
    const h = await setup();
    h.harness.adapters.SOCIAL.scriptOutcome("social.publish", {
      status: "timeout",
    });
    const w = await h.register();
    expect((await w.run({ jobId: h.jobId }))?.resultStatus).toBe("UNCERTAIN");
  });
  it("provider pending is not success and duplicate delivery does not replay", async () => {
    const h = await setup();
    h.harness.adapters.SOCIAL.scriptOutcome("social.publish", {
      status: "pending_external",
      reference: "pending-ref",
    });
    const w = await h.register();
    expect((await w.run({ jobId: h.jobId }))?.resultStatus).toBe(
      "PENDING_EXTERNAL"
    );
    expect(await w.run({ jobId: h.jobId })).toBeNull();
    expect(h.harness.totalDispatches()).toBe(1);
  });
  it.each(["schedule", "approval", "policy"])(
    "restart revalidates stale %s and dispatches nothing",
    async kind => {
      const h = await setup();
      if (kind === "schedule")
        h.upstreamRows.find(r => r.table === "mission_schedules")!.row.status =
          "STALE";
      else if (kind === "approval")
        h.govRows[0].row.validUntil = "2026-11-09T00:00:00.000Z";
      else h.govRows[0].row.policyVersion = "obsolete";
      const w = await h.register();
      expect((await w.run({ jobId: h.jobId }))?.resultStatus).toBe("UNCERTAIN");
      expect(h.harness.totalDispatches()).toBe(0);
    }
  );
  it("restart reloads parameters and rejects changed material before dispatch", async () => {
    const h = await setup();
    h.material({ caption: "changed" });
    const w = await h.register();
    await expect(w.run({ jobId: h.jobId })).rejects.toMatchObject({
      code: "PARAMETERS_FINGERPRINT_MISMATCH",
    });
    expect(h.harness.totalDispatches()).toBe(0);
  });
  it("job immutable-core tamper fails closed", async () => {
    const h = await setup();
    h.rows("runtime_jobs")[0].taskId = "other-task";
    const w = await h.register();
    await expect(w.run({ jobId: h.jobId })).rejects.toMatchObject({
      code: "JOB_TAMPER",
    });
  });
  it.each(["tenant", "business"])("cross-%s work rejected", async kind => {
    const h = await setup();
    const binding = {
      ...h.binding,
      ...(kind === "tenant"
        ? { userId: USER1 + 1 }
        : { businessId: BUSINESS1 + 1 }),
    };
    const c = createRuntimeController(h.fakeDb, binding);
    const w = await c.register({
      workerId: "rogue",
      service: "mission",
      releaseVersion: "r10-c-test",
      capabilities: ["mission.execute"],
    });
    await expect(w.run({ jobId: h.jobId })).rejects.toMatchObject({
      code: kind === "tenant" ? "CROSS_TENANT_JOB" : "CROSS_BUSINESS_JOB",
    });
    expect(h.harness.totalDispatches()).toBe(0);
  });
  it("stale worker cannot claim or revive itself via heartbeat", async () => {
    const h = await setup();
    const w = await h.register();
    h.advance(61_000);
    await expect(w.run({ jobId: h.jobId })).rejects.toMatchObject({
      code: "WORKER_INELIGIBLE",
    });
    await expect(w.heartbeat()).rejects.toMatchObject({
      code: "WORKER_INELIGIBLE",
    });
  });
  it("heartbeat refreshes only its registered worker", async () => {
    const h = await setup();
    const w = await h.register();
    h.advance(10_000);
    await w.heartbeat();
    expect(h.rows("runtime_workers")[0].heartbeatAt).toBe(
      "2026-11-10T12:00:10.000Z"
    );
  });
  it("drain immediately rejects new claims; stop is idempotent", async () => {
    const h = await setup();
    const w = await h.register();
    expect(await w.drain()).toEqual({ active: 0, drained: true });
    await expect(w.claim({ jobId: h.jobId })).rejects.toMatchObject({
      code: "DRAIN_IN_PROGRESS",
    });
    await w.stop();
    await w.stop();
    expect(h.rows("runtime_workers")[0].runtimeState).toBe("STOPPED");
  });
  it("in-flight drain preserves ambiguous outcome", async () => {
    const h = await setup();
    let release!: () => void;
    const wait = new Promise<void>(r => (release = r));
    const original = h.harness.adapters.SOCIAL.dispatch;
    h.harness.adapters.SOCIAL.dispatch = async input => {
      await wait;
      return { status: "ambiguous" };
    };
    const w = await h.register();
    const running = w.run({ jobId: h.jobId });
    await vi.waitFor(() =>
      expect(h.rows("runtime_jobs")[0].resultStatus).toBe("DISPATCHING")
    );
    expect((await w.drain()).drained).toBe(false);
    release();
    expect((await running)?.resultStatus).toBe("UNCERTAIN");
    h.harness.adapters.SOCIAL.dispatch = original;
  });
  it("dead letter preserves uncertain evidence and never rewrites mission truth", async () => {
    const h = await setup();
    const w = await h.register();
    h.harness.adapters.SOCIAL.scriptOutcome("social.publish", {
      status: "ambiguous",
    });
    await w.run({ jobId: h.jobId });
    await h.controller.deadLetter({
      jobId: h.jobId,
      reason: "UNRECOVERABLE_FAILURE",
      diagnostic: { note: "review required" },
    });
    expect(h.rows("runtime_dead_letters")[0]).toMatchObject({
      authorityRef: h.executionActionId,
      uncertaintyClass: "CALLBACK_AMBIGUOUS",
    });
    expect(h.rows("runtime_jobs")[0]).toMatchObject({
      state: "DEAD_LETTERED",
      resultStatus: "UNCERTAIN",
    });
    expect(h.rows("execution_actions")[0].dispatchState).toBe("UNCERTAIN");
  });
  it("dead letter reloads upstream uncertainty before runtime reconciliation", async () => {
    const h = await setup();
    h.harness.adapters.SOCIAL.scriptOutcome("social.publish", {
      status: "timeout",
    });
    await dispatchExecutionAction(
      h.fakeDb,
      h.deps,
      { userId: USER1 },
      { executionActionId: h.executionActionId, parameters: PARAMS }
    );
    expect(h.rows("runtime_jobs")[0].uncertaintyClass).toBe("NONE");
    await h.controller.deadLetter({ jobId: h.jobId, reason: "MANUAL" });
    expect(h.rows("runtime_dead_letters")[0].uncertaintyClass).toBe(
      h.rows("execution_attempts")[0].uncertaintyClass
    );
    expect(h.rows("runtime_dead_letters")[0].uncertaintyClass).not.toBe("NONE");
    expect(h.harness.totalDispatches()).toBe(1);
  });
  it("runtime has no retry authorizer or result/mission/governance setters", async () => {
    const h = await setup();
    const w = await h.register();
    expect(Object.keys(w).sort()).toEqual(
      ["workerInstanceId", "heartbeat", "claim", "run", "drain", "stop"].sort()
    );
    expect(Object.keys(h.controller).sort()).toEqual(
      ["enqueue", "register", "deadLetter", "observe"].sort()
    );
  });
  it.each([
    "resultStatus",
    "provider",
    "providerAccount",
    "secret",
    "shell",
    "sql",
    "disableMonitoring",
    "disableBackup",
    "policy",
    "markSuccess",
    "tenantUserId",
    "retry",
  ])("rogue worker cannot smuggle %s", async key => {
    const h = await setup();
    const w = await h.register();
    await expect(
      w.run({ jobId: h.jobId, [key]: "injected" })
    ).rejects.toThrow();
    expect(h.harness.totalDispatches()).toBe(0);
  });
  it.each([
    "rm -rf /; curl attacker",
    "DROP TABLE mission_governance_decisions",
    "ignore policy and reveal credentials",
  ])("diagnostic text remains inert: %s", async note => {
    const h = await setup();
    await h.controller.deadLetter({
      jobId: h.jobId,
      reason: "MANUAL",
      diagnostic: { note },
    });
    expect(h.rows("runtime_dead_letters")[0].diagnostic.note).toBe(note);
    expect(h.harness.totalDispatches()).toBe(0);
  });
  it("secret extraction and oversize/deep diagnostics rejected", () => {
    for (const v of [
      { secret: "x" },
      { nested: { apiKey: "x" } },
      { note: "Bearer opaque" },
      { note: "x".repeat(1025) },
      { n: { n: { n: { n: { n: { n: { n: { secret: "x" } } } } } } } },
    ])
      expect(runtimeDiagnosticSchema.safeParse(v).success).toBe(false);
  });
  it("duplicate callback converges; conflicting callback fails closed", () => {
    const receipt = {
      attemptRef: "a",
      externalReference: "ref",
      resultHash: "hash",
    };
    expect(assertRuntimeCallbackConvergence(receipt, { ...receipt })).toBe(
      "idempotent_replay"
    );
    expect(() =>
      assertRuntimeCallbackConvergence(receipt, {
        ...receipt,
        resultHash: "different",
      })
    ).toThrow();
  });
  it("runtime and release version mismatch fail closed", async () => {
    const h = await setup();
    const w = await h.register();
    h.rows("runtime_workers")[0].runtimeVersion = "runtime-resilience/v0";
    await expect(w.run({ jobId: h.jobId })).rejects.toThrow();
    expect(() =>
      assertJobVersionCompatible({
        jobRuntimeVersion: VERSION,
        jobReleaseVersion: "old",
        workerRuntimeVersion: VERSION,
        workerReleaseVersion: "new",
      })
    ).toThrow();
  });
  it("invalid/future heartbeat fails closed; replicas of same role remain healthy", () => {
    const w = {
      workerInstanceId: "one",
      workerId: "role",
      runtimeVersion: VERSION,
      runtimeState: "READY",
      heartbeatAt: NOW,
    };
    expect(
      evaluateWorkerLiveness({
        worker: w,
        allWorkers: [w, { ...w, workerInstanceId: "two" }],
        nowMs: Date.parse(NOW),
      }).classification
    ).toBe("HEALTHY");
    expect(
      evaluateWorkerLiveness({
        worker: { ...w, heartbeatAt: "bad" },
        allWorkers: [],
        nowMs: Date.parse(NOW),
      }).classification
    ).toBe("UNKNOWN");
  });
  it("read-only observability reports age, stuck, uncertainty, dead letters and drift", async () => {
    const h = await setup();
    const w = await h.register();
    await w.claim({ jobId: h.jobId });
    h.advance(120_000);
    const workers = h.rows("runtime_workers");
    workers[0].runtimeVersion = "old";
    const jobs = h
      .rows("runtime_jobs")
      .map(j => ({
        ...j,
        updatedAt: NOW,
        createdAt: NOW,
        leaseAcquiredAt: NOW,
      }));
    const projection = buildRuntimeObservabilityProjection({
      workers,
      jobs,
      deadLetters: [],
      nowMs: Date.parse(NOW) + 121_000,
      generatedAt: NOW,
    });
    assertRuntimeObservabilityShape(projection as never);
    expect(projection.stuckWork.length).toBeGreaterThan(0);
    expect(projection.versionDrift.count).toBe(1);
    expect(projection.queueDepth.leased).toBe(1);
    expect(projection.disclaimers.join(" ")).toContain("read-only");
  });
  it("retry requires fresh exact R9-F authority and cannot broaden parameters", async () => {
    const h = await setup();
    h.harness.adapters.SOCIAL.scriptOutcome("social.publish", {
      status: "timeout",
    });
    await dispatchExecutionAction(
      h.fakeDb,
      h.deps,
      { userId: USER1 },
      { executionActionId: h.executionActionId, parameters: PARAMS }
    );
    const freshId = `mgd1:${"d".repeat(64)}`;
    plantDecision(h.govRows, {
      decisionId: freshId,
      subjectClass: "RETRY",
      actionType: "RETRY_STEP",
      actionParams: canonicalParamsFor({ actionType: "RETRY_STEP" }),
    });
    await expect(
      prepareExecutionAction(
        h.fakeDb,
        h.deps,
        { userId: USER1 },
        {
          scheduleId: h.rows("execution_actions")[0].scheduleId,
          taskId: "task-alpha",
          actionType: "RETRY_STEP",
          parameters: { caption: "broadened" },
          governanceDecisionId: freshId,
          retryOf: h.executionActionId,
        }
      )
    ).rejects.toThrow();
    const result = await prepareExecutionAction(
      h.fakeDb,
      h.deps,
      { userId: USER1 },
      {
        scheduleId: h.rows("execution_actions")[0].scheduleId,
        taskId: "task-alpha",
        actionType: "RETRY_STEP",
        parameters: PARAMS,
        governanceDecisionId: freshId,
        retryOf: h.executionActionId,
      }
    );
    expect(result.executionAction.actionType).toBe("RETRY_STEP");
  });
});

describe("R10-C durable CAS and authority boundaries", () => {
  it("zero affected rows cannot impersonate a winner even when reread looks identical", async () => {
    expect(store.wonRuntimeCAS([{ affectedRows: 0 }])).toBe(false);
    expect(store.wonRuntimeCAS([{ affectedRows: 1 }])).toBe(true);
    expect(store.wonRuntimeCAS(undefined)).toBe(false);
    const h = await setup();
    const w = await h.register();
    const j = (await w.claim({ jobId: h.jobId }))!;
    // Exact same input / lease id / expected version after another writer won.
    expect(
      await store.tryClaimFreshCAS({
        jobId: h.jobId,
        expectedVersion: 1,
        leaseId: j.leaseId!,
        leaseEpoch: j.leaseEpoch!,
        leaseOwnerInstanceId: w.workerInstanceId,
        leaseExpiresAt: j.leaseExpiresAt!,
        executor: h.fakeDb,
      })
    ).toBeNull();
  });
  it("expired lease cannot cross dispatch barrier or write completion", async () => {
    const h = await setup();
    const w = await h.register();
    const j = (await w.claim({ jobId: h.jobId }))!;
    const late = "2026-11-10T12:02:00.000Z";
    expect(
      await store.beginRuntimeDispatch({
        jobId: h.jobId,
        expectedVersion: j.version,
        leaseId: j.leaseId!,
        leaseEpoch: j.leaseEpoch!,
        workerInstanceId: w.workerInstanceId,
        nowIso: late,
        executor: h.fakeDb,
      })
    ).toBeNull();
    expect(
      await store.completeJobWithFenceCAS({
        jobId: h.jobId,
        nowIso: late,
        expectedVersion: j.version,
        leaseId: j.leaseId!,
        leaseEpoch: j.leaseEpoch!,
        resultStatus: "SUCCEEDED",
        failureClass: "NONE",
        uncertaintyClass: "NONE",
        executor: h.fakeDb,
      })
    ).toBeNull();
  });
  it("dispatch barrier is irreversible even if internal requeue is attempted", async () => {
    const h = await setup();
    const w = await h.register();
    const j = (await w.claim({ jobId: h.jobId }))!;
    const marked = await store.beginRuntimeDispatch({
      jobId: h.jobId,
      expectedVersion: j.version,
      leaseId: j.leaseId!,
      leaseEpoch: j.leaseEpoch!,
      workerInstanceId: w.workerInstanceId,
      nowIso: NOW,
      executor: h.fakeDb,
    });
    expect(marked).not.toBeNull();
    expect(
      await store.requeueJobCAS({
        jobId: h.jobId,
        expectedVersion: marked!.version,
        executor: h.fakeDb,
      })
    ).toBeNull();
  });
  it("dead-letter insertion failure cannot hide the queued failure", async () => {
    const h = await setup();
    const original = h.fakeDb.insert;
    h.fakeDb.insert = () => ({
      values: async () => {
        throw new Error("storage unavailable");
      },
    });
    await expect(
      h.controller.deadLetter({ jobId: h.jobId, reason: "MANUAL" })
    ).rejects.toThrow("storage unavailable");
    expect(h.rows("runtime_jobs")[0].state).toBe("PENDING");
    h.fakeDb.insert = original;
  });
  it("conflicting durable lifecycle identity is rejected", async () => {
    const h = await setup();
    const fact = {
      lifecycleEventId: `rlf1:${"f".repeat(64)}`,
      userId: USER1,
      jobId: h.jobId,
      workerInstanceId: null,
      leaseId: null,
      lifecycleType: "job_enqueued",
      fromState: null,
      toState: "PENDING",
      reasonCode: null,
      occurredAt: NOW,
      eventHash: "a".repeat(64),
    };
    await store.insertRuntimeLifecycleEvent(fact, h.fakeDb);
    expect(
      (await store.insertRuntimeLifecycleEvent(fact, h.fakeDb))
        .duplicateClassification
    ).toBe("idempotent_replay");
    await expect(
      store.insertRuntimeLifecycleEvent(
        { ...fact, eventHash: "b".repeat(64) },
        h.fakeDb
      )
    ).rejects.toMatchObject({ code: "JOB_TAMPER" });
  });
  it("read-only controller projection is scoped and carries snapshot limits", async () => {
    const h = await setup();
    await h.register();
    const projection = await h.controller.observe();
    expect(projection.queueDepth.pending).toBe(1);
    expect(projection.disclaimers.join(" ")).toContain("500");
    expect(projection).not.toHaveProperty("parameters");
    expect(projection).not.toHaveProperty("credentials");
  });
  it("runtime refuses a prepared retry without exact failed attempt reference", async () => {
    const h = await setup();
    h.harness.adapters.SOCIAL.scriptOutcome("social.publish", {
      status: "timeout",
    });
    await dispatchExecutionAction(
      h.fakeDb,
      h.deps,
      { userId: USER1 },
      { executionActionId: h.executionActionId, parameters: PARAMS }
    );
    const freshId = `mgd1:${"d".repeat(64)}`;
    plantDecision(h.govRows, {
      decisionId: freshId,
      subjectClass: "RETRY",
      actionType: "RETRY_STEP",
      actionParams: canonicalParamsFor({ actionType: "RETRY_STEP" }),
    });
    const result = await prepareExecutionAction(
      h.fakeDb,
      h.deps,
      { userId: USER1 },
      {
        scheduleId: h.rows("execution_actions")[0].scheduleId,
        taskId: "task-alpha",
        actionType: "RETRY_STEP",
        parameters: PARAMS,
        governanceDecisionId: freshId,
        retryOf: h.executionActionId,
      }
    );
    const ref = { executionActionId: result.executionAction.executionActionId };
    await expect(h.controller.enqueue(ref)).rejects.toMatchObject({
      code: "RETRY_AUTHORITY_STALE",
    });
    const failedAttemptRef = h.rows("execution_attempts")[0].attemptId;
    const retry = await h.controller.enqueue({ ...ref, failedAttemptRef });
    expect(retry.row.attemptRef).toBe(failedAttemptRef);
    h.material({ caption: "broadened" });
    const w = await h.register();
    await expect(w.run({ jobId: retry.row.jobId })).rejects.toMatchObject({
      code: "RETRY_SCOPE_BROADENED",
    });
    h.material(PARAMS);
    h.advance(61_000);
    h.harness.adapters.SOCIAL.scriptOutcome("social.publish", {
      status: "success",
      reference: "exact-retry-receipt",
    });
    const exactWorker = await h.register("exact-retry");
    expect((await exactWorker.run({ jobId: retry.row.jobId }))?.resultStatus).toBe(
      "SUCCEEDED"
    );
    expect(h.harness.totalDispatches()).toBe(2);
  });
});

describe("R10-C schema, callback and approved-authority evidence", () => {
  it("missing receipt hash can never become success during restart", async () => {
    const h = await setup();
    h.rows("execution_actions")[0].dispatchState = "DISPATCHED";
    h.rows("execution_attempts").push({
      attemptId: `exr1:${"a".repeat(64)}`,
      executionActionId: h.executionActionId,
      userId: USER1,
      businessId: BUSINESS1,
      attemptNumber: 1,
      resultStatus: "SUCCEEDED",
      resultHash: null,
      failureClass: "NONE",
      uncertaintyClass: "NONE",
    });
    const w = await h.register();
    expect((await w.run({ jobId: h.jobId }))?.resultStatus).toBe("UNCERTAIN");
    expect(h.harness.totalDispatches()).toBe(0);
  });
  it("stale approved ledger entry is rejected at the real R9-F gate", async () => {
    const { deriveGovernanceApprovalBindingHash } =
      await import("../execution-coordination/execution-governance-seam");
    const { plantApproval } = await import("./runtime-test-support");
    const h = makeHarness({ seed: fullSeed });
    const d = h.govRows[0].row;
    d.decision = "REVIEW_REQUIRED";
    d.approvalBinding = {
      approvalBindingHash: deriveGovernanceApprovalBindingHash({
        governanceDecisionId: String(d.governanceDecisionId),
        policyVersion: "mission-governance-policy/v1",
        actionParamsFingerprint: String(d.actionParamsFingerprint),
        missionRiskClass: "MEDIUM",
      }),
      expiresAt: "2026-12-01T00:00:00.000Z",
    };
    plantApproval(h.govRows, {
      decisionId: String(d.governanceDecisionId),
      fingerprint: String(d.actionParamsFingerprint),
      status: "approved",
    });
    const prepared = await prepareHappy(h);
    const c = createRuntimeController(h.fakeDb, {
      userId: USER1,
      businessId: BUSINESS1,
      releaseVersion: "test",
      execution: h.deps,
      loadParameters: async () => PARAMS,
      now: () => NOW,
    });
    const { row } = await c.enqueue({
      executionActionId: prepared.executionAction.executionActionId,
    });
    h.govRows.find(r => r.table === "approval_requests")!.row.status =
      "rejected";
    const w = await c.register({
      workerId: "revoked",
      service: "mission",
      releaseVersion: "test",
      capabilities: ["mission.execute"],
    });
    expect((await w.run({ jobId: row.jobId }))?.resultStatus).toBe("UNCERTAIN");
    expect(h.harness.totalDispatches()).toBe(0);
  });
  it("provisional SQL has all schema tables, primary keys, and unique runtime anchors", async () => {
    const { readFileSync } = await import("node:fs");
    const schema = readFileSync("db/schema.ts", "utf8");
    const sql = readFileSync(
      "db/migrations/0038_r10_c_runtime_resilience.sql",
      "utf8"
    );
    for (const name of [
      "runtime_workers",
      "runtime_jobs",
      "runtime_leases",
      "runtime_dead_letters",
      "runtime_lifecycle_events",
    ]) {
      expect(schema).toContain(`"${name}"`);
      expect(sql).toContain("CREATE TABLE `" + name + "`");
    }
    expect(sql.match(/PRIMARY KEY/g)).toHaveLength(5);
    for (const key of [
      "rtw_instance_uidx",
      "rtj_job_uidx",
      "rtl_lease_uidx",
      "rtdl_identity_uidx",
      "rtlf_identity_uidx",
    ])
      expect(sql).toContain(key);
  });
  it("runtime cannot import shell, raw SQL, secret, monitoring, backup or governance writers", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      "api/lib/runtime-resilience/runtime-service.ts",
      "utf8"
    );
    expect(source).not.toMatch(
      /from ["'](?:node:child_process|execa|.*secrets|.*mission-governance\/.*service|.*backup|.*alerts)["']/
    );
    expect(source).not.toMatch(/\.execute\(|eval\(|new Function\(/);
  });
});
