import type {
  CandidateSource,
  CanonicalMessagePackCopy,
  MessagePackCandidate,
  MessagePackCandidateProvenance,
} from "./contracts";
import { canonicalizeMessagePackCopy, type CanonicalCopyInput } from "./canonical-copy";
import { computeCopyHashSha256 } from "./hash";

export interface CreateMessagePackCandidateInput {
  readonly candidateId: string;
  readonly campaignId: number;
  readonly createdAtIso: string;
  readonly source: CandidateSource;
  readonly copy: CanonicalCopyInput;
  readonly businessDnaSnapshotId: string;
  readonly campaignStrategySnapshotId: string;
  readonly qualityPolicyId: string;
  readonly qualityPolicyVersion: number;
  readonly provenance: MessagePackCandidateProvenance;
}

function deepCloneCopy(copy: CanonicalMessagePackCopy): CanonicalMessagePackCopy {
  return {
    copySchemaVersion: copy.copySchemaVersion,
    headline: copy.headline,
    subheadline: copy.subheadline,
    benefitBulletsOrdered: [...copy.benefitBulletsOrdered],
    cta: copy.cta,
    footer: copy.footer
      ? {
          phone: copy.footer.phone,
          whatsapp: copy.footer.whatsapp,
          email: copy.footer.email,
          website: copy.footer.website,
          location: copy.footer.location,
        }
      : null,
  };
}

function freezeCanonicalCopy(copy: CanonicalMessagePackCopy): CanonicalMessagePackCopy {
  const cloned = deepCloneCopy(copy);
  if (cloned.footer) Object.freeze(cloned.footer);
  Object.freeze(cloned.benefitBulletsOrdered);
  return Object.freeze(cloned);
}

export function createMessagePackCandidate(input: CreateMessagePackCandidateInput): MessagePackCandidate {
  const canonical = canonicalizeMessagePackCopy(input.copy);
  const isolatedCopy = freezeCanonicalCopy(canonical);
  const copyHashSha256 = computeCopyHashSha256(isolatedCopy);

  return Object.freeze({
    candidateId: input.candidateId,
    campaignId: input.campaignId,
    createdAtIso: input.createdAtIso,
    source: input.source,
    copy: isolatedCopy,
    copyHashSha256,
    businessDnaSnapshotId: input.businessDnaSnapshotId,
    campaignStrategySnapshotId: input.campaignStrategySnapshotId,
    qualityPolicyId: input.qualityPolicyId,
    qualityPolicyVersion: input.qualityPolicyVersion,
    provenance: Object.freeze({
      adaptedFromLegacy: input.provenance.adaptedFromLegacy,
      originSource: input.provenance.originSource,
      modelName: input.provenance.modelName,
      diagnostics: Object.freeze({
        legacyIsGeneric: input.provenance.diagnostics.legacyIsGeneric,
        legacyValidationPassed: input.provenance.diagnostics.legacyValidationPassed,
        legacyValidationScore: input.provenance.diagnostics.legacyValidationScore,
        legacyValidationRejections: Object.freeze([
          ...input.provenance.diagnostics.legacyValidationRejections,
        ]),
      }),
    }),
  });
}
