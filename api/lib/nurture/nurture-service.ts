// ─── R6-D Nurture / Sales Handoff — governed service orchestration ───
//
// The ONLY authority that may authorize nurture or sales-handoff effects.
// Every flow re-validates the frozen upstream world from durable ports on
// every call (cross-agent trust), re-reads the privacy gate at decision AND
// execution time (privacy always overrides progression), persists through
// exact-once insert-first stores, and emits exactly one canonical audit event
// per material effect. No client-supplied authority exists anywhere: inputs
// are ids and bounded options only.

import {
  EvaluateNurtureInputSchema,
  DispatchHandoffInputSchema,
  DispatchNurtureTouchInputSchema,
  failNurture,
  isDuplicateKeyError,
  type NurtureChannel,
  type NurtureDecision,
  type NurtureReasonCode,
} from "./nurture-contract";import {
  deriveHandoffKey,
  deriveHandoffId,
  deriveExecutionIdentity,
  deriveTouchIdentity,
} from "./nurture-identity";
import {
  buildDefaultNurturePolicyConfig,
  buildNurtureHandoffPolicy,
  type NurtureHandoffPolicy,
} from "./nurture-policy";
import { deriveNurtureDecision, type DerivedNurtureDecision } from "./nurture-decision";
import {
  validateQualificationProjection,
  validateLeadIdentityRef,
  validatePrivacyEvidence,
  validateConversionEvidence,
  selectAuthoritativeConversions,
  type QualificationHandoffProjection,
  type LeadIdentityRef,
  type PrivacyEvidence,
} from "./nurture-upstream";
import {
  validateNurtureDraft,
  buildDispatchContent,
  type ValidatedNurtureDraft,
} from "./nurture-content-boundary";
import {
  resolveNurtureCapability,
  assertCapabilityDispatchable,
} from "./nurture-provider-capability";
import {
  buildHandoffApprovalCommand,
  assertHandoffApprovalExecutable,
  type SalesHandoffApprovalView,
} from "./nurture-approval";
import type { NurtureTransport } from "./nurture-transport";
import * as store from "./nurture-store";
import { assertNurtureSchemaAvailable } from "./nurture-store";
import { checkNurtureCadence } from "./nurture-cadence";
import { createAuditEvent, type AuditEvent } from "../audit/audit-event";
import { persistAuditEvent } from "../audit/audit-store";
import { eq } from "drizzle-orm";
import { approvalRequests, type NurtureHandoffDecisionRow } from "@db/schema";
import { getDb } from "../../queries/connection";

// ─── Dependency seams (frozen upstream ports + governance infrastructure) ───

export interface NurtureUpstreamPorts {
  /** C-owned qualification handoff projection (raw payload; validated here). */
  getQualificationProjection(args: { userId: number; qualificationId: string }): Promise<unknown>;
  /** A-owned lead identity reference (raw payload; validated here). */
  getLeadIdentity(args: { userId: number; leadId: string }): Promise<unknown>;
  /** F-owned privacy evidence (raw payload; validated here). */
  getPrivacyEvidence(args: { userId: number; leadId: string }): Promise<unknown>;
  /** E-owned conversion evidence (raw payload; validated here). */
  listConversionsForLead(args: {
    userId: number;
    businessId: number | null;
    leadId: string;
  }): Promise<unknown>;
  /** Governed approval ledger read (human approval surface). */
  getApprovalRequest(args: { userId: number; approvalRequestId: number }): Promise<unknown>;
}

export interface NurtureServiceDeps {
  ports: NurtureUpstreamPorts;
  executor?: store.NurtureStoreExecutor;
  /**
   * Execution transport. The router wires NONE: dispatch fails closed until
   * R6-X configures a truthful transport. Tests inject the fake/test-only
   * transport. Model output can never reach this seam unvalidated.
   */
  transport?: NurtureTransport & { providerId?: string };
  /** Policy resolution (defaults to the immutable default policy). */
  resolvePolicy?: (ctx: { userId: number; businessId: number | null }) => Promise<NurtureHandoffPolicy>;
  now?: () => Date;
}

function defaultNow(): Date {
  return new Date();
}

async function resolveBusinessPolicy(
  deps: NurtureServiceDeps,
  ctx: { userId: number; businessId: number | null }
): Promise<NurtureHandoffPolicy> {
  if (deps.resolvePolicy) return deps.resolvePolicy(ctx);
  return buildNurtureHandoffPolicy(buildDefaultNurturePolicyConfig());
}

// ─── Shared world re-validation (contract §2–§4, §13) ───

interface ValidatedWorld {
  qualification: QualificationHandoffProjection;
  identity: LeadIdentityRef;
  privacy: PrivacyEvidence;
  conversionStopped: boolean;
}

async function loadWorld(
  deps: NurtureServiceDeps,
  userId: number,
  qualificationId: string
): Promise<ValidatedWorld> {
  const rawProjection = await deps.ports.getQualificationProjection({ userId, qualificationId });
  if (rawProjection === null || rawProjection === undefined) {
    failNurture("QUALIFICATION_NOT_FOUND", "QUALIFICATION_NOT_FOUND: qualification does not exist for this tenant.");
  }
  const qualification = validateQualificationProjection(rawProjection, "qualificationPort");

  const rawIdentity = await deps.ports.getLeadIdentity({ userId, leadId: qualification.leadId });
  if (rawIdentity === null || rawIdentity === undefined) {
    failNurture("OWNERSHIP_MISMATCH", "OWNERSHIP_MISMATCH: lead identity does not exist for this tenant (forged lead reference).");
  }
  const identity = validateLeadIdentityRef(rawIdentity, "identityPort");
  if (identity.canonicalLeadId !== null && identity.canonicalLeadId !== qualification.leadId) {
    failNurture(
      "OWNERSHIP_MISMATCH",
      "OWNERSHIP_MISMATCH: identity resolved to a different canonical lead than the qualification projection; refusing tampered cross-lead reference."
    );
  }
  if (identity.businessId !== qualification.businessId) {
    failNurture(
      "OWNERSHIP_MISMATCH",
      "OWNERSHIP_MISMATCH: qualification business scope does not match the lead identity; cross-business references are rejected."
    );
  }

  const rawPrivacy = await deps.ports.getPrivacyEvidence({ userId, leadId: qualification.leadId });
  const privacy = validatePrivacyEvidence(rawPrivacy, "privacyPort");

  const rawConversions = await deps.ports.listConversionsForLead({
    userId,
    businessId: qualification.businessId,
    leadId: qualification.leadId,
  });
  const conversions = validateConversionEvidence(rawConversions, "conversionPort");
  const conversionStopped = selectAuthoritativeConversions(conversions).length > 0;

  return { qualification, identity, privacy, conversionStopped };
}

// ─── Audit helpers (exactly one event per material effect) ───

async function emitAudit(
  deps: NurtureServiceDeps,
  event: AuditEvent
): Promise<void> {
  await persistAuditEvent(event, deps.executor);
}

function decisionAuditEvent(input: {
  userId: number;
  businessId: number | null;
  row: NurtureHandoffDecisionRow;
  occurredAt: string;
}): AuditEvent {
  return createAuditEvent({
    eventType: "lead_nurture_decision",
    occurredAt: input.occurredAt,
    userId: input.userId,
    source: "user",
    outcome: input.row.decision === "BLOCKED" ? "failed" : "succeeded",
    businessId: input.businessId,
    artifactId: input.row.nurtureDecisionId,
    metadata: {
      decision: input.row.decision,
      reasonCodes: input.row.reasonCodes,
      channel: input.row.channel,
      policyVersion: input.row.policyVersion,
      privacyState: input.row.privacyState,
      qualificationId: input.row.qualificationId,
      leadId: input.row.leadId,
      handoffId: input.row.handoffId ?? null,
      approvalRequired: input.row.approvalRequired,
      conversionStopped: input.row.conversionStopped,
    },
  });
}

// ─── Decision evaluation (D2) ───

export interface EvaluateNurtureResult {
  decision: {
    nurtureDecisionId: string;
    decision: NurtureDecision;
    reasonCodes: readonly string[];
    channel: NurtureChannel | null;
    approvalRequired: boolean;
    approvalRequestId: number | null;
    handoffId: string | null;
    policyVersion: string;
    occurredAt: string;
    validUntil: string;
  };
  handoff: {
    handoffId: string;
    handoffStatus: string;
    approvalRequired: boolean;
  } | null;
  duplicateClassification: "inserted" | "idempotent_replay";
}

export async function evaluateNurture(
  deps: NurtureServiceDeps,
  userId: number,
  rawInput: unknown
): Promise<EvaluateNurtureResult> {
  const parsed = EvaluateNurtureInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    failNurture("INVALID_NURTURE_INPUT", `Invalid evaluate input: ${parsed.error.issues[0]?.message ?? "schema violation"}`);
  }
  const input = parsed.data;
  const now = (deps.now ?? defaultNow)();

  assertNurtureSchemaAvailable(await store.nurtureTablesAvailable(deps.executor));

  const world = await loadWorld(deps, userId, input.qualificationId);
  const policy = await resolveBusinessPolicy(deps, {
    userId,
    businessId: world.qualification.businessId,
  });

  const handoffKey = deriveHandoffKey({
    userId,
    businessId: world.qualification.businessId,
    leadId: world.qualification.leadId,
    qualificationId: world.qualification.qualificationId,
    handoffPolicyVersion: policy.policyVersion,
  });
  const existingHandoff = await store.getHandoffByKey(userId, handoffKey, deps.executor);

  const touches = input.channel
    ? await store.listTouchesForLeadChannel(userId, world.qualification.leadId, input.channel, deps.executor)
    : [];

  const derived: DerivedNurtureDecision = deriveNurtureDecision({
    userId,
    qualification: world.qualification,
    privacy: world.privacy,
    conversionStopped: world.conversionStopped,
    handoffExists: existingHandoff !== null,
    policy,
    channel: input.channel ?? null,
    touches: touches.map((t) => ({ touchedAt: t.touchedAt })),
    now,
  });

  const occurredAt = now.toISOString();

  // For progression decisions the exact-once handoff is prepared BEFORE the
  // decision row is inserted, so the decision record carries its handoff
  // linkage at birth — decisions stay fully immutable after acceptance
  // (contract §15). Both writes are insert-first and converge on replay.
  let preparedHandoff: { handoffId: string; handoffStatus: string } | null = null;
  let approvalRequestId: number | null = null;

  if (derived.decision === "SALES_HANDOFF") {
    const handoffId = deriveHandoffId(handoffKey);
    const contentSnapshotHash = derived.qualificationFingerprint; // handoff payload = qualification-bound snapshot reference
    const handoffWrite = await store.recordHandoff(
      {
        handoffId,
        handoffKey,
        userId,
        businessId: world.qualification.businessId,
        leadId: world.qualification.leadId,
        qualificationId: world.qualification.qualificationId,
        nurtureDecisionId: derived.nurtureDecisionId,
        qualificationFingerprint: derived.qualificationFingerprint,
        handoffPolicyVersion: policy.policyVersion,
        contentSnapshotHash,
        handoffStatus: "PREPARED",
        approvalRequestId: null,
        lastError: null,
        version: 1,
        preparedAt: occurredAt,
        dispatchedAt: null,
        acknowledgedAt: null,
      },
      deps.executor
    );
    const handoffRow = handoffWrite.row;
    preparedHandoff = { handoffId, handoffStatus: handoffRow.handoffStatus };

    if (derived.approvalRequired && handoffRow.approvalRequestId === null) {
      const command = buildHandoffApprovalCommand({
        handoffId,
        nurtureDecisionId: derived.nurtureDecisionId,
        userId,
        businessId: world.qualification.businessId,
        leadId: world.qualification.leadId,
        qualificationId: world.qualification.qualificationId,
        qualificationFingerprint: derived.qualificationFingerprint,
        handoffPolicyVersion: policy.policyVersion,
        contentSnapshotHash,
        expiresAt: derived.validUntil,
        reasonCodes: derived.reasonCodes,
      });
      approvalRequestId = await insertApprovalRequest(deps, command);
      const moved = await store.transitionHandoffStatus(
        userId,
        handoffId,
        {
          fromStatuses: ["PREPARED"],
          toStatus: "APPROVAL_REQUIRED",
          expectedVersion: handoffRow.version,
          approvalRequestId,
        },
        deps.executor
      );
      preparedHandoff = { handoffId, handoffStatus: moved.row.handoffStatus };
    } else if (handoffRow.approvalRequestId !== null) {
      approvalRequestId = handoffRow.approvalRequestId;
    }
  }

  const write = await store.recordDecision(
    {
      nurtureDecisionId: derived.nurtureDecisionId,
      decisionKey: derived.decisionKey,
      userId,
      businessId: world.qualification.businessId,
      leadId: world.qualification.leadId,
      qualificationId: world.qualification.qualificationId,
      qualificationFingerprint: derived.qualificationFingerprint,
      qualificationPolicyVersion: world.qualification.qualificationPolicyVersion,
      privacyState: world.privacy.state,
      privacyStateUpdatedAt: world.privacy.updatedAt,
      policyVersion: derived.policyVersion,
      decision: derived.decision,
      reasonCodes: [...derived.reasonCodes],
      channel: derived.channel,
      provider: null,
      approvalRequired: derived.approvalRequired,
      approvalRequestId,
      handoffId: preparedHandoff?.handoffId ?? null,
      conversionStopped: world.conversionStopped,
      occurredAt,
      validUntil: derived.validUntil,
    },
    deps.executor
  );

  if (write.inserted) {
    const row = write.row;
    await emitAudit(deps, decisionAuditEvent({ userId, businessId: row.businessId, row, occurredAt }));
  }

  return {
    decision: {
      nurtureDecisionId: derived.nurtureDecisionId,
      decision: derived.decision,
      reasonCodes: derived.reasonCodes,
      channel: derived.channel,
      approvalRequired: derived.approvalRequired,
      approvalRequestId,
      handoffId: preparedHandoff?.handoffId ?? null,
      policyVersion: derived.policyVersion,
      occurredAt,
      validUntil: derived.validUntil,
    },
    handoff:
      preparedHandoff !== null
        ? {
            handoffId: preparedHandoff.handoffId,
            handoffStatus: preparedHandoff.handoffStatus,
            approvalRequired: derived.approvalRequired,
          }
        : null,
    duplicateClassification: write.duplicateClassification,
  };
}

async function insertApprovalRequest(
  deps: NurtureServiceDeps,
  command: ReturnType<typeof buildHandoffApprovalCommand>
): Promise<number> {
  const db = deps.executor ?? getDb();
  try {
    const rawResult = await db.insert(approvalRequests).values({
      userId: command.userId,
      campaignId: command.campaignId,
      approvalType: command.approvalType,
      title: command.title,
      description: command.description,
      aiRecommendation: command.aiRecommendation,
      riskLevel: command.riskLevel,
      status: "pending",
      idempotencyKey: command.idempotencyKey,
      context: command.context,
    });
    // drizzle mysql resolves [ResultSetHeader, FieldPacket[]]; test fakes may
    // resolve the header object directly. Accept both — never invent an id.
    const header = Array.isArray(rawResult)
      ? (rawResult[0] as { insertId?: number | bigint })
      : (rawResult as { insertId?: number | bigint });
    const insertId = header?.insertId;
    if (insertId === undefined || insertId === null) {
      failNurture("NURTURE_UPSTREAM_UNAVAILABLE", "Approval insert returned no id; failing closed.");
    }
    return Number(insertId);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    // Raced duplicate idempotency key: converge on the existing operator row.
    const [existing] = await db
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(eq(approvalRequests.idempotencyKey, command.idempotencyKey))
      .limit(1);
    if (existing) return existing.id;
    throw err;
  }
}

// ─── Execution gate set (contract §11) — re-validated before every dispatch ───

async function assertWorldDispatchable(
  deps: NurtureServiceDeps,
  userId: number,
  qualificationId: string
): Promise<ValidatedWorld> {
  // The full §11 gate set re-derived from CURRENT durable authorities.
  return loadWorld(deps, userId, qualificationId);
}

/** Execution-time qualification gate: only a current, unexpired QUALIFIED may
 *  authorize external effects (contract §2, §6; acceptance case 6). */
function assertQualificationDispatchable(
  qualification: QualificationHandoffProjection,
  now: Date
): void {
  if (qualification.decision !== "QUALIFIED") {
    failNurture(
      "DECISION_NOT_EXECUTABLE",
      `Execution blocked: qualification decision is ${qualification.decision}; only a current QUALIFIED authorizes execution.`
    );
  }
  if (now.getTime() > Date.parse(qualification.validUntil)) {
    failNurture("EXPIRED_DECISION", "Execution blocked: the qualification is stale (STALE_DECISION); re-evaluate before acting.");
  }
}

function assertPrivacyActionableNow(privacy: PrivacyEvidence, now: Date): void {
  const actionable =
    privacy.available &&
    (privacy.state === "ACTIVE" ||
      (privacy.state === "RETENTION_PENDING" &&
        (!privacy.retentionDeadlineAt || now.getTime() <= Date.parse(privacy.retentionDeadlineAt))));
  if (!actionable) {
    failNurture(
      "PRIVACY_STATE_UNAVAILABLE",
      `Dispatch blocked: privacy state ${privacy.state} is not actionable at execution time. Privacy always overrides progression.`
    );
  }
}

async function readApprovalView(
  deps: NurtureServiceDeps,
  userId: number,
  approvalRequestId: number
): Promise<SalesHandoffApprovalView | null> {
  const raw = await deps.ports.getApprovalRequest({ userId, approvalRequestId });
  if (raw === null || raw === undefined) return null;
  const row = raw as { id?: unknown; status?: unknown; context?: unknown };
  if (typeof row.id !== "number" || typeof row.status !== "string") return null;
  if (!["pending", "approved", "rejected", "edited"].includes(row.status)) return null;
  return { id: row.id, status: row.status as SalesHandoffApprovalView["status"], context: row.context ?? null };
}

// ─── Handoff dispatch (D5/D7) — claim-based, exact-once, receipt-backed ───

export interface DispatchHandoffResult {
  handoffId: string;
  handoffStatus: string;
  executionIdentity: string | null;
  outcome: "ACCEPTED" | "REJECTED" | "FAILURE" | null;
  attemptSeq: number;
  duplicateClassification: "inserted" | "idempotent_replay";
}

export async function dispatchHandoff(
  deps: NurtureServiceDeps,
  userId: number,
  rawInput: unknown
): Promise<DispatchHandoffResult> {
  const parsed = DispatchHandoffInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    failNurture("INVALID_NURTURE_INPUT", `Invalid dispatch input: ${parsed.error.issues[0]?.message ?? "schema violation"}`);
  }
  const now = (deps.now ?? defaultNow)();
  assertNurtureSchemaAvailable(await store.nurtureTablesAvailable(deps.executor));
  const handoff = await store.getHandoffById(userId, parsed.data.handoffId, deps.executor);
  if (!handoff) failNurture("HANDOFF_NOT_FOUND", `HANDOFF_NOT_FOUND: ${parsed.data.handoffId} does not exist for this tenant.`);

  const world = await assertWorldDispatchable(deps, userId, handoff.qualificationId);
  assertPrivacyActionableNow(world.privacy, now);
  assertQualificationDispatchable(world.qualification, now);

  if (world.conversionStopped) {
    failNurture("HANDOFF_STATE_CONFLICT", "Dispatch blocked: an authoritative conversion now exists (CONVERSION_STOP); duplicate handoff suppressed.");
  }

  const policy = await resolveBusinessPolicy(deps, { userId, businessId: handoff.businessId });
  if (policy.policyVersion !== handoff.handoffPolicyVersion) {
    failNurture(
      "STALE_POLICY_VERSION",
      "STALE_POLICY_VERSION: the nurture/handoff policy changed since this handoff was prepared; a new governed decision is required."
    );
  }

  // Approval gate (contract §9): approval-required handoffs execute only with
  // a valid human approval bound to this exact identity. No client-supplied
  // success path exists anywhere.
  const approvalRequired = handoff.approvalRequestId !== null;
  let approvalView: SalesHandoffApprovalView | null = null;
  if (approvalRequired) {
    approvalView = await readApprovalView(deps, userId, handoff.approvalRequestId as number);
    const verdict = assertHandoffApprovalExecutable({
      handoffId: handoff.handoffId,
      handoffPolicyVersion: handoff.handoffPolicyVersion,
      contentSnapshotHash: handoff.contentSnapshotHash,
      approval: approvalView,
      currentPolicyVersion: policy.policyVersion,
      now: now.toISOString(),
    });
    if (!verdict.executable) {
      const code =
        verdict.reason === "ACTION_REJECTED_BY_HUMAN"
          ? "ACTION_REJECTED_BY_HUMAN"
          : verdict.reason === "APPROVAL_PENDING"
            ? "APPROVAL_PENDING"
            : verdict.reason === "APPROVAL_NOT_FOUND"
              ? "APPROVAL_NOT_FOUND"
              : verdict.reason;
      failNurture(code, `Dispatch blocked by the approval gate: ${verdict.reason}.`);
    }
  }

  // Capability gate (contract §10): truthful, fail-closed. No transport wired
  // ⇒ dispatch fails closed; real providers are honestly UNSUPPORTED.
  const provider = deps.transport?.providerId ?? null;
  const capability = resolveNurtureCapability({ channel: "crm", provider });
  assertCapabilityDispatchable(capability);

  if (!deps.transport) {
    failNurture("CAPABILITY_UNSUPPORTED", "CAPABILITY_UNSUPPORTED: no execution transport is configured for this environment; dispatch fails closed.");
  }
  const transport = deps.transport as NurtureTransport & { providerId?: string };

  // Claim: CAS transition into DISPATCH_PENDING (lost races converge). A
  // failed attempt retries without re-approval — the approval gate above
  // re-validates the durable approval before the claim.
  const claimableFrom = approvalRequired
    ? (["APPROVED", "FAILED"] as const)
    : (["PREPARED", "FAILED"] as const);
  const claimed = await store.transitionHandoffStatus(
    userId,
    handoff.handoffId,
    { fromStatuses: [...claimableFrom], toStatus: "DISPATCH_PENDING", expectedVersion: handoff.version },
    deps.executor
  );
  if (!claimed.transitioned) {
    failNurture(
      "HANDOFF_STATE_CONFLICT",
      `HANDOFF_STATE_CONFLICT: handoff is ${claimed.row.handoffStatus}; only ${claimableFrom.join("/")} may dispatch.`
    );
  }

  const receipts = await store.listReceiptsForHandoff(userId, handoff.handoffId, deps.executor);
  const attemptSeq = receipts.length + 1;
  const executionIdentity = deriveExecutionIdentity(handoff.handoffId, attemptSeq);

  // Crash-window guard: an existing receipt for this exact attempt means the
  // effect already happened (or its outcome is durable) — converge, never
  // re-dispatch.
  const existingReceipt = await store.getReceiptByExecutionIdentity(executionIdentity, deps.executor);
  if (existingReceipt) {
    const outcome = existingReceipt.outcome;
    if (outcome === "ACCEPTED") {
      await store.transitionHandoffStatus(
        userId,
        handoff.handoffId,
        { fromStatuses: ["DISPATCH_PENDING"], toStatus: "DISPATCHED" },
        deps.executor
      );
    } else {
      await store.transitionHandoffStatus(
        userId,
        handoff.handoffId,
        { fromStatuses: ["DISPATCH_PENDING"], toStatus: "FAILED", lastError: `DISPATCH_${outcome}` },
        deps.executor
      );
    }
    return {
      handoffId: handoff.handoffId,
      handoffStatus: (await store.getHandoffById(userId, handoff.handoffId, deps.executor))?.handoffStatus ?? "DISPATCH_PENDING",
      executionIdentity,
      outcome,
      attemptSeq,
      duplicateClassification: "idempotent_replay",
    };
  }

  const draft = handoffDispatchDraft(handoff);
  const content = buildDispatchContent(draft);
  const command = {
    executionIdentity,
    handoffId: handoff.handoffId,
    userId,
    businessId: handoff.businessId,
    leadId: handoff.leadId,
    channel: "crm" as const,
    content,
  };

  const result = await transport.dispatch(command);
  const receiptWrite = await store.recordDispatchReceipt(
    {
      executionIdentity,
      handoffId: handoff.handoffId,
      userId,
      attemptSeq,
      outcome: result.outcome,
      providerAck: result.providerAck,
      occurredAt: result.occurredAt,
    },
    deps.executor
  );

  if (result.outcome === "ACCEPTED") {
    await store.transitionHandoffStatus(
      userId,
      handoff.handoffId,
      { fromStatuses: ["DISPATCH_PENDING"], toStatus: "DISPATCHED", dispatchedAt: result.occurredAt },
      deps.executor
    );
  } else {
    await store.transitionHandoffStatus(
      userId,
      handoff.handoffId,
      { fromStatuses: ["DISPATCH_PENDING"], toStatus: "FAILED", lastError: `DISPATCH_${result.outcome}` },
      deps.executor
    );
  }

  if (receiptWrite.inserted) {
    await emitAudit(
      deps,
      createAuditEvent({
        eventType: "sales_handoff_dispatch",
        occurredAt: result.occurredAt,
        userId,
        source: "system",
        outcome: result.outcome === "ACCEPTED" ? "succeeded" : "failed",
        businessId: handoff.businessId,
        approvalRequestId: handoff.approvalRequestId,
        artifactId: handoff.handoffId,
        metadata: {
          executionIdentity,
          attemptSeq,
          dispatchOutcome: result.outcome,
          providerAck: result.providerAck,
          capabilityState: capability.state,
          provider,
        },
      })
    );
  }

  const fresh = await store.getHandoffById(userId, handoff.handoffId, deps.executor);
  return {
    handoffId: handoff.handoffId,
    handoffStatus: fresh?.handoffStatus ?? "DISPATCH_PENDING",
    executionIdentity,
    outcome: result.outcome,
    attemptSeq,
    duplicateClassification: receiptWrite.duplicateClassification,
  };
}

// The handoff payload is a deterministic qualification-bound summary — never
// raw lead data, never model output. It is validated like any draft.
function handoffDispatchDraft(handoff: { handoffId: string; leadId: string }): ValidatedNurtureDraft {
  return validateNurtureDraft({
    channel: "crm",
    subject: "Sales handoff package",
    body: `Governed sales handoff ${handoff.handoffId} for lead ${handoff.leadId}. Qualification-bound; see the qualification fingerprint for content lineage.`,
    cta: "Review in CRM",
  });
}

// ─── Reconciliation (contract §12) — safe retry of failed dispatches ───

export async function reconcileHandoff(
  deps: NurtureServiceDeps,
  userId: number,
  rawInput: unknown
): Promise<{ handoffId: string; handoffStatus: string; converged: boolean; result: DispatchHandoffResult | null }> {
  const parsed = DispatchHandoffInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    failNurture("INVALID_NURTURE_INPUT", `Invalid reconcile input: ${parsed.error.issues[0]?.message ?? "schema violation"}`);
  }
  const handoff = await store.getHandoffById(userId, parsed.data.handoffId, deps.executor);
  if (!handoff) failNurture("HANDOFF_NOT_FOUND", `HANDOFF_NOT_FOUND: ${parsed.data.handoffId} does not exist for this tenant.`);

  if (handoff.handoffStatus === "DISPATCHED" || handoff.handoffStatus === "ACKNOWLEDGED") {
    return { handoffId: handoff.handoffId, handoffStatus: handoff.handoffStatus, converged: true, result: null };
  }
  if (handoff.handoffStatus === "CANCELLED" || handoff.handoffStatus === "BLOCKED") {
    failNurture("HANDOFF_STATE_CONFLICT", `Reconcile blocked: handoff is ${handoff.handoffStatus} (terminal for retry).`);
  }

  // Retry only from FAILED (or a stuck DISPATCH_PENDING claim): the full gate
  // set re-runs inside dispatchHandoff against current authorities.
  const result = await dispatchHandoff(deps, userId, rawInput);
  return {
    handoffId: handoff.handoffId,
    handoffStatus: result.handoffStatus,
    converged: false,
    result,
  };
}

// ─── Nurture touch execution (D3/D4) ───

export interface DispatchNurtureTouchResult {
  touchIdentity: string;
  touchSeq: number;
  outcome: "ACCEPTED" | "REJECTED" | "FAILURE";
  duplicateClassification: "inserted" | "idempotent_replay";
}

export async function dispatchNurtureTouch(
  deps: NurtureServiceDeps,
  userId: number,
  rawInput: unknown
): Promise<DispatchNurtureTouchResult> {
  const parsed = DispatchNurtureTouchInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    failNurture("INVALID_NURTURE_INPUT", `Invalid touch input: ${parsed.error.issues[0]?.message ?? "schema violation"}`);
  }
  const now = (deps.now ?? defaultNow)();
  assertNurtureSchemaAvailable(await store.nurtureTablesAvailable(deps.executor));
  const decision = await store.getDecisionById(userId, parsed.data.nurtureDecisionId, deps.executor);
  if (!decision) failNurture("DECISION_NOT_FOUND", `DECISION_NOT_FOUND: ${parsed.data.nurtureDecisionId} does not exist for this tenant.`);
  if (decision.decision !== "NURTURE") {
    failNurture("DECISION_NOT_EXECUTABLE", `DECISION_NOT_EXECUTABLE: decision ${decision.decision} is not a NURTURE decision.`);
  }
  if (!decision.channel) {
    failNurture("DECISION_NOT_EXECUTABLE", "DECISION_NOT_EXECUTABLE: decision carries no channel.");
  }
  if (now.getTime() > Date.parse(decision.validUntil)) {
    failNurture("EXPIRED_DECISION", "EXPIRED_DECISION: the nurture decision has expired; re-evaluate before touching.");
  }

  // Re-validate current authorities (privacy + fresh qualification).
  const world = await assertWorldDispatchable(deps, userId, decision.qualificationId);
  assertPrivacyActionableNow(world.privacy, now);
  assertQualificationDispatchable(world.qualification, now);
  if (world.conversionStopped) {
    failNurture("HANDOFF_STATE_CONFLICT", "Touch blocked: an authoritative conversion now exists (CONVERSION_STOP).");
  }

  // Cadence re-check at touch time (policy-controlled frequency, contract §7).
  const policy = await resolveBusinessPolicy(deps, { userId, businessId: decision.businessId });
  if (policy.policyVersion !== decision.policyVersion) {
    failNurture("STALE_POLICY_VERSION", "STALE_POLICY_VERSION: policy changed since the decision; re-evaluate before touching.");
  }
  const touches = await store.listTouchesForLeadChannel(userId, decision.leadId, decision.channel as NurtureChannel, deps.executor);
  const cadence = checkNurtureCadence({
    policy,
    touches: touches.map((t) => ({ touchedAt: t.touchedAt })),
    now,
  });
  if (!cadence.allowed) {
    failNurture(
      "DECISION_NOT_EXECUTABLE",
      `DECISION_NOT_EXECUTABLE: cadence gate blocked the touch (NURTURE_CADENCE_LIMITED; next eligible ${
        cadence.nextEligibleAt ?? cadence.windowNextEligibleAt ?? "unknown"
      }).`
    );
  }

  if (decision.approvalRequired) {
    failNurture(
      "DECISION_NOT_EXECUTABLE",
      "DECISION_NOT_EXECUTABLE: this channel requires explicit human approval for touches (activation slot for R6-X)."
    );
  }

  // D4 boundary: caller-supplied DRAFT content is validated here — model
  // output can never reach the transport unvalidated, and can never carry
  // execution metadata.
  const draft = validateNurtureDraft(parsed.data.draft);
  if (draft.channel !== decision.channel) {
    failNurture("INVALID_NURTURE_INPUT", "Draft channel does not match the decision channel.");
  }

  const provider = deps.transport?.providerId ?? null;
  const capability = resolveNurtureCapability({ channel: draft.channel, provider });
  assertCapabilityDispatchable(capability);
  if (!deps.transport) {
    failNurture("CAPABILITY_UNSUPPORTED", "CAPABILITY_UNSUPPORTED: no execution transport is configured; touch fails closed.");
  }
  const transport = deps.transport as NurtureTransport & { providerId?: string };

  const touchSeq = touches.length + 1;
  const touchIdentity = deriveTouchIdentity({
    userId,
    leadId: decision.leadId,
    nurtureDecisionId: decision.nurtureDecisionId,
    touchSeq,
  });

  // Exact-once: an existing touch converges (crash window), never re-sends.
  const existing = await store.getTouchByIdentity(userId, touchIdentity, deps.executor);
  if (existing) {
    return {
      touchIdentity,
      touchSeq,
      outcome: existing.outcome,
      duplicateClassification: "idempotent_replay",
    };
  }

  const content = buildDispatchContent(draft);
  const executionIdentity = deriveExecutionIdentity(decision.nurtureDecisionId, touchSeq);
  const result = await transport.dispatch({
    executionIdentity,
    handoffId: decision.nurtureDecisionId,
    userId,
    businessId: decision.businessId,
    leadId: decision.leadId,
    channel: draft.channel,
    content,
  });

  const touchWrite = await store.recordTouch(
    {
      touchIdentity,
      userId,
      businessId: decision.businessId,
      leadId: decision.leadId,
      nurtureDecisionId: decision.nurtureDecisionId,
      channel: draft.channel,
      provider: provider ?? "unspecified",
      touchSeq,
      outcome: result.outcome,
      providerAck: result.providerAck,
      touchedAt: result.occurredAt,
    },
    deps.executor
  );

  if (touchWrite.inserted) {
    await emitAudit(
      deps,
      createAuditEvent({
        eventType: "lead_nurture_touch",
        occurredAt: result.occurredAt,
        userId,
        source: "system",
        outcome: result.outcome === "ACCEPTED" ? "succeeded" : "failed",
        businessId: decision.businessId,
        artifactId: touchIdentity,
        metadata: {
          nurtureDecisionId: decision.nurtureDecisionId,
          touchSeq,
          channel: draft.channel,
          provider,
          touchOutcome: result.outcome,
          contentHash: content.contentHash,
        },
      })
    );
  }

  return {
    touchIdentity,
    touchSeq,
    outcome: result.outcome,
    duplicateClassification: touchWrite.duplicateClassification,
  };
}

// ─── F-consumable operations view (contract §16) ───

export interface LeadNurtureHandoffView {
  leadId: string;
  businessId: number | null;
  latestDecision: {
    nurtureDecisionId: string;
    decision: NurtureDecision;
    reasonCodes: readonly string[];
    channel: NurtureChannel | null;
    policyVersion: string;
    occurredAt: string;
    validUntil: string;
  } | null;
  nurtureStatus: "eligible" | "waiting" | "blocked" | "stopped" | "unavailable";
  salesHandoffStatus: string;
  blockedReason: NurtureReasonCode | null;
}

export async function getLeadNurtureHandoffView(
  deps: NurtureServiceDeps,
  userId: number,
  leadId: string
): Promise<LeadNurtureHandoffView> {
  const latest = await store.getLatestDecisionForLead(userId, leadId, deps.executor);
  if (!latest) {
    return {
      leadId,
      businessId: null,
      latestDecision: null,
      nurtureStatus: "unavailable",
      salesHandoffStatus: "unavailable",
      blockedReason: null,
    };
  }
  const handoffKey = deriveHandoffKey({
    userId,
    businessId: latest.businessId,
    leadId: latest.leadId,
    qualificationId: latest.qualificationId,
    handoffPolicyVersion: latest.policyVersion,
  });
  const handoff = await store.getHandoffByKey(userId, handoffKey, deps.executor);

  let nurtureStatus: LeadNurtureHandoffView["nurtureStatus"];
  let blockedReason: NurtureReasonCode | null = null;
  const reasonCodes = latest.reasonCodes as readonly string[];
  if (latest.decision === "NURTURE") nurtureStatus = "eligible";
  else if (latest.decision === "WAIT") nurtureStatus = "waiting";
  else if (latest.decision === "NO_ACTION") {
    nurtureStatus = reasonCodes.includes("CONVERSION_STOP") ? "stopped" : "waiting";
    blockedReason = (reasonCodes[0] as NurtureReasonCode) ?? null;
  } else if (latest.decision === "BLOCKED" || latest.decision === "REVIEW_REQUIRED") {
    nurtureStatus = "blocked";
    blockedReason = (reasonCodes[0] as NurtureReasonCode) ?? null;
  } else nurtureStatus = "waiting";

  return {
    leadId,
    businessId: latest.businessId,
    latestDecision: {
      nurtureDecisionId: latest.nurtureDecisionId,
      decision: latest.decision,
      reasonCodes: latest.reasonCodes as readonly string[],
      channel: latest.channel,
      policyVersion: latest.policyVersion,
      occurredAt: latest.occurredAt,
      validUntil: latest.validUntil,
    },
    nurtureStatus,
    salesHandoffStatus: handoff?.handoffStatus ?? "none",
    blockedReason,
  };
}
