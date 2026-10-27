// ─── R6-B Lead Scoring — immutable evidence snapshot (B5) ───
//
// PURE module: builds the tamper-evident evidence manifest a score binds to.
// One lead + one evidence snapshot + one scoring version → one score identity
// (scoring contract §5). Manifest entries are references + closed labels only
// (no social text, no actor PII), sorted deterministically so the hash is
// stable for identical evidence.

import {
  IDENTITY_SEAM_VERSION,
  SCORE_ID_PREFIX,
  SNAPSHOT_ID_PREFIX,
  sha256Hex,
  canonicalJson,
  LEAD_SCORING_CONTRACT_VERSION,
  FEATURE_VERSION,
} from "./scoring-contract";
import type { LeadIdentityRef } from "./lead-identity-seam";

export interface EvidenceManifestEntry {
  opportunityId: string;
  interpretationId: string;
  signalId: string;
  signalVersion: number;
  kind: string;
  occurredAt: string;
}

export interface EvidenceSnapshot {
  snapshotId: string;
  snapshotHash: string;
  manifest: EvidenceManifestEntry[];
}

export interface EvidenceRowLike {
  candidateId: number;
  interpretationId: string;
  signalId: string;
  signalVersion: number;
  kind: string;
  occurredAt: string;
}

function compareManifestEntries(a: EvidenceManifestEntry, b: EvidenceManifestEntry): number {
  if (a.opportunityId !== b.opportunityId) return a.opportunityId < b.opportunityId ? -1 : 1;
  if (a.interpretationId !== b.interpretationId) return a.interpretationId < b.interpretationId ? -1 : 1;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  return 0;
}

/**
 * Build the deterministic evidence snapshot. `opportunityIdByCandidateId`
 * maps each evidence row's candidateId to its opaque opportunity id.
 */
export function buildEvidenceSnapshot(
  identity: LeadIdentityRef,
  evidenceRows: readonly EvidenceRowLike[],
  opportunityIdByCandidateId: ReadonlyMap<number, string>
): EvidenceSnapshot {
  const manifest: EvidenceManifestEntry[] = evidenceRows
    .map((row) => ({
      opportunityId: opportunityIdByCandidateId.get(Number(row.candidateId)) ?? "unknown",
      interpretationId: row.interpretationId,
      signalId: row.signalId,
      signalVersion: Number(row.signalVersion),
      kind: row.kind,
      occurredAt: row.occurredAt,
    }))
    .sort(compareManifestEntries);

  const snapshotHash = sha256Hex(canonicalJson(manifest));
  const snapshotId = `${SNAPSHOT_ID_PREFIX}${sha256Hex(
    canonicalJson({
      identitySeamVersion: IDENTITY_SEAM_VERSION,
      leadId: identity.leadId,
      leadIdentityVersion: identity.identityVersion,
      evidenceSnapshotHash: snapshotHash,
    })
  )}`;
  return { snapshotId, snapshotHash, manifest };
}

/**
 * Deterministic score identity (scoring contract §5). Same inputs → same id.
 */
export function deriveLeadScoreId(input: {
  userId: number;
  leadId: number;
  leadIdentityVersion: string;
  evidenceSnapshotHash: string;
  scoringVersion: string;
}): string {
  return `${SCORE_ID_PREFIX}${sha256Hex(
    canonicalJson({
      scoreContractVersion: LEAD_SCORING_CONTRACT_VERSION,
      userId: input.userId,
      leadId: input.leadId,
      leadIdentityVersion: input.leadIdentityVersion,
      evidenceSnapshotHash: input.evidenceSnapshotHash,
      scoringVersion: input.scoringVersion,
      featureVersion: FEATURE_VERSION,
    })
  )}`;
}
