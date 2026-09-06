import type { RenderedCreativeEvidence } from "./premium-rubric";
import { isTrustedRenderedCreativeEvidence } from "./rendered-creative-evaluator";

export interface RenderedEvidenceIdentity {
  workflowOperationId: string;
  contractFingerprint: string;
  candidateId: string;
  renderedAssetFingerprint: string;
}

export type RenderedEvidenceRegistrationStatus =
  | "stored"
  | "idempotent_replay"
  | "rejected_untrusted"
  | "rejected_identity_mismatch"
  | "rejected_conflicting_duplicate";

export interface RenderedEvidenceRegistrationResult {
  status: RenderedEvidenceRegistrationStatus;
  evidence: RenderedCreativeEvidence | null;
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function keyFor(identity: RenderedEvidenceIdentity): string {
  return JSON.stringify([
    identity.workflowOperationId,
    identity.contractFingerprint,
    identity.candidateId,
    identity.renderedAssetFingerprint,
  ]);
}

/**
 * Request-scoped only. Callers own the instance and must not serialize it.
 */
export class InMemoryRenderedEvidenceRegistry {
  private readonly evidenceByKey = new Map<string, RenderedCreativeEvidence>();

  register(
    identity: RenderedEvidenceIdentity,
    evidence: unknown
  ): RenderedEvidenceRegistrationResult {
    if (!isTrustedRenderedCreativeEvidence(evidence)) {
      return { status: "rejected_untrusted", evidence: null };
    }
    if (
      !isNonEmptyText(identity.workflowOperationId) ||
      !isNonEmptyText(identity.contractFingerprint) ||
      !isNonEmptyText(identity.candidateId) ||
      !isNonEmptyText(identity.renderedAssetFingerprint) ||
      evidence.renderedAssetFingerprint !== identity.renderedAssetFingerprint
    ) {
      return { status: "rejected_identity_mismatch", evidence: null };
    }

    const key = keyFor(identity);
    const existing = this.evidenceByKey.get(key);
    if (existing === evidence) {
      return { status: "idempotent_replay", evidence };
    }
    if (existing) {
      return { status: "rejected_conflicting_duplicate", evidence: null };
    }

    this.evidenceByKey.set(key, evidence);
    return { status: "stored", evidence };
  }

  find(identity: RenderedEvidenceIdentity): RenderedCreativeEvidence | null {
    return this.evidenceByKey.get(keyFor(identity)) ?? null;
  }
}