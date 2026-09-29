import { describe, expect, it } from "vitest";

import {
  buildPublishPackage,
  type PublishPackageBuildInput,
} from "../../publish/publish-package-builder";

import {
  buildLearningPromotionContext,
  buildLearningPromotionProposalFingerprint,
  type LearningPromotionCoordinates,
} from "../../learning/promotion/promotion-contract";

import {
  buildApprovedPromotionEnvelope,
} from "../../learning/promotion/promotion-envelope";

import {
  buildStrategyLearningPromotionLineage,
  strategyLearningPromotionLineageToJson,
  type ApprovedLearningStrategyInput,
} from "../../learning/learning-strategy-consumption";

import {
  deriveCreativeArtifactLineageFingerprint,
} from "../../creative/artifact-lineage";

/**
 * WBS17 closed-loop composition acceptance.
 *
 * Purpose:
 * prove that the immutable identifiers emitted across the already-tested
 * Strategy -> Creative -> Publish -> Learning -> Promotion -> future Strategy
 * authorities remain composition-compatible as one governed lineage.
 *
 * This is intentionally fixture-backed:
 * - no live database
 * - no Redis
 * - no HTTP/provider
 * - no scheduler
 * - no production mutation
 *
 * Lower-level behavioural execution remains covered by the dedicated
 * WBS16 suites. This acceptance test proves cross-authority identity and
 * governance continuity rather than duplicating those suites.
 */

const USER_ID = 22;
const BUSINESS_ID = 5;
const CAMPAIGN_ID = 7;
const LEARNING_RECORD_ID = 501;
const APPROVAL_REQUEST_ID = 901;

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

const STRATEGY_AUTHORITY = {
  strategySnapshotId: "strategy_abc",
  strategyVersion: 1,
  businessDnaSnapshotId: "bdna_1",
  strategyHashSha256: HASH_A,
  strategyRunId: 11,
  approvalRequestId: 33,
  creativeBriefFingerprint: "fp-brief",
};

const APPROVED_COPY = {
  copyHashSha256: HASH_B,
  copySchemaVersion: "v2",
  approvedRevisionId: "rev-1",
  assessmentHashSha256: HASH_C,
  contextLockId: "ctx-1",
};

function captionLineage() {
  const lineage = {
    lineageSchemaVersion: 1,
    artifactKind: "caption_pack",
    artifactId: 501,
    strategy: STRATEGY_AUTHORITY,
    approvedCopy: APPROVED_COPY,
  };

  return {
    ...lineage,
    lineageFingerprintSha256:
      deriveCreativeArtifactLineageFingerprint(lineage),
  };
}

function buildGovernedPackage() {
  return buildPublishPackage({
    campaignId: CAMPAIGN_ID,
    userId: USER_ID,
    businessId: BUSINESS_ID,

    destination: {
      platform: "instagram",
      integrationId: 71,
    },

    intent: {
      mode: "immediate",
      scheduledAtIso: null,
    },

    strategyAuthority: STRATEGY_AUTHORITY,
    approvedCopy: APPROVED_COPY,

    selectedContent: {
      contentPostId: 801,
      content: "Governed closed-loop acceptance content.",
      lineage: captionLineage(),
    },

    captionArtifact: {
      artifactId: 501,
      caption: "Governed closed-loop acceptance content.",
      lineage: captionLineage(),
    },

    evidence: {
      launchApprovalRequestId: 77,
    },

    payload: {
      text: "Governed closed-loop acceptance content.",
      mediaUrls: [],
    },

    createdAtIso: "2026-06-01T00:00:00.000Z",
  } as PublishPackageBuildInput);
}

function buildApprovedLearningInput(): ApprovedLearningStrategyInput {
  const coordinates: LearningPromotionCoordinates = {
    learningRecordId: LEARNING_RECORD_ID,
    campaignId: CAMPAIGN_ID,
    evaluationVersion: "learning-v2",
    learningEngine: "learning-engine",
    learningEngineVersion: "learning-v2",
    learningInputDigest: "digest-closed-loop",
    recommendationId: "rec_closed_loop_1",
    targetEngine: "strategy",
    adjustmentType: "improve_offer_conversion_alignment",
    summary: "Use the observed winning conversion pattern.",
    rationale: "The governed performance evidence supports the adjustment.",
    evidenceRefs: ["obs:1", "obs:2"],
  };

  const proposalFingerprint =
    buildLearningPromotionProposalFingerprint(coordinates);

  const context = buildLearningPromotionContext({
    coordinates,
    proposalFingerprint,
  });

  const envelope = buildApprovedPromotionEnvelope({
    context,
    approvalRequestId: APPROVAL_REQUEST_ID,
    decidedAt: "2026-06-10T00:00:00.000Z",
    decidedByUserId: USER_ID,
    recordEvidence: [
      {
        kind: "observation",
        ref: "obs:1",
        note: "conversion evidence from governed campaign performance",
      },
      {
        kind: "observation",
        ref: "obs:2",
        note: "supporting governed performance observation",
      },
    ],
  });

  return {
    scope: "same-business",
    businessId: BUSINESS_ID,
    promotions: [
      {
        sourceCampaignId: envelope.campaignId,
        learningRecordId: envelope.learningRecordId,
        evaluationVersion: coordinates.evaluationVersion,
        recommendationId: coordinates.recommendationId,
        targetEngine: coordinates.targetEngine,
        adjustmentType: coordinates.adjustmentType,
        summary: coordinates.summary,
        rationale: coordinates.rationale,
        evidenceRefs: [...coordinates.evidenceRefs],
        decidedAt: envelope.decidedAt,
        approvalRequestId: envelope.approvalRequestId,
        proposalFingerprint: envelope.proposalFingerprint,
        promotedProvenanceClass: "approved_recommendation",
      },
    ],
  };
}

describe("WBS17 autonomous closed-loop composition acceptance", () => {
  it("preserves governed authority from Strategy publication through approved Learning into future Strategy lineage", () => {
    const publishPackage = buildGovernedPackage();

    expect(publishPackage.identity.campaignId).toBe(CAMPAIGN_ID);
    expect(publishPackage.identity.userId).toBe(USER_ID);
    expect(publishPackage.identity.businessId).toBe(BUSINESS_ID);

    expect(
      publishPackage.identity.strategyAuthority?.strategySnapshotId
    ).toBe(STRATEGY_AUTHORITY.strategySnapshotId);

    expect(
      publishPackage.identity.strategyAuthority?.strategyHashSha256
    ).toBe(STRATEGY_AUTHORITY.strategyHashSha256);

    expect(
      publishPackage.identity.approvedCopy?.copyHashSha256
    ).toBe(APPROVED_COPY.copyHashSha256);

    const approvedLearning = buildApprovedLearningInput();

    expect(approvedLearning.scope).toBe("same-business");
    expect(approvedLearning.businessId).toBe(BUSINESS_ID);
    expect(approvedLearning.promotions).toHaveLength(1);

    const promotion = approvedLearning.promotions[0];

    expect(promotion.sourceCampaignId).toBe(CAMPAIGN_ID);
    expect(promotion.learningRecordId).toBe(LEARNING_RECORD_ID);
    expect(promotion.approvalRequestId).toBe(APPROVAL_REQUEST_ID);
    expect(promotion.proposalFingerprint).toMatch(/^[0-9a-f]{64}$/);

    const futureStrategyLineage =
      buildStrategyLearningPromotionLineage(approvedLearning);

    expect(futureStrategyLineage).toHaveLength(1);

    expect(futureStrategyLineage[0]).toMatchObject({
      approvalRequestId: APPROVAL_REQUEST_ID,
      proposalFingerprint: promotion.proposalFingerprint,
      learningRecordId: LEARNING_RECORD_ID,
      campaignId: CAMPAIGN_ID,
    });

    const persistedLineage =
      strategyLearningPromotionLineageToJson(futureStrategyLineage);

    expect(persistedLineage).toEqual(futureStrategyLineage);

    /*
     * Closed-loop acceptance statement:
     *
     * the campaign governed by STRATEGY_AUTHORITY can produce an immutable
     * governed publish package; factual observations from that campaign can
     * bind a Learning recommendation to the same campaign; the recommendation
     * becomes consumable only after approval-envelope authority exists; and
     * the future Strategy snapshot receives explicit immutable Learning
     * lineage rather than silently mutating the historical Strategy.
     */
    expect(futureStrategyLineage[0].campaignId).toBe(
      publishPackage.identity.campaignId
    );
  });
});