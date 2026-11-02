/** R10-C server-only envelope. No router, user-supplied result, provider or credential API.
 * Deployment composition creates a worker closure with a fixed tenant/business grant.
 * Only real R9-D services may create/dispatch intents and source execution outcomes.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  RuntimeJobRow,
  ExecutionActionRow,
  ExecutionAttemptRow,
} from "@db/schema";
import { canonicalJson, sha256Hex } from "../conversion/conversion-contract";
import {
  dispatchExecutionAction,
  type ExecutionCoordinationServiceDeps,
} from "../execution-coordination/execution-coordination-service";
import {
  getExecutionActionById,
  getExecutionAttemptById,
  getLatestExecutionAttemptForAction,
} from "../execution-coordination/execution-coordination-store";
import {
  deriveActionParametersHash,
  deriveCanonicalActionParams,
} from "../execution-coordination/execution-coordination-identity";
import {
  RUNTIME_RESILIENCE_CONTRACT_VERSION as VERSION,
  RuntimeResilienceError,
  registerWorkerSchema,
  enqueueRuntimeJobSchema,
  claimRuntimeJobSchema,
  deadLetterRuntimeJobSchema,
} from "./runtime-resilience-contract";
import {
  deriveRuntimeJobId,
  deriveJobFingerprint,
  deriveWorkerInstanceId,
  deriveLeaseId,
  deriveDeadLetterId,
  deriveDeadLetterFingerprint,
} from "./runtime-resilience-identity";
import { evaluateWorkerLiveness, mayWorkerHoldWork } from "./runtime-liveness";
import { assertJobVersionCompatible } from "./runtime-version-gate";
import { buildRuntimeObservabilityProjection } from "./runtime-observability-projection";
import * as store from "./runtime-store";

const jobRef = claimRuntimeJobSchema;
const actionRef = enqueueRuntimeJobSchema;
const deadRef = deadLetterRuntimeJobSchema;
export interface RuntimeBinding {
  readonly userId: number;
  readonly businessId: number;
  readonly releaseVersion: string;
  readonly execution: ExecutionCoordinationServiceDeps;
  /** Must reload exact bounded material from a server-owned source on every invocation. */
  readonly loadParameters: (
    action: Readonly<ExecutionActionRow>
  ) => Promise<unknown>;
  readonly now?: () => string;
}
function receiptState(receipt: ExecutionAttemptRow | null) {
  if (
    receipt &&
    /^[a-f0-9]{64}$/.test(receipt.resultHash ?? "") &&
    [
      "SUCCEEDED",
      "FAILED_RETRYABLE",
      "FAILED_FINAL",
      "PENDING_EXTERNAL",
      "UNCERTAIN",
    ].includes(receipt.resultStatus ?? "")
  ) {
    return {
      resultStatus: receipt.resultStatus!,
      failureClass: receipt.failureClass,
      uncertaintyClass: receipt.uncertaintyClass,
    };
  }
  return {
    resultStatus: "UNCERTAIN",
    failureClass: "INTERNAL",
    uncertaintyClass: "PROVIDER_STATE_UNKNOWN",
  };
}
function deny(
  code: ConstructorParameters<typeof RuntimeResilienceError>[0]
): never {
  throw new RuntimeResilienceError(code, code);
}

/** Trusted composition root only. Not callable by clients, models or queue payloads. */
export function createRuntimeController(
  db: store.RuntimeStoreExecutor,
  binding: RuntimeBinding
) {
  if (
    !Number.isSafeInteger(binding.userId) ||
    binding.userId <= 0 ||
    !Number.isSafeInteger(binding.businessId) ||
    binding.businessId <= 0
  )
    deny("RUNTIME_INPUT_MALFORMED");
  const now = () => {
    const value = (binding.now ?? (() => new Date().toISOString()))();
    if (
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value
    )
      deny("RUNTIME_INPUT_MALFORMED");
    return value;
  };
  const ctx = { userId: binding.userId };
  async function action(id: string) {
    const a = await getExecutionActionById(binding.userId, id, db);
    if (!a) deny("RUNTIME_AUTHORITY_UNAVAILABLE");
    if (a.userId !== binding.userId) deny("CROSS_TENANT_JOB");
    if (a.businessId !== binding.businessId) deny("CROSS_BUSINESS_JOB");
    return a;
  }
  function core(j: RuntimeJobRow) {
    return { ...j, tenantUserId: j.userId };
  }
  async function job(id: string) {
    const j = await store.getRuntimeJobById(id, db);
    if (!j) deny("JOB_NOT_FOUND");
    if (j.userId !== binding.userId) deny("CROSS_TENANT_JOB");
    if (j.businessId !== binding.businessId) deny("CROSS_BUSINESS_JOB");
    if (
      deriveRuntimeJobId(core(j)) !== j.jobId ||
      deriveJobFingerprint(core(j)) !== j.jobFingerprint
    )
      deny("JOB_TAMPER");
    const a = await action(j.authorityRef);
    if (
      a.missionId !== j.missionId ||
      a.planId !== j.planId ||
      a.scheduleId !== j.scheduleId ||
      a.taskId !== j.taskId ||
      a.actionParametersHash !== j.parametersFingerprint
    )
      deny("AUTHORITY_SCOPE_CHANGED");
    return { j, a };
  }
  async function validateRetry(
    a: ExecutionActionRow,
    attemptRef: string | null
  ) {
    if (a.actionType !== "RETRY_STEP") {
      if (attemptRef) deny("RETRY_SCOPE_BROADENED");
      return;
    }
    if (!attemptRef) deny("RETRY_AUTHORITY_STALE");
    const failed = await getExecutionAttemptById(
      binding.userId,
      attemptRef,
      db
    );
    if (
      !failed ||
      failed.businessId !== binding.businessId ||
      !["FAILED_RETRYABLE", "FAILED_FINAL", "UNCERTAIN"].includes(
        failed.resultStatus ?? ""
      )
    )
      deny("RETRY_AUTHORITY_STALE");
    const original = await action(failed.executionActionId);
    const latest = await getLatestExecutionAttemptForAction(
      binding.userId,
      original.executionActionId,
      db
    );
    if (
      latest?.attemptId !== attemptRef ||
      original.governanceDecisionId === a.governanceDecisionId
    )
      deny("RETRY_AUTHORITY_STALE");
    for (const key of [
      "missionId",
      "planId",
      "scheduleId",
      "taskId",
      "adapterType",
      "capability",
    ] as const)
      if (a[key] !== original[key]) deny("RETRY_SCOPE_BROADENED");
    const parameters = await binding.loadParameters(a);
    if (
      deriveActionParametersHash(
        deriveCanonicalActionParams({ ...original, parameters })
      ) !== original.actionParametersHash
    )
      deny("RETRY_SCOPE_BROADENED");
  }
  async function enqueue(raw: unknown) {
    const { executionActionId, failedAttemptRef } = actionRef.parse(raw);
    const a = await action(executionActionId);
    // An action can only exist following R9-D prepare + exact R9-F authorization.
    // Retry actions are prepared by that same authority; runtime never mints retries.
    if (a.dispatchState !== "DISPATCH_PREPARED") deny("JOB_STATE_INVALID");
    await validateRetry(a, failedAttemptRef ?? null);
    const material = {
      tenantUserId: a.userId,
      businessId: a.businessId,
      jobType:
        a.actionType === "RETRY_STEP"
          ? "MISSION_STEP_RETRY"
          : "MISSION_TASK_EXECUTION",
      authorityRef: a.executionActionId,
      missionId: a.missionId,
      planId: a.planId,
      scheduleId: a.scheduleId,
      taskId: a.taskId,
      attemptRef: failedAttemptRef ?? null,
      parametersFingerprint: a.actionParametersHash,
    };
    const jobId = deriveRuntimeJobId(material);
    const versioned = {
      ...material,
      jobId,
      runtimeVersion: VERSION,
      releaseVersion: binding.releaseVersion,
    };
    return store.insertRuntimeJob(
      {
        ...versioned,
        userId: a.userId,
        jobFingerprint: deriveJobFingerprint(versioned),
        notBefore: a.validFrom,
        state: "PENDING",
        leaseId: null,
        leaseOwnerInstanceId: null,
        leaseEpoch: null,
        leaseExpiresAt: null,
        resultStatus: null,
        failureClass: "NONE",
        uncertaintyClass: "NONE",
        version: 1,
      },
      db
    );
  }
  async function deadLetter(raw: unknown) {
    const input = deadRef.parse(raw);
    const { j, a } = await job(input.jobId);
    const receipt = await getLatestExecutionAttemptForAction(
      binding.userId,
      a.executionActionId,
      db
    );
    const occurredAt = now();
    // Evidence first. A crash before state transition leaves visible evidence, never a hidden failure.
    const evidence = {
      jobId: j.jobId,
      jobFingerprint: j.jobFingerprint,
      authorityRef: j.authorityRef,
      attemptRef: receipt?.attemptId ?? j.attemptRef,
      reason: input.reason,
      failureClass: receipt?.failureClass ?? j.failureClass,
      uncertaintyClass:
        j.resultStatus === "DISPATCHING"
          ? "PROVIDER_STATE_UNKNOWN"
          : receipt?.uncertaintyClass ?? j.uncertaintyClass,
      diagnostic: input.diagnostic ?? {},
      occurredAt,
    };
    const result = await store.insertRuntimeDeadLetter(
      {
        ...evidence,
        deadLetterId: deriveDeadLetterId(evidence),
        userId: j.userId,
        businessId: j.businessId,
        jobType: j.jobType,
        deadLetterFingerprint: deriveDeadLetterFingerprint(evidence),
      },
      db
    );
    if (j.state !== "DEAD_LETTERED") {
      const changed = await store.transitionJobStateCAS({
        jobId: j.jobId,
        expectedVersion: j.version,
        fromStates: [j.state],
        toState: "DEAD_LETTERED",
        executor: db,
      });
      if (!changed) deny("CLAIM_LOST");
    }
    return result;
  }
  async function register(raw: unknown) {
    const input = registerWorkerSchema.parse(raw);
    if (
      input.releaseVersion !== binding.releaseVersion ||
      input.capabilities.some(c => c !== "mission.execute")
    )
      deny("WORKER_INELIGIBLE");
    const startedAt = now();
    const workerInstanceId = deriveWorkerInstanceId({
      ...input,
      registrationNonce: randomUUID(),
    });
    await store.insertRuntimeWorker(
      {
        ...input,
        workerInstanceId,
        runtimeVersion: VERSION,
        runtimeState: "READY",
        startedAt,
        heartbeatAt: startedAt,
        version: 1,
      },
      db
    );
    // Local flag closes the async drain/claim race in this authenticated process.
    // Durable worker state additionally prevents claims across process boundaries.
    let draining = false;
    let active = 0;
    async function eligible(allowDraining = false) {
      const w = await store.getRuntimeWorkerByInstance(workerInstanceId, db);
      if (!w) deny("WORKER_NOT_FOUND");
      if (
        (!allowDraining && draining) ||
        (!allowDraining && w.runtimeState !== "READY") ||
        ["STOPPED", "FAILED", "STOPPING"].includes(w.runtimeState)
      )
        deny("DRAIN_IN_PROGRESS");
      const lv = evaluateWorkerLiveness({
        worker: w,
        allWorkers: [w],
        nowMs: Date.parse(now()),
      });
      if (!mayWorkerHoldWork(lv)) deny("WORKER_INELIGIBLE");
      return w;
    }
    async function heartbeat() {
      const w = await eligible(true);
      return store.transitionWorkerState({
        workerInstanceId,
        expectedVersion: w.version,
        toState: draining ? "DRAINING" : w.runtimeState,
        heartbeatAt: now(),
        executor: db,
      });
    }
    async function claim(raw: unknown) {
      const { jobId } = jobRef.parse(raw);
      const w = await eligible();
      const { j } = await job(jobId);
      assertJobVersionCompatible({
        jobRuntimeVersion: j.runtimeVersion,
        jobReleaseVersion: j.releaseVersion,
        workerRuntimeVersion: w.runtimeVersion,
        workerReleaseVersion: w.releaseVersion,
      });
      const acquiredAt = now();
      if (Date.parse(j.notBefore) > Date.parse(acquiredAt))
        deny("DISPATCH_WINDOW_EXPIRED");
      if (
        j.state !== "PENDING" &&
        !(
          j.state === "LEASED" &&
          j.leaseExpiresAt &&
          Date.parse(j.leaseExpiresAt) < Date.parse(acquiredAt)
        )
      )
        return null;
      const leaseEpoch = j.version + 1;
      const leaseId = deriveLeaseId({
        jobId,
        workerInstanceId,
        leaseEpoch,
        acquiredAt,
      });
      const leaseExpiresAt = new Date(
        Date.parse(acquiredAt) + 60_000
      ).toISOString();
      if (draining) deny("DRAIN_IN_PROGRESS");
      const claimed = await (
        j.state === "PENDING"
          ? store.tryClaimFreshCAS
          : store.tryClaimReclaimCAS
      )({
        jobId,
        expectedVersion: j.version,
        leaseId,
        leaseOwnerInstanceId: workerInstanceId,
        leaseEpoch,
        leaseExpiresAt,
        nowIso: acquiredAt,
        executor: db,
      });
      if (!claimed) return null;
      await store.insertRuntimeLease(
        {
          leaseId,
          jobId,
          userId: j.userId,
          businessId: j.businessId,
          workerInstanceId,
          authorityRef: j.authorityRef,
          attemptRef: j.attemptRef,
          leaseState: "ACTIVE",
          leaseEpoch,
          acquiredAt,
          heartbeatAt: acquiredAt,
          leaseExpiresAt,
          version: 1,
        },
        db
      );
      return claimed;
    }
    async function run(raw: unknown) {
      const { jobId } = jobRef.parse(raw);
      active++;
      try {
        let j = await claim({ jobId });
        if (!j) return null;
        let a = (await job(jobId)).a;
        const latest = await getLatestExecutionAttemptForAction(
          binding.userId,
          a.executionActionId,
          db
        );
        // Restart always reloads durable rows. Existing attempt/barrier means reconcile only.
        if (
          j.resultStatus !== null ||
          a.dispatchState !== "DISPATCH_PREPARED" ||
          latest
        ) {
          return store.completeJobWithFenceCAS({
            jobId,
            nowIso: now(),
            expectedVersion: j.version,
            leaseId: j.leaseId!,
            leaseEpoch: j.leaseEpoch!,
            ...receiptState(latest),
            executor: db,
          });
        }
        await validateRetry(a, j.attemptRef);
        // Material is reloaded, fingerprint checked, never accepted from queue payload.
        const parameters = await binding.loadParameters(a);
        const canonical = deriveCanonicalActionParams({ ...a, parameters });
        if (deriveActionParametersHash(canonical) !== a.actionParametersHash)
          deny("PARAMETERS_FINGERPRINT_MISMATCH");
        await eligible();
        // Re-read after asynchronous material loading. Fence rejects lease loss/expiry.
        ({ j, a } = await job(jobId));
        if (
          j.leaseOwnerInstanceId !== workerInstanceId ||
          !j.leaseId ||
          !j.leaseEpoch
        )
          deny("LEASE_STALE");
        const barrier = await store.beginRuntimeDispatch({
          jobId,
          expectedVersion: j.version,
          leaseId: j.leaseId,
          leaseEpoch: j.leaseEpoch,
          workerInstanceId,
          nowIso: now(),
          executor: db,
        });
        if (!barrier) deny("CLAIM_LOST");
        j = barrier;
        // R9-D revalidates A/B/C/F immediately before its dispatch CAS + sandbox adapter.
        // Any error after the barrier is conservative: no reset, no blind replay.
        try {
          await dispatchExecutionAction(db, binding.execution, ctx, {
            executionActionId: a.executionActionId,
            parameters,
          });
        } catch {
          return store.completeJobWithFenceCAS({
            jobId,
            nowIso: now(),
            expectedVersion: j.version,
            leaseId: j.leaseId!,
            leaseEpoch: j.leaseEpoch!,
            resultStatus: "UNCERTAIN",
            failureClass: "INTERNAL",
            uncertaintyClass: "PROVIDER_STATE_UNKNOWN",
            executor: db,
          });
        }
        const receipt = await getLatestExecutionAttemptForAction(
          binding.userId,
          a.executionActionId,
          db
        );
        return store.completeJobWithFenceCAS({
          jobId,
          nowIso: now(),
          expectedVersion: j.version,
          leaseId: j.leaseId!,
          leaseEpoch: j.leaseEpoch!,
          ...receiptState(receipt),
          executor: db,
        });
      } finally {
        active--;
      }
    }
    async function drain() {
      draining = true;
      const w = await store.getRuntimeWorkerByInstance(workerInstanceId, db);
      if (!w) deny("WORKER_NOT_FOUND");
      if (w.runtimeState !== "DRAINING" && w.runtimeState !== "STOPPED")
        await store.transitionWorkerState({
          workerInstanceId,
          expectedVersion: w.version,
          toState: "DRAINING",
          heartbeatAt: now(),
          executor: db,
        });
      return { active, drained: active === 0 };
    }
    async function stop() {
      const result = await drain();
      if (!result.drained) return result;
      const w = await store.getRuntimeWorkerByInstance(workerInstanceId, db);
      if (w && w.runtimeState !== "STOPPED")
        await store.transitionWorkerState({
          workerInstanceId,
          expectedVersion: w.version,
          toState: "STOPPED",
          heartbeatAt: now(),
          stoppedAt: now(),
          executor: db,
        });
      return result;
    }
    return Object.freeze({
      workerInstanceId,
      heartbeat,
      claim,
      run,
      drain,
      stop,
    });
  }
  async function observe() {
    const generatedAt = now();
    const workers = await store.listRuntimeWorkers(db);
    const scopedJobs = (
      await store.listRuntimeJobs({ userId: binding.userId }, db)
    ).filter(j => j.businessId === binding.businessId);
    const jobs = await Promise.all(
      scopedJobs.map(async j => {
        const leases = j.leaseId
          ? await store.listLeasesForJob(j.jobId, db)
          : [];
        return {
          ...j,
          updatedAt: new Date(j.updatedAt).toISOString(),
          createdAt: new Date(j.createdAt).toISOString(),
          leaseAcquiredAt:
            leases.find(l => l.leaseId === j.leaseId)?.acquiredAt ?? null,
        };
      })
    );
    const deadLetters = await store.listRuntimeDeadLetters(
      binding.userId,
      binding.businessId,
      db
    );
    const projection = buildRuntimeObservabilityProjection({
      workers,
      jobs,
      deadLetters,
      generatedAt,
      nowMs: Date.parse(generatedAt),
      expectedReleaseVersion: binding.releaseVersion,
    });
    return {
      ...projection,
      disclaimers: [
        ...projection.disclaimers,
        "Bounded internal snapshot: up to 500 recent workers, 500 recent tenant jobs filtered to this business, and 500 business dead letters. Counts describe this snapshot; they are not global queue totals.",
      ],
    };
  }
  return Object.freeze({ enqueue, register, deadLetter, observe });
}

/** Exact callback evidence comparison only; ingestion/authentication remains R9-D/provider owned. */
export function assertRuntimeCallbackConvergence(
  expected: {
    attemptRef: string;
    externalReference: string;
    resultHash: string;
  },
  received: unknown
) {
  const receipt = z
    .strictObject({
      attemptRef: z.string(),
      externalReference: z.string(),
      resultHash: z.string(),
    })
    .parse(received);
  if (sha256Hex(canonicalJson(receipt)) !== sha256Hex(canonicalJson(expected)))
    deny("CALLBACK_CONFLICT");
  return "idempotent_replay" as const;
}
