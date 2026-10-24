// Unit coverage for R5-D identity derivation (contract §1, §5, D4).
// Deterministic: same inputs → same identity; tenant in coordinates; hash-only actors.

import { describe, expect, it } from "vitest";
import {
  buildThreadCoordinates,
  deriveActorKey,
  deriveThreadKey,
  deriveTopicKey,
  deriveOpportunityKey,
  deriveOpportunityId,
  deriveEvidenceHash,
  NO_ACTOR,
  NO_THREAD,
  NO_TOPIC,
} from "./opportunity-identity";
import { toCanonicalInterpretation, type CanonicalInterpretationInput } from "./canonical-intelligence";

let seq = 0;
function makeInterpretation(overrides: Partial<CanonicalInterpretationInput> = {}) {
  seq += 1;
  return toCanonicalInterpretation({
    interpretationId: `int-id-${seq}`,
    classifierVersion: "intent-sentiment-classifier/v1",
    userId: 1,
    businessId: 1,
    signalId: `sig-${seq}`,
    signalVersion: 1,
    signalType: "comment",
    provider: "meta",
    platform: "instagram",
    actorReference: "actor-xyz",
    occurredAt: "2026-10-24T10:00:00.000Z",
    source: "MODEL",
    intent: "purchase_interest",
    sentiment: "positive",
    urgency: "normal",
    relevance: "relevant",
    overallConfidence: "medium",
    topics: ["pricing"],
    riskFlags: [],
    opportunityIndicators: [],
    recommendedHandling: "opportunity_candidate",
    createdAt: "2026-10-24T10:00:01.000Z",
    ...overrides,
  } satisfies CanonicalInterpretationInput);
}

describe("opportunity identity (D4)", () => {
  it("same thread coordinates produce the same opportunityId", () => {
    const a = makeInterpretation({ interpretationId: "i-1", signalId: "s-1" });
    const b = makeInterpretation({ interpretationId: "i-2", signalId: "s-2" });
    // identity ignores interpretation/signal ids — same thread
    const keyA = deriveOpportunityKey(
      buildThreadCoordinates({
        userId: a.userId,
        businessId: a.businessId,
        opportunityType: "purchase_interest",
        actorKey: deriveActorKey(a),
        threadKey: deriveThreadKey(a),
        topicKey: deriveTopicKey(a),
      })
    );
    const keyB = deriveOpportunityKey(
      buildThreadCoordinates({
        userId: b.userId,
        businessId: b.businessId,
        opportunityType: "purchase_interest",
        actorKey: deriveActorKey(b),
        threadKey: deriveThreadKey(b),
        topicKey: deriveTopicKey(b),
      })
    );
    expect(keyA).toBe(keyB);
    expect(deriveOpportunityId(keyA)).toBe(`opp1:${keyA}`);
  });

  it("different tenants never collide on identical upstream evidence", () => {
    const a = makeInterpretation({ userId: 1, interpretationId: "i-1", signalId: "s-1" });
    const b = makeInterpretation({ userId: 2, interpretationId: "i-1", signalId: "s-1" });
    const coordsA = buildThreadCoordinates({
      userId: a.userId,
      businessId: a.businessId,
      opportunityType: "purchase_interest",
      actorKey: deriveActorKey(a),
      threadKey: deriveThreadKey(a),
      topicKey: deriveTopicKey(a),
    });
    const coordsB = buildThreadCoordinates({
      userId: b.userId,
      businessId: b.businessId,
      opportunityType: "purchase_interest",
      actorKey: deriveActorKey(b),
      threadKey: deriveThreadKey(b),
      topicKey: deriveTopicKey(b),
    });
    expect(deriveOpportunityKey(coordsA)).not.toBe(deriveOpportunityKey(coordsB));
  });

  it("same actor with unrelated topic produces distinct identities (case 6)", () => {
    const base = { interpretationId: "i-1", signalId: "s-1" };
    const a = makeInterpretation({ ...base, topics: ["pricing"] });
    const b = makeInterpretation({ ...base, topics: ["shipping"] });
    const key = (t: ReturnType<typeof makeInterpretation>) =>
      deriveOpportunityKey(
        buildThreadCoordinates({
          userId: t.userId,
          businessId: t.businessId,
          opportunityType: "purchase_interest",
          actorKey: deriveActorKey(t),
          threadKey: deriveThreadKey(t),
          topicKey: deriveTopicKey(t),
        })
      );
    expect(key(a)).not.toBe(key(b));
  });

  it("actorKey is a hash and differs by provider/platform", () => {
    const a = makeInterpretation({ interpretationId: "i-1", signalId: "s-1", provider: "meta" });
    const b = makeInterpretation({ interpretationId: "i-2", signalId: "s-2", provider: "linkedin" });
    const actorA = deriveActorKey(a);
    expect(actorA).toMatch(/^[a-f0-9]{64}$/);
    expect(deriveActorKey(b)).not.toBe(actorA);
  });

  it("missing actor/thread/topic map to stable no-* keys", () => {
    const minimal = makeInterpretation({
      interpretationId: "i-1",
      signalId: "s-1",
      actorReference: null,
      parentExternalObjectId: null,
      externalObjectId: null,
      topics: [],
    });
    expect(deriveActorKey(minimal)).toBe(NO_ACTOR);
    expect(deriveThreadKey(minimal)).toBe(NO_THREAD);
    expect(deriveTopicKey(minimal)).toBe(NO_TOPIC);
  });

  it("threadKey prefers parentExternalObjectId over externalObjectId", () => {
    const withParent = makeInterpretation({
      interpretationId: "i-1",
      signalId: "s-1",
      parentExternalObjectId: "thread-9",
      externalObjectId: "comment-1",
    });
    const withoutParent = makeInterpretation({
      interpretationId: "i-2",
      signalId: "s-2",
      parentExternalObjectId: null,
      externalObjectId: "thread-9",
    });
    expect(deriveThreadKey(withParent)).toBe(deriveThreadKey(withoutParent));
  });

  it("evidence hash is deterministic and sensitive to content", () => {
    const fragment = {
      candidateId: 7,
      interpretationId: "int-1",
      signalId: "sig-1",
      signalVersion: 1,
      kind: "signal_interpretation",
      engagementReceiptId: null,
      opportunityTypeAtEvaluation: "purchase_interest",
      intent: "purchase_interest",
      overallConfidence: "medium",
      relevance: "relevant",
      sentiment: "positive",
      urgency: "normal" as const,
      sourceCampaignId: null,
      occurredAt: "2026-10-24T10:00:00.000Z",
    };
    expect(deriveEvidenceHash(fragment)).toBe(deriveEvidenceHash({ ...fragment }));
    expect(deriveEvidenceHash(fragment)).not.toBe(
      deriveEvidenceHash({ ...fragment, overallConfidence: "high" })
    );
  });
});
