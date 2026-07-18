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
  readonly evidenceHashSha256?: string;
  readonly campaignStrategySnapshotId: string;
  readonly strategyHashSha256?: string;
  readonly qualityPolicyId: string;
  readonly qualityPolicyVersion: number;
  readonly policyHashSha256?: string;
  readonly provenance: MessagePackCandidateProvenance;
}

function deepCloneCopy(copy: CanonicalMessagePackCopy): CanonicalMessagePackCopy {
  return {
    copySchemaVersion: copy.copySchemaVersion,
    headline: copy.headline,
    subheadline: copy.subheadline,
    benefitBulletsOrdered: [...copy.benefitBulletsOrdered],
    cta: copy.cta,
    proofPointsOrdered: [...copy.proofPointsOrdered],
    platformCaptionsOrdered: copy.platformCaptionsOrdered.map((item) => ({
      platform: item.platform,
      caption: item.caption,
      cta: item.cta,
      hashtagsOrdered: [...item.hashtagsOrdered],
    })),
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
  for (const caption of cloned.platformCaptionsOrdered) {
    Object.freeze(caption.hashtagsOrdered);
    Object.freeze(caption);
  }
  if (cloned.footer) Object.freeze(cloned.footer);
  Object.freeze(cloned.platformCaptionsOrdered);
  Object.freeze(cloned.proofPointsOrdered);
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
    evidenceHashSha256: input.evidenceHashSha256 || "",
    campaignStrategySnapshotId: input.campaignStrategySnapshotId,
    strategyHashSha256: input.strategyHashSha256 || "",
    qualityPolicyId: input.qualityPolicyId,
    qualityPolicyVersion: input.qualityPolicyVersion,
    policyHashSha256: input.policyHashSha256 || "",
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
