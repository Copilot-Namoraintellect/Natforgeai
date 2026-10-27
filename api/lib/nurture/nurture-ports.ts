// ─── R6-D Nurture / Sales Handoff — production upstream ports (R6-X) ───
//
// Wires the frozen NurtureUpstreamPorts to the governed R6 infrastructure.
// No upstream authority is duplicated here:
//   - qualification projection: built by R6-C's own service (single authority);
//   - lead identity: R6-A rows read exactly as stored (tenant-predicated);
//   - privacy evidence: R6-F's store read reused (numeric-keyed chain);
//   - conversions: R6-E rows read exactly as stored;
//   - approvals: the existing R5 approval_requests ledger read as stored.
// Every payload is returned RAW — D's frozen validators (nurture-upstream)
// re-validate shape, versions, and closed vocabularies before use. Reads are
// tenant-anchored (eq(userId) everywhere); the lid1 → numeric lead key is
// resolved only through the accepted authoritative chain (current C decision
// → its R6-B score → score-authoritative numeric leads.id), never from a bare
// client id. Missing hops fail closed.

import { and, desc, eq, type SQL } from "drizzle-orm";
import {
  approvalRequests,
  conversionEvents,
  leadIdentities,
  leadQualifications,
  leadScoreSnapshots,
} from "@db/schema";
import { getDb } from "../../queries/connection";
import { readLeadPrivacyEvidence } from "../governance/lead-privacy-store";
import { ProviderAuthorityUnavailable } from "../qualification/qualification-bridge";
import {
  ProviderLeadNotFound,
  ProviderPrivacyScopeMismatch,
  ProviderScoreNotFound,
  getHandoffProjectionForUser,
  type QualificationAuthorityDeps,
} from "../qualification/qualification-service";
import {
  bindQualificationStoreExecutor,
  createQualificationBridgeProvider,
} from "../qualification/qualification-bridge";
import type { NurtureUpstreamPorts } from "./nurture-service";

type Db = ReturnType<typeof getDb>;

/** The accepted authoritative chain: current C decision → its B score →
 *  score-authoritative numeric leads.id. Any missing/ambiguous hop ⇒ null
 *  (the caller fails closed). */
async function resolveScoreAuthoritativeLeadKey(
  db: Db,
  userId: number,
  leadId: string
): Promise<{ numericLeadId: number; businessId: number | null } | null> {
  const [current] = await db
    .select()
    .from(leadQualifications)
    .where(and(eq(leadQualifications.userId, userId), eq(leadQualifications.leadId, leadId)))
    .orderBy(desc(leadQualifications.evaluatedAt), desc(leadQualifications.qualificationId))
    .limit(1);
  if (!current) return null;
  const [score] = await db
    .select()
    .from(leadScoreSnapshots)
    .where(
      and(
        eq(leadScoreSnapshots.userId, userId),
        eq(leadScoreSnapshots.leadScoreId, current.leadScoreId)
      )
    )
    .limit(1);
  if (!score) return null;
  return {
    numericLeadId: Number(score.leadId),
    businessId: score.businessId ?? current.businessId ?? null,
  };
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function isWorldResolutionError(err: unknown): boolean {
  return (
    err instanceof ProviderLeadNotFound ||
    err instanceof ProviderScoreNotFound ||
    err instanceof ProviderPrivacyScopeMismatch ||
    err instanceof ProviderAuthorityUnavailable ||
    (err instanceof Error && err.name === "QualificationInputError")
  );
}

/**
 * Production NurtureUpstreamPorts against the canonical schema. Each call
 * re-reads the upstream world; nothing is cached across calls.
 */
export function createNurtureProductionPorts(db: Db = getDb()): NurtureUpstreamPorts {
  return {
    async getQualificationProjection({ userId, qualificationId }) {
      const provider = createQualificationBridgeProvider(db, userId);
      const executor = bindQualificationStoreExecutor(db);
      const deps: QualificationAuthorityDeps = { provider };
      try {
        return await getHandoffProjectionForUser({ userId, qualificationId }, deps, executor);
      } catch (err) {
        if (!isWorldResolutionError(err)) throw err;
        // Missing qualification / unavailable authority: the world cannot be
        // established → D maps this to QUALIFICATION_NOT_FOUND and fails closed.
        return null;
      }
    },

    async getLeadIdentity({ userId, leadId }) {
      const [row] = await db
        .select()
        .from(leadIdentities)
        .where(and(eq(leadIdentities.userId, userId), eq(leadIdentities.leadId, leadId)))
        .limit(1);
      if (!row) return null;
      // Row as stored: D follows canonicalLeadId per the A contract.
      return {
        leadId: row.leadId,
        businessId: row.businessId === null ? null : Number(row.businessId),
        identityStatus: row.identityStatus,
        canonicalLeadId: row.canonicalLeadId,
      };
    },

    async getPrivacyEvidence({ userId, leadId }) {
      const key = await resolveScoreAuthoritativeLeadKey(db, userId, leadId);
      if (key === null) {
        return {
          available: false,
          reason: "authoritative_chain_unavailable",
          state: "ACTIVE",
          explicit: false,
          retentionDeadlineAt: null,
          previousState: null,
          source: null,
          actorUserId: null,
          updatedAt: null,
        };
      }
      const evidence = await readLeadPrivacyEvidence(db, key.numericLeadId);
      return {
        available: evidence.available,
        ...(evidence.reason !== undefined ? { reason: evidence.reason } : {}),
        state: evidence.state,
        explicit: evidence.explicit,
        retentionDeadlineAt: toIso(evidence.retentionDeadlineAt),
        previousState: evidence.previousState,
        source: evidence.source,
        actorUserId: evidence.actorUserId,
        updatedAt: toIso(evidence.updatedAt),
      };
    },

    async listConversionsForLead({ userId, leadId }) {
      const key = await resolveScoreAuthoritativeLeadKey(db, userId, leadId);
      if (key === null) return [];
      const conditions: SQL[] = [
        eq(conversionEvents.userId, userId),
        eq(conversionEvents.leadId, key.numericLeadId),
      ];
      if (key.businessId !== null) {
        conditions.push(eq(conversionEvents.businessId, key.businessId));
      }
      const rows = await db
        .select()
        .from(conversionEvents)
        .where(and(...conditions))
        .orderBy(desc(conversionEvents.occurredAt));
      return rows.map((row) => ({
        conversionId: row.conversionId,
        businessId: row.businessId === null ? 0 : Number(row.businessId),
        outcomeStatus: row.outcomeStatus,
        sourceTrustClass: row.sourceTrustClass,
        occurredAt: row.occurredAt,
      }));
    },

    async getApprovalRequest({ userId, approvalRequestId }) {
      const [row] = await db
        .select({
          id: approvalRequests.id,
          status: approvalRequests.status,
          context: approvalRequests.context,
        })
        .from(approvalRequests)
        .where(
          and(eq(approvalRequests.id, approvalRequestId), eq(approvalRequests.userId, userId))
        )
        .limit(1);
      if (!row) return null;
      return { id: row.id, status: row.status, context: row.context ?? null };
    },
  };
}
