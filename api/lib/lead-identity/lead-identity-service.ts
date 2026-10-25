// ─── R6-A Lead Identity — orchestration ───
//
// The governed lead-identity pipeline: handoff envelope validation → tenant/
// ownership re-verification → exact-once consumption → deterministic
// resolution → canonical persistence → immutable provenance → controlled
// enrichment → deterministic merge/conflict → downstream-safe projection.
// Emits exactly one canonical audit event per durable effect. Single clock
// read at the boundary. Never scores, qualifies, contacts, or converts.
//
// Cross-agent security addendum: the R5 envelope is untrusted data until
// validated + tamper-verified here; no agent/client-supplied identity,
// merge, confidence, or status is ever accepted. R6-A runs no model.

import { and, eq } from "drizzle-orm";
import { businesses, campaigns } from "@db/schema";
import type {
  LeadIdentityRow,
  LeadIdentityProvenanceRow,
} from "@db/schema";
import { getDb } from "../../queries/connection";
import { persistAuditEvent } from "../audit/audit-store";
import { createAuditEvent } from "../audit/audit-event";
import * as opportunityStore from "../opportunity/opportunity-store";
import {
  LEAD_IDENTITY_CONTRACT_VERSION,
  MERGE_ID_PREFIX,
  canonicalJson,
  sha256Hex,
  validateHandoffEnvelope,
  verifyHandoffEnvelopeIntegrity,
  deriveEnvelopeHash,
  buildIdentityCoordinates,
  deriveIdentityKey,
  deriveLeadId,
  LeadIdentityInputError,
  LeadIdentityOwnershipError,
  LeadIdentityStateConflictError,
  type IdentityStatus,
  type IdentityConfidence,
  type IdentityType,
  type IdentitySuppressionReason,
  type LinkingEvidenceType,
  type LeadIdentityDuplicateClassification,
  type LeadIdentityProjection,
  type LeadIdentityProvenanceRef,
} from "./lead-identity-contract";
import type { OpportunityHandoffEnvelope } from "../opportunity/opportunity-contract";
import { toVerifiedIdentityKey } from "./lead-identity-keys";
import {
  deriveIdentityStatus,
  deriveIdentityConfidence,
  adoptPrimaryIdentityType,
  linkingEvidenceTypeToIdentityType,
  classifyIdentityResolution,
  isTerminalIdentityStatus,
  sameBusinessScope,
  type IdentityEvidenceSummary,
} from "./lead-identity-derivation";
import * as store from "./lead-identity-store";
import type { LeadIdentityStoreExecutor } from "./lead-identity-store";

// ─── Configuration (server-side; overridable for tests) ───

export interface LeadIdentityServiceConfig {
  /** Evidence older than this is a stale handoff (default 336h = 2× R5 window). */
  staleEvidenceMs: number;
}

export const DEFAULT_LEAD_IDENTITY_CONFIG: LeadIdentityServiceConfig = {
  staleEvidenceMs: 14 * 24 * 60 * 60 * 1000,
};

// ─── Audit emission (one canonical event per durable effect) ───

async function emitIdentityAudit(input: {
  eventType:
    | "lead_identity_created"
    | "lead_identity_observed"
    | "lead_identity_evidence_attached"
    | "lead_identity_merged"
    | "lead_identity_conflict"
    | "lead_identity_suppressed"
    | "lead_identity_archived";
  userId: number;
  businessId: number | null;
  campaignId: number | null;
  occurredAt: string;
  metadata: Record<string, unknown>;
  executor?: LeadIdentityStoreExecutor;
}): Promise<void> {
  const event = createAuditEvent({
    eventType: input.eventType,
    occurredAt: input.occurredAt,
    userId: input.userId,
    source: "system",
    outcome: "succeeded",
    campaignId: input.campaignId,
    businessId: input.businessId,
    metadata: input.metadata,
  });
  await persistAuditEvent(event, input.executor);
}

// ─── Shared helpers ───

function toProvenanceRefs(rows: LeadIdentityProvenanceRow[]): LeadIdentityProvenanceRef[] {
  return rows.map((r) => ({
    kind: r.kind,
    handoffId: r.handoffId,
    opportunityId: r.opportunityId,
    evidenceType: r.evidenceType,
    occurredAt: r.occurredAt,
  }));
}

export function toLeadIdentityProjection(
  row: LeadIdentityRow,
  provenanceRows: LeadIdentityProvenanceRow[]
): LeadIdentityProjection {
  return {
    leadId: row.leadId,
    businessId: row.businessId ? Number(row.businessId) : null,
    leadIdentityVersion: LEAD_IDENTITY_CONTRACT_VERSION,
    identityStatus: row.identityStatus,
    identityConfidence: row.identityConfidence,
    primaryIdentityType: row.primaryIdentityType,
    externalActorReferenceHash: row.externalActorReferenceHash,
    provider: row.provider,
    sourceOpportunityId: row.sourceOpportunityId,
    sourceHandoffId: row.sourceHandoffId,
    canonicalLeadId: row.canonicalLeadId,
    firstObservedAt: row.firstObservedAt,
    lastObservedAt: row.lastObservedAt,
    provenance: toProvenanceRefs(provenanceRows),
  };
}

/** Follow the deterministic merge chain to the canonical identity (loop-guarded). */
async function followCanonicalChain(
  userId: number,
  row: LeadIdentityRow,
  executor?: LeadIdentityStoreExecutor
): Promise<LeadIdentityRow> {
  let current = row;
  for (let depth = 0; depth < 10; depth += 1) {
    if (current.identityStatus !== "merged" || !current.canonicalLeadId) return current;
    const next = await store.findIdentityByLeadId(userId, current.canonicalLeadId, executor);
    if (!next) return current;
    current = next;
  }
  return current;
}

function linkingKeyTypesFromProvenance(
  row: LeadIdentityRow,
  provenanceRows: LeadIdentityProvenanceRow[]
): { types: LinkingEvidenceType[]; hasAuthenticated: boolean; hasCrm: boolean } {
  const types: LinkingEvidenceType[] = [];
  let hasAuthenticated = false;
  let hasCrm = false;
  if (row.emailIdentityHash) types.push("email_hash");
  if (row.phoneIdentityHash) types.push("phone_hash");
  if (row.customerReferenceHash) {
    // The column is shared; the immutable provenance records which reference
    // class was verified first.
    const customerEvidence = provenanceRows
      .filter((p) => p.kind === "identity_evidence" && p.evidenceType === "authenticated_customer_reference")
      .sort((a, b) => Number(a.id) - Number(b.id));
    const crmEvidence = provenanceRows
      .filter((p) => p.kind === "identity_evidence" && p.evidenceType === "crm_external_reference")
      .sort((a, b) => Number(a.id) - Number(b.id));
    const firstCustomer = customerEvidence[0];
    const firstCrm = crmEvidence[0];
    if (firstCustomer && (!firstCrm || Number(firstCustomer.id) < Number(firstCrm.id))) {
      types.push("authenticated_customer_reference");
      hasAuthenticated = true;
    } else if (firstCrm) {
      types.push("crm_external_reference");
      hasCrm = true;
    } else {
      // Deterministic fallback (provenance unavailable): the weaker claim.
      types.push("crm_external_reference");
      hasCrm = true;
    }
  }
  return { types, hasAuthenticated, hasCrm };
}

function evidenceSummary(
  row: LeadIdentityRow,
  provenanceRows: LeadIdentityProvenanceRow[],
  conflictDetected: boolean
): IdentityEvidenceSummary {
  const linking = linkingKeyTypesFromProvenance(row, provenanceRows);
  return {
    hasActor: row.externalActorReferenceHash !== null,
    linkingKeyTypes: linking.types,
    hasAuthenticatedCustomerReference: linking.hasAuthenticated,
    hasCrmExternalReference: linking.hasCrm,
    conflictDetected,
  };
}

function handoffObservationCount(provenanceRows: LeadIdentityProvenanceRow[]): number {
  return provenanceRows.filter((p) => p.kind === "opportunity_handoff").length;
}

/** Recompute the derived identity state from durable evidence (pure inputs). */
function recomputeDerivedState(
  row: LeadIdentityRow,
  provenanceRows: LeadIdentityProvenanceRow[],
  conflictDetected: boolean
): { primaryIdentityType: IdentityType; identityStatus: IdentityStatus; identityConfidence: IdentityConfidence } {
  const linking = linkingKeyTypesFromProvenance(row, provenanceRows);
  let primaryIdentityType: IdentityType = row.externalActorReferenceHash ? "provider_actor" : "anonymous_thread";
  for (const keyType of linking.types) {
    primaryIdentityType = adoptPrimaryIdentityType(
      primaryIdentityType,
      linkingEvidenceTypeToIdentityType(keyType)
    );
  }
  const summary = evidenceSummary(row, provenanceRows, conflictDetected);
  return {
    primaryIdentityType,
    identityStatus: deriveIdentityStatus(row.identityStatus, summary),
    identityConfidence: deriveIdentityConfidence({
      hasActor: summary.hasActor,
      handoffObservationCount: handoffObservationCount(provenanceRows),
      linkingKeyTypeCount: new Set(linking.types).size,
      hasAuthenticatedCustomerReference: summary.hasAuthenticatedCustomerReference,
    }),
  };
}

async function assertEnvelopeOwnership(
  envelope: OpportunityHandoffEnvelope,
  sessionUserId: number,
  executor?: LeadIdentityStoreExecutor
): Promise<void> {
  if (envelope.userId !== sessionUserId) {
    throw new LeadIdentityOwnershipError(
      "OWNERSHIP_MISMATCH",
      "handoff envelope tenant does not match the authenticated session."
    );
  }
  const db = executor ?? getDb();
  if (envelope.businessId !== null) {
    const [business] = await db
      .select({ id: businesses.id })
      .from(businesses)
      .where(and(eq(businesses.id, envelope.businessId), eq(businesses.userId, sessionUserId)))
      .limit(1);
    if (!business) {
      throw new LeadIdentityOwnershipError(
        "OWNERSHIP_MISMATCH",
        `business ${envelope.businessId} is not owned by the session tenant.`
      );
    }
  }
  if (envelope.campaignId !== null) {
    const [campaign] = await db
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(and(eq(campaigns.id, envelope.campaignId), eq(campaigns.userId, sessionUserId)))
      .limit(1);
    if (!campaign) {
      throw new LeadIdentityOwnershipError(
        "OWNERSHIP_MISMATCH",
        `campaign ${envelope.campaignId} is not owned by the session tenant.`
      );
    }
  }
}

// ─── A2/A7 — R5 opportunity handoff consumption (exact-once) ───

export interface ConsumeHandoffInput {
  /** Raw (untrusted) envelope object — validated + tamper-verified here. */
  envelope: unknown;
  /** Authenticated tenant user. */
  userId: number;
  now?: Date;
  executor?: LeadIdentityStoreExecutor;
  config?: Partial<LeadIdentityServiceConfig>;
}

export interface LeadIdentityIntakeOutcome {
  result: "MATCH" | "NO_MATCH";
  duplicateClassification: LeadIdentityDuplicateClassification;
  leadId: string;
  identityStatus: IdentityStatus;
  identityConfidence: IdentityConfidence;
  primaryIdentityType: IdentityType;
}

export async function consumeOpportunityHandoff(
  input: ConsumeHandoffInput
): Promise<LeadIdentityIntakeOutcome> {
  const cfg = { ...DEFAULT_LEAD_IDENTITY_CONFIG, ...input.config };
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const executor = input.executor;

  // Untrusted-data gate: strict schema + deterministic tamper verification.
  const envelope = validateHandoffEnvelope(input.envelope);
  verifyHandoffEnvelopeIntegrity(envelope);

  await assertEnvelopeOwnership(envelope, input.userId, executor);

  // Lineage + staleness: the opportunity candidate must be durably handed off;
  // fully out-of-window evidence is a stale handoff (fails closed).
  const candidate = await opportunityStore.findCandidateByOpportunityId(
    input.userId,
    envelope.opportunityId,
    executor
  );
  if (!candidate) {
    throw new LeadIdentityInputError(
      "STALE_HANDOFF",
      "opportunity candidate lineage is missing for this handoff; refusing intake."
    );
  }
  if (candidate.opportunityStatus !== "handed_off_to_r6") {
    throw new LeadIdentityInputError(
      "STALE_HANDOFF",
      `opportunity candidate is in status ${candidate.opportunityStatus}; expected handed_off_to_r6.`
    );
  }
  if (now.getTime() - Date.parse(envelope.lastObservedAt) > cfg.staleEvidenceMs) {
    throw new LeadIdentityInputError(
      "STALE_HANDOFF",
      "handoff evidence is fully outside the accepted evidence window."
    );
  }

  // Exact-once anchor: one handoff is consumed at most once per tenant.
  const consumed = await store.findProvenanceByHandoff(input.userId, envelope.handoffId, executor);
  if (consumed) {
    const existing = await store.findIdentityByLeadId(input.userId, consumed.leadId, executor);
    if (!existing) {
      throw new LeadIdentityInputError(
        "STALE_HANDOFF",
        "consumed handoff references a missing lead identity; refusing to re-derive."
      );
    }
    const canonical = await followCanonicalChain(input.userId, existing, executor);
    return {
      result: "MATCH",
      duplicateClassification: "idempotent_replay",
      leadId: canonical.leadId,
      identityStatus: canonical.identityStatus,
      identityConfidence: canonical.identityConfidence,
      primaryIdentityType: canonical.primaryIdentityType,
    };
  }

  // Deterministic identity coordinates (contract §1).
  const coordinates = buildIdentityCoordinates(envelope);
  const identityKey = deriveIdentityKey(coordinates);
  const leadId = deriveLeadId(identityKey);
  const envelopeHash = deriveEnvelopeHash(envelope);
  const provenanceHash = sha256Hex(
    canonicalJson({ kind: "opportunity_handoff", handoffId: envelope.handoffId, envelopeHash })
  );

  let identity = await store.findIdentityByKey(input.userId, identityKey, executor);
  let created = false;

  if (!identity) {
    // New canonical identity — unique (userId, identityKey) serializes races.
    const insertResult = await store.insertIdentity(
      {
        leadId,
        identityKey,
        contractVersion: LEAD_IDENTITY_CONTRACT_VERSION,
        userId: input.userId,
        businessId: envelope.businessId,
        primaryIdentityType: envelope.actorKey === "no-actor" ? "anonymous_thread" : "provider_actor",
        identityStatus: envelope.actorKey === "no-actor" ? "anonymous" : "active",
        identityConfidence: envelope.actorKey === "no-actor" ? "unknown" : "low",
        externalActorReferenceHash: envelope.actorKey === "no-actor" ? null : envelope.actorKey,
        provider: envelope.provider,
        emailIdentityHash: null,
        phoneIdentityHash: null,
        customerReferenceHash: null,
        sourceOpportunityId: envelope.opportunityId,
        sourceHandoffId: envelope.handoffId,
        canonicalLeadId: null,
        firstObservedAt: envelope.firstObservedAt,
        lastObservedAt: envelope.lastObservedAt,
        provenanceCount: 1,
        identityEvidenceCount: 0,
        version: 1,
        statusChangedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      executor
    );
    identity = insertResult.row;
    created = insertResult.inserted;
  }

  // Canonical chain (the matched identity may itself have been merged).
  identity = await followCanonicalChain(input.userId, identity, executor);

  // Immutable provenance — unique (userId, handoffId) is the consumption anchor.
  const provenanceResult = await store.insertProvenance(
    {
      leadRowId: Number(identity.id),
      leadId: identity.leadId,
      userId: input.userId,
      kind: "opportunity_handoff",
      handoffId: envelope.handoffId,
      opportunityId: envelope.opportunityId,
      provider: envelope.provider,
      campaignId: envelope.campaignId,
      publicationId: envelope.publicationId,
      evidenceType: null,
      evidenceHash: provenanceHash,
      envelopeHash,
      occurredAt: envelope.lastObservedAt,
      createdAt: now,
    },
    executor
  );

  if (!provenanceResult.inserted) {
    // Lost a concurrent consumption race after identity convergence: replay.
    const canonical = await followCanonicalChain(input.userId, identity, executor);
    return {
      result: "MATCH",
      duplicateClassification: "idempotent_replay",
      leadId: canonical.leadId,
      identityStatus: canonical.identityStatus,
      identityConfidence: canonical.identityConfidence,
      primaryIdentityType: canonical.primaryIdentityType,
    };
  }

  // Refresh observations and re-derive bounded state from durable evidence.
  const provenanceRows = await store.listProvenanceForLead(Number(identity.id), executor);
  const derived = recomputeDerivedState(identity, provenanceRows, false);
  const lastObservedAt =
    Date.parse(envelope.lastObservedAt) > Date.parse(identity.lastObservedAt)
      ? envelope.lastObservedAt
      : identity.lastObservedAt;
  const updated = await store.updateIdentityState(
    input.userId,
    Number(identity.id),
    identity.version,
    {
      lastObservedAt,
      provenanceCount: provenanceRows.length,
      primaryIdentityType: derived.primaryIdentityType,
      identityStatus: derived.identityStatus,
      identityConfidence: derived.identityConfidence,
      statusChangedAt:
        derived.identityStatus !== identity.identityStatus ? now : identity.statusChangedAt,
      updatedAt: now,
    },
    executor
  );

  await emitIdentityAudit({
    eventType: created ? "lead_identity_created" : "lead_identity_observed",
    userId: input.userId,
    businessId: updated.businessId ? Number(updated.businessId) : null,
    campaignId: envelope.campaignId,
    occurredAt: nowIso,
    metadata: {
      leadId: updated.leadId,
      handoffId: envelope.handoffId,
      opportunityId: envelope.opportunityId,
      action: created ? "lead_identity_created" : "opportunity_handoff_observed",
      identityStatus: updated.identityStatus,
      identityConfidence: updated.identityConfidence,
      provenanceCount: provenanceRows.length,
      envelopeHash,
    },
    executor,
  });

  return {
    result: created ? "NO_MATCH" : "MATCH",
    duplicateClassification: "none",
    leadId: updated.leadId,
    identityStatus: updated.identityStatus,
    identityConfidence: updated.identityConfidence,
    primaryIdentityType: updated.primaryIdentityType,
  };
}

// ─── A3/A5 — controlled enrichment, deterministic merge, conflict ───

export interface SubmitIdentityEvidenceInput {
  userId: number;
  leadId: string;
  evidenceType: "email" | "phone" | "authenticated_customer_reference" | "crm_external_reference";
  /** Raw value — validated, normalized, hashed server-side; never persisted. */
  value: string;
  now?: Date;
  executor?: LeadIdentityStoreExecutor;
}

export interface LeadIdentityEvidenceOutcome {
  result: "ATTACHED" | "MERGED" | "CONFLICT" | "IDEMPOTENT_REPLAY";
  leadId: string;
  identityStatus: IdentityStatus;
  identityConfidence: IdentityConfidence;
  primaryIdentityType: IdentityType;
  merge?: { mergeId: string; canonicalLeadId: string; absorbedLeadId: string };
  conflict?: { withLeadId: string; reason: string };
}

function toCandidateView(row: LeadIdentityRow) {
  return {
    leadId: row.leadId,
    businessScope: row.businessId ? Number(row.businessId) : null,
    identityStatus: row.identityStatus as IdentityStatus,
    emailIdentityHash: row.emailIdentityHash,
    phoneIdentityHash: row.phoneIdentityHash,
    customerReferenceHash: row.customerReferenceHash,
  };
}

export async function submitIdentityEvidence(
  input: SubmitIdentityEvidenceInput
): Promise<LeadIdentityEvidenceOutcome> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const executor = input.executor;

  const verified = toVerifiedIdentityKey(input.evidenceType, input.value);

  let lead = await store.findIdentityByLeadId(input.userId, input.leadId, executor);
  if (!lead) {
    throw new LeadIdentityInputError("LEAD_NOT_FOUND", `lead identity ${input.leadId} not found for tenant.`);
  }
  lead = await followCanonicalChain(input.userId, lead, executor);
  if (
    lead.identityStatus === "suppressed" ||
    lead.identityStatus === "archived" ||
    lead.identityStatus === "conflicting"
  ) {
    throw new LeadIdentityStateConflictError(
      "IDENTITY_STATE_CONFLICT",
      `lead identity is ${lead.identityStatus}; enrichment requires governance resolution first.`
    );
  }

  const owner = await store.findIdentityByLinkingHash(input.userId, verified.column, verified.hash, executor);

  if (owner) {
    const ownerCanonical = await followCanonicalChain(input.userId, owner, executor);
    if (ownerCanonical.leadId === lead.leadId) {
      return {
        result: "IDEMPOTENT_REPLAY",
        leadId: lead.leadId,
        identityStatus: lead.identityStatus,
        identityConfidence: lead.identityConfidence,
        primaryIdentityType: lead.primaryIdentityType,
      };
    }
    const decision = classifyIdentityResolution(
      {
        actorKey: lead.externalActorReferenceHash,
        provider: lead.provider,
        crossChannel: false,
      },
      toCandidateView(lead),
      { ...toCandidateView(ownerCanonical), keyType: verified.keyType }
    );
    if (decision.requiresMerge) {
      return performDeterministicMerge({
        userId: input.userId,
        leadA: lead,
        leadB: ownerCanonical,
        keyType: verified.keyType,
        keyHash: verified.hash,
        now,
        executor,
      });
    }
    return recordIdentityConflict({
      userId: input.userId,
      lead,
      otherLead: ownerCanonical,
      keyType: verified.keyType,
      keyHash: verified.hash,
      reason: decision.reason,
      now,
      executor,
    });
  }

  // Authoritative key with no current owner — attach to this identity.
  const provenanceHash = sha256Hex(
    canonicalJson({ kind: "identity_evidence", keyType: verified.keyType, hash: verified.hash })
  );
  const provenanceResult = await store.insertProvenance(
    {
      leadRowId: Number(lead.id),
      leadId: lead.leadId,
      userId: input.userId,
      kind: "identity_evidence",
      handoffId: null,
      opportunityId: null,
      provider: null,
      campaignId: null,
      publicationId: null,
      evidenceType: verified.keyType,
      evidenceHash: provenanceHash,
      envelopeHash: null,
      occurredAt: nowIso,
      createdAt: now,
    },
    executor
  );
  if (!provenanceResult.inserted) {
    return {
      result: "IDEMPOTENT_REPLAY",
      leadId: lead.leadId,
      identityStatus: lead.identityStatus,
      identityConfidence: lead.identityConfidence,
      primaryIdentityType: lead.primaryIdentityType,
    };
  }

  // Column write + derived-state recompute in one CAS-guarded patch.
  const withKey = { ...lead, [verified.column]: verified.hash } as LeadIdentityRow;
  const provenanceRows = [...(await store.listProvenanceForLead(Number(lead.id), executor))];
  const derived = recomputeDerivedState(withKey, provenanceRows, false);
  const updated = await store.updateIdentityState(
    input.userId,
    Number(lead.id),
    lead.version,
    {
      [verified.column]: verified.hash,
      identityEvidenceCount: provenanceRows.filter((p) => p.kind === "identity_evidence").length,
      primaryIdentityType: derived.primaryIdentityType,
      identityStatus: derived.identityStatus,
      identityConfidence: derived.identityConfidence,
      statusChangedAt:
        derived.identityStatus !== lead.identityStatus ? now : lead.statusChangedAt,
      updatedAt: now,
    },
    executor
  );

  await emitIdentityAudit({
    eventType: "lead_identity_evidence_attached",
    userId: input.userId,
    businessId: updated.businessId ? Number(updated.businessId) : null,
    campaignId: null,
    occurredAt: nowIso,
    metadata: {
      leadId: updated.leadId,
      evidenceType: verified.keyType,
      evidenceHash: verified.hash,
      identityStatus: updated.identityStatus,
      identityConfidence: updated.identityConfidence,
    },
    executor,
  });

  return {
    result: "ATTACHED",
    leadId: updated.leadId,
    identityStatus: updated.identityStatus,
    identityConfidence: updated.identityConfidence,
    primaryIdentityType: updated.primaryIdentityType,
  };
}

interface MergeExecutionInput {
  userId: number;
  leadA: LeadIdentityRow;
  leadB: LeadIdentityRow;
  keyType: LinkingEvidenceType;
  keyHash: string;
  now: Date;
  executor?: LeadIdentityStoreExecutor;
}

/**
 * Deterministic merge (contract §8): the older identity is canonical; the
 * absorbed identity is terminal (merged) with a canonical pointer; linking-key
 * ownership moves to the canonical row (where null) with immutable lineage on
 * both sides. Unique merge anchors make replays converge. Cross-business and
 * ineligible-status merges are impossible (blocked upstream by the classifier;
 * double-checked here — fail closed).
 */
async function performDeterministicMerge(input: MergeExecutionInput): Promise<LeadIdentityEvidenceOutcome> {
  const { userId, keyType, keyHash, now, executor } = input;
  const nowIso = now.toISOString();

  if (input.leadA.leadId === input.leadB.leadId) {
    throw new LeadIdentityInputError("MERGE_BLOCKED", "cannot merge an identity with itself.");
  }
  if (!sameBusinessScope(input.leadA.businessId ? Number(input.leadA.businessId) : null, input.leadB.businessId ? Number(input.leadB.businessId) : null)) {
    throw new LeadIdentityStateConflictError(
      "MERGE_BLOCKED",
      "cross-business merge is impossible; identities remain separate."
    );
  }
  if (isTerminalIdentityStatus(input.leadA.identityStatus) || isTerminalIdentityStatus(input.leadB.identityStatus)) {
    throw new LeadIdentityStateConflictError(
      "MERGE_BLOCKED",
      "a terminal identity cannot participate in an automatic merge."
    );
  }

  // Canonical designation: older createdAt wins; lower row id breaks ties.
  const aTime = Date.parse(String(input.leadA.createdAt));
  const bTime = Date.parse(String(input.leadB.createdAt));
  const canonical =
    aTime < bTime || (aTime === bTime && Number(input.leadA.id) < Number(input.leadB.id))
      ? input.leadA
      : input.leadB;
  const absorbed = canonical.leadId === input.leadA.leadId ? input.leadB : input.leadA;

  const mergeId = `${MERGE_ID_PREFIX}${sha256Hex(
    canonicalJson({
      userId,
      canonicalLeadId: canonical.leadId,
      absorbedLeadId: absorbed.leadId,
      linkingEvidenceType: keyType,
      linkingEvidenceHash: keyHash,
    })
  )}`;
  const mergeHash = sha256Hex(canonicalJson({ kind: "merge", mergeId }));

  const mergeResult = await store.insertMerge(
    {
      mergeId,
      mergeHash,
      userId,
      canonicalLeadId: canonical.leadId,
      absorbedLeadId: absorbed.leadId,
      linkingEvidenceType: keyType,
      linkingEvidenceHash: keyHash,
      createdAt: now,
    },
    executor
  );
  const mergeReplayed = !mergeResult.inserted;

  // Move linking-key ownership to the canonical row where null; absorbed row
  // relinquishes key columns (evidence persists in provenance + merge record).
  const inherited: { column: "emailIdentityHash" | "phoneIdentityHash" | "customerReferenceHash"; hash: string; keyType: LinkingEvidenceType }[] = [];
  const canonicalPatch: store.IdentityStatePatch = { updatedAt: now };
  const absorbedPatch: store.IdentityStatePatch = {
    identityStatus: "merged",
    canonicalLeadId: canonical.leadId,
    emailIdentityHash: null,
    phoneIdentityHash: null,
    customerReferenceHash: null,
    statusChangedAt: now,
    updatedAt: now,
  };
  const absorbedKeys: { column: "emailIdentityHash" | "phoneIdentityHash" | "customerReferenceHash"; hash: string | null }[] = [
    { column: "emailIdentityHash", hash: absorbed.emailIdentityHash },
    { column: "phoneIdentityHash", hash: absorbed.phoneIdentityHash },
    { column: "customerReferenceHash", hash: absorbed.customerReferenceHash },
  ];
  for (const { column, hash } of absorbedKeys) {
    if (!hash) continue;
    if (canonical[column] === null) {
      (canonicalPatch as Record<string, unknown>)[column] = hash;
      inherited.push({ column, hash, keyType: column === "emailIdentityHash" ? "email_hash" : column === "phoneIdentityHash" ? "phone_hash" : keyType });
    }
  }

  let updatedCanonical = await store.updateIdentityState(
    userId,
    Number(canonical.id),
    canonical.version,
    canonicalPatch,
    executor
  );
  await store.updateIdentityState(
    userId,
    Number(absorbed.id),
    absorbed.version,
    absorbedPatch,
    executor
  ).catch((err) => {
    // A raced replay may have already absorbed; merge record is durable — converge.
    if (!(err instanceof LeadIdentityStateConflictError)) throw err;
  });

  // Merge lineage on both identities + inherited-key lineage on canonical.
  for (const leadRef of [canonical, absorbed] as const) {
    const refHash = sha256Hex(canonicalJson({ kind: "merge", mergeId, leadId: leadRef.leadId }));
    await store.insertProvenance(
      {
        leadRowId: Number(leadRef.id),
        leadId: leadRef.leadId,
        userId,
        kind: "merge",
        handoffId: null,
        opportunityId: null,
        provider: null,
        campaignId: null,
        publicationId: null,
        evidenceType: keyType,
        evidenceHash: refHash,
        envelopeHash: null,
        occurredAt: nowIso,
        createdAt: now,
      },
      executor
    ).catch(() => undefined);
  }
  for (const item of inherited) {
    const refHash = sha256Hex(
      canonicalJson({ kind: "identity_evidence", keyType: item.keyType, hash: item.hash, inheritedFrom: absorbed.leadId })
    );
    await store.insertProvenance(
      {
        leadRowId: Number(updatedCanonical.id),
        leadId: updatedCanonical.leadId,
        userId,
        kind: "identity_evidence",
        handoffId: null,
        opportunityId: null,
        provider: null,
        campaignId: null,
        publicationId: null,
        evidenceType: item.keyType,
        evidenceHash: refHash,
        envelopeHash: null,
        occurredAt: nowIso,
        createdAt: now,
      },
      executor
    ).catch(() => undefined);
  }

  // Re-derive canonical state over its full provenance.
  const canonicalRows = await store.listProvenanceForLead(Number(updatedCanonical.id), executor);
  const derived = recomputeDerivedState(updatedCanonical, canonicalRows, false);
  updatedCanonical = await store.updateIdentityState(
    userId,
    Number(updatedCanonical.id),
    updatedCanonical.version,
    {
      primaryIdentityType: derived.primaryIdentityType,
      identityStatus: derived.identityStatus,
      identityConfidence: derived.identityConfidence,
      provenanceCount: canonicalRows.length,
      statusChangedAt:
        derived.identityStatus !== updatedCanonical.identityStatus ? now : updatedCanonical.statusChangedAt,
      updatedAt: now,
    },
    executor
  ).catch(() => updatedCanonical);

  if (!mergeReplayed) {
    await emitIdentityAudit({
      eventType: "lead_identity_merged",
      userId,
      businessId: updatedCanonical.businessId ? Number(updatedCanonical.businessId) : null,
      campaignId: null,
      occurredAt: nowIso,
      metadata: {
        mergeId,
        canonicalLeadId: canonical.leadId,
        absorbedLeadId: absorbed.leadId,
        linkingEvidenceType: keyType,
        linkingEvidenceHash: keyHash,
      },
      executor,
    });
  }

  return {
    result: "MERGED",
    leadId: updatedCanonical.leadId,
    identityStatus: updatedCanonical.identityStatus,
    identityConfidence: updatedCanonical.identityConfidence,
    primaryIdentityType: updatedCanonical.primaryIdentityType,
    merge: { mergeId, canonicalLeadId: canonical.leadId, absorbedLeadId: absorbed.leadId },
  };
}

interface ConflictRecordingInput {
  userId: number;
  lead: LeadIdentityRow;
  otherLead: LeadIdentityRow;
  keyType: LinkingEvidenceType;
  keyHash: string;
  reason: string;
  now: Date;
  executor?: LeadIdentityStoreExecutor;
}

/** Conflicting authoritative identifiers fail safely: no silent merge. */
async function recordIdentityConflict(input: ConflictRecordingInput): Promise<LeadIdentityEvidenceOutcome> {
  const { userId, lead, otherLead, keyType, keyHash, reason, now, executor } = input;
  const nowIso = now.toISOString();

  const conflictHash = sha256Hex(
    canonicalJson({
      kind: "conflict",
      leadId: lead.leadId,
      otherLeadId: otherLead.leadId,
      keyType,
      keyHash,
    })
  );
  await store.insertProvenance(
    {
      leadRowId: Number(lead.id),
      leadId: lead.leadId,
      userId,
      kind: "conflict",
      handoffId: null,
      opportunityId: null,
      provider: null,
      campaignId: null,
      publicationId: null,
      evidenceType: keyType,
      evidenceHash: conflictHash,
      envelopeHash: null,
      occurredAt: nowIso,
      createdAt: now,
    },
    executor
  ).catch(() => undefined);

  let updated = lead;
  if (lead.identityStatus !== "conflicting") {
    updated = await store.updateIdentityState(
      userId,
      Number(lead.id),
      lead.version,
      { identityStatus: "conflicting", statusChangedAt: now, updatedAt: now },
      executor
    );
  }
  await store
    .updateIdentityState(
      userId,
      Number(otherLead.id),
      otherLead.version,
      { identityStatus: "conflicting", statusChangedAt: now, updatedAt: now },
      executor
    )
    .catch(() => undefined);

  await emitIdentityAudit({
    eventType: "lead_identity_conflict",
    userId,
    businessId: lead.businessId ? Number(lead.businessId) : null,
    campaignId: null,
    occurredAt: nowIso,
    metadata: {
      leadId: lead.leadId,
      conflictingLeadId: otherLead.leadId,
      evidenceType: keyType,
      evidenceHash: keyHash,
      reason,
    },
    executor,
  });

  return {
    result: "CONFLICT",
    leadId: updated.leadId,
    identityStatus: updated.identityStatus,
    identityConfidence: updated.identityConfidence,
    primaryIdentityType: updated.primaryIdentityType,
    conflict: { withLeadId: otherLead.leadId, reason },
  };
}

// ─── Governance: suppression / archival ───

export interface GovernIdentityInput {
  userId: number;
  leadId: string;
  reason?: IdentitySuppressionReason;
  now?: Date;
  executor?: LeadIdentityStoreExecutor;
}

export async function suppressLeadIdentity(
  input: GovernIdentityInput
): Promise<LeadIdentityProjection> {
  return governIdentityTransition(input, "suppressed", "lead_identity_suppressed");
}

export async function archiveLeadIdentity(
  input: GovernIdentityInput
): Promise<LeadIdentityProjection> {
  return governIdentityTransition(input, "archived", "lead_identity_archived");
}

async function governIdentityTransition(
  input: GovernIdentityInput,
  target: "suppressed" | "archived",
  eventType: "lead_identity_suppressed" | "lead_identity_archived"
): Promise<LeadIdentityProjection> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const executor = input.executor;

  let lead = await store.findIdentityByLeadId(input.userId, input.leadId, executor);
  if (!lead) {
    throw new LeadIdentityInputError("LEAD_NOT_FOUND", `lead identity ${input.leadId} not found for tenant.`);
  }
  lead = await followCanonicalChain(input.userId, lead, executor);
  if (isTerminalIdentityStatus(lead.identityStatus)) {
    throw new LeadIdentityStateConflictError(
      "IDENTITY_STATE_CONFLICT",
      `lead identity is already ${lead.identityStatus}.`
    );
  }
  const updated = await store.updateIdentityState(
    input.userId,
    Number(lead.id),
    lead.version,
    { identityStatus: target, statusChangedAt: now, updatedAt: now },
    executor
  );
  await emitIdentityAudit({
    eventType,
    userId: input.userId,
    businessId: updated.businessId ? Number(updated.businessId) : null,
    campaignId: null,
    occurredAt: nowIso,
    metadata: {
      leadId: updated.leadId,
      action: target,
      fromStatus: lead.identityStatus,
      reason: input.reason ?? null,
    },
    executor,
  });
  const rows = await store.listProvenanceForLead(Number(updated.id), executor);
  return toLeadIdentityProjection(updated, rows);
}

// ─── A8 — downstream-safe read surface ───

export async function getLeadIdentity(
  userId: number,
  leadId: string,
  executor?: LeadIdentityStoreExecutor
): Promise<LeadIdentityProjection> {
  const lead = await store.findIdentityByLeadId(userId, leadId, executor);
  if (!lead) {
    throw new LeadIdentityInputError("LEAD_NOT_FOUND", `lead identity ${leadId} not found for tenant.`);
  }
  const rows = await store.listProvenanceForLead(Number(lead.id), executor);
  return toLeadIdentityProjection(lead, rows);
}

export async function listLeadIdentities(
  userId: number,
  filters: { status?: string; identityType?: string; businessId?: number } = {},
  limit = 50,
  executor?: LeadIdentityStoreExecutor
): Promise<LeadIdentityProjection[]> {
  const rows = await store.listIdentities(userId, filters, limit, executor);
  return rows.map((row) => toLeadIdentityProjection(row, []));
}
