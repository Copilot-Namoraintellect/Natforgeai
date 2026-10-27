// ─── R6-B Lead Scoring — lead identity seam (R6-X CONVERGED) ───
//
// R6-X convergence note (was: "R6-A pending — interim authority"). The frozen
// R6 streams bind identity through the SCORE RECORD, not through a code-level
// join: B scores the legacy numeric `leads` row (schema-frozen
// `lead_score_snapshots.leadId` is bigint) and mints a deterministic
// `identityVersion` over the lead's immutable coordinates. R6-C co-validates
// that score against the canonical R6-A `lid1` identity projection during
// qualification (binding = tenant + business scope + content hashes, never
// leadId equality), and R6-D re-establishes the same chain at execution time.
// That score-mediated binding is the ONE authoritative lid1 ↔ numeric
// `leads.id` mapping (X4); no fuzzy or client-controlled mapping exists here.
//
// This module therefore keeps two strictly server-side duties:
// - lead existence + tenant ownership are re-verified from the durable `leads`
//   row on every scoring call; forged / cross-tenant leadId fails closed;
// - `identityVersion` is derived deterministically from durable lead
//   coordinates — any reassignment (business/campaign) mints a new identity
//   version, hence new score versions (allowed by R6-C's version allow-list).
// The evidence scope binds a lead to R5 opportunity candidates via tenant +
// business + campaign attribution, restricted to evidence-bearing statuses.
//
// Scoring NEVER writes the leads table, never merges leads, never derives
// cross-tenant identity, and never consults R6-A authority directly — the
// canonical identity gate lives at R6-C/R6-D where the lid1 is authoritative.

import { and, eq } from "drizzle-orm";
import { leads, opportunityCandidates, type Lead } from "@db/schema";
import { getDb } from "../../queries/connection";
import {
  IDENTITY_SEAM_VERSION,
  ScoringOwnershipError,
  ScoringInputError,
  canonicalJson,
  sha256Hex,
} from "./scoring-contract";
import type { OpportunityCandidateRow } from "@db/schema";

type Db = ReturnType<typeof getDb>;

export interface ScoringExecutor {
  select: Db["select"];
  insert: Db["insert"];
}

export const SCORING_EVIDENCE_STATUSES = [
  "candidate",
  "strengthening",
  "weak",
  "handed_off_to_r6",
] as const;

/** Authoritative lead identity reference for scoring (server-resolved only). */
export interface LeadIdentityRef {
  leadId: number;
  userId: number;
  businessId: number | null;
  campaignId: number | null;
  /** Deterministic identity version binding (contract §8). */
  identityVersion: string;
}

export function deriveLeadIdentityVersion(lead: {
  id: number;
  userId: number;
  businessId: number | null;
  campaignId: number | null;
}): string {
  const coordinateHash = sha256Hex(
    canonicalJson({
      leadId: Number(lead.id),
      userId: Number(lead.userId),
      businessId: lead.businessId === null ? null : Number(lead.businessId),
      campaignId: lead.campaignId === null ? null : Number(lead.campaignId),
    })
  );
  return `${IDENTITY_SEAM_VERSION}:${coordinateHash}`;
}

/**
 * Resolve the authoritative identity for a lead, or fail closed. A leadId
 * that does not exist, or belongs to another tenant, is indistinguishable
 * from a forged id — both are LEAD_NOT_FOUND (no oracle leak).
 */
export async function resolveLeadIdentity(
  userId: number,
  leadId: number,
  executor?: ScoringExecutor
): Promise<LeadIdentityRef> {
  if (!Number.isInteger(leadId) || leadId <= 0) {
    throw new ScoringInputError("INVALID_LEAD_ID", "leadId must be a positive integer.");
  }
  const db = executor ?? getDb();
  const [row] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.userId, userId)))
    .limit(1);
  if (!row) {
    throw new ScoringOwnershipError(
      "LEAD_NOT_FOUND",
      `lead ${leadId} not found for tenant; refusing to score.`
    );
  }
  const lead = row as Lead;
  return {
    leadId: Number(lead.id),
    userId: Number(lead.userId),
    businessId: lead.businessId === null ? null : Number(lead.businessId),
    campaignId: lead.campaignId === null ? null : Number(lead.campaignId),
    identityVersion: deriveLeadIdentityVersion(lead),
  };
}

/**
 * Interim evidence scope (see header): opportunity candidates attributed to
 * this lead's tenant/business/campaign with evidence-bearing status. The
 * tenant predicate runs in the DB; attribution/status filtering is pure and
 * deterministic over the tenant-scoped set (keeps the rule explicit and
 * auditable). Replaced by authoritative R6-A lead→handoff linkage on
 * convergence.
 */
export async function listEvidenceScopeCandidates(
  identity: LeadIdentityRef,
  executor?: ScoringExecutor
): Promise<OpportunityCandidateRow[]> {
  const db = executor ?? getDb();
  const rows = await db
    .select()
    .from(opportunityCandidates)
    .where(eq(opportunityCandidates.userId, identity.userId));
  return rows.filter((row) => {
    if (!(SCORING_EVIDENCE_STATUSES as readonly string[]).includes(row.opportunityStatus)) {
      return false;
    }
    if (
      identity.campaignId !== null &&
      row.campaignId !== null &&
      Number(row.campaignId) !== identity.campaignId
    ) {
      // Cross-campaign candidates are out of scope for an attributed lead;
      // unattributed (tenant-scoped) candidates remain eligible (fit 0.40).
      return false;
    }
    if (
      identity.businessId !== null &&
      row.businessId !== null &&
      Number(row.businessId) !== identity.businessId
    ) {
      return false;
    }
    return true;
  });
}
