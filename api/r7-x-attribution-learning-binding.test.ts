/**
 * R7-X X4 — Canonical Attribution → Learning Binding acceptance.
 *
 * Proves R7-C's upstream seam binds the ACTUAL integrated R7-A and R7-B
 * authorities (X4): deriveBusinessLearning runs end to end through the real
 * production ports over seeded canonical rows. Verified behaviours:
 *
 *  - outcome + attribution → deterministic evidence bundle → learning
 *    candidate → immutable learning record (exactly-once);
 *  - attribution supersession lineage reads through B's store authority;
 *  - outcome verification change (PROVISIONAL vs VERIFIED) and reversal
 *    change the upstream state fingerprint → distinct learning identities;
 *  - contradictory evidence (purchase + refund) is counted, not hidden;
 *  - learning is context-scoped (bounded campaign ids), never tenant-global;
 *  - a single outcome never mints STRONG learning;
 *  - hash-drifted upstream rows fail closed before C consumes them.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb must not fall back to a real connection in R7-X binding tests");
  }),
}));

import { getDb } from "./queries/connection";
import { createFakeDb } from "./r5-test-support";
import { createUpstreamPorts } from "./lib/business-learning/business-learning-upstream-seam";
import { deriveBusinessLearning } from "./lib/business-learning/business-learning-service";
import { deriveOutcomeEvidenceHash } from "./lib/outcome/outcome-identity";
import { deriveAttributionKey, deriveRecordHash, toAttributionId } from "./lib/attribution/attribution-identity";

const H = (c: string) => c.repeat(64);

function outcomeHashFor(row: Record<string, unknown>): string {
  return deriveOutcomeEvidenceHash({
    userId: row.userId as number,
    businessId: row.businessId as number,
    leadId: (row.leadId as number | null) ?? null,
    leadIdentityVersion: (row.leadIdentityVersion as string | null) ?? null,
    conversionId: row.conversionId as string,
    outcomeType: row.outcomeType as string,
    valueType: row.valueType as string,
    amountMinor: (row.amountMinor as number | null) ?? null,
    currency: (row.currency as string | null) ?? null,
    quantity: (row.quantity as number | null) ?? null,
    metricUnit: (row.metricUnit as string | null) ?? null,
    evidenceSource: row.evidenceSource as string,
    evidenceAuthority: row.evidenceAuthority as string,
    evidenceIdentity: row.evidenceIdentity as string,
    occurredAt: row.occurredAt as string,
    recordedAt: row.recordedAt as string,
    reversesOutcomeId: (row.reversesOutcomeId as string | null) ?? null,
    renewsOutcomeId: (row.renewsOutcomeId as string | null) ?? null,
    supersedesOutcomeId: (row.supersedesOutcomeId as string | null) ?? null,
  });
}

function makeOutcomeRow(overrides: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: 1,
    outcomeId: `out1:${H("b")}`,
    userId: 1,
    businessId: 10,
    leadId: 100,
    leadIdentityVersion: "lead-identity-seam/v1:abc123",
    conversionId: `cnv1:${H("c")}`,
    outcomeType: "PURCHASE",
    outcomeStatus: "VERIFIED",
    valueType: "MONETARY",
    amountMinor: 50000,
    currency: "USD",
    quantity: null,
    metricUnit: null,
    evidenceSource: "payment_processor",
    evidenceAuthority: "VERIFIED_PAYMENT",
    evidenceIdentity: "invoice-123",
    occurredAt: "2026-10-01T10:00:00.000Z",
    recordedAt: "2026-10-01T10:01:00.000Z",
    reversesOutcomeId: null,
    renewsOutcomeId: null,
    supersedesOutcomeId: null,
    version: 1,
    createdAt: "2026-10-01T10:01:00.000Z",
    ...overrides,
  };
  row.evidenceHash = outcomeHashFor(row);
  return row;
}

function campaignTouchpoint(campaignId: number, creditBps = 100000) {
  return {
    touchpointId: `tpp:campaign:${H("5").slice(0, 24)}`,
    type: "CAMPAIGN",
    sourceIdentity: String(campaignId),
    businessId: 10,
    occurredAt: "2026-09-20T09:00:00.000Z",
    provenance: { path: "opportunity.campaignId", references: {}, sourceRowHash: H("7") },
    eligibility: "eligible",
    creditBps,
  };
}

function makeAttributionRow(outcome: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  const material: Record<string, unknown> = {
    attributionKey: H("k"),
    attributionId: "",
    userId: 1,
    businessId: 10,
    outcomeId: outcome.outcomeId,
    leadId: outcome.leadId,
    leadIdentityVersion: outcome.leadIdentityVersion,
    conversionId: outcome.conversionId,
    outcomeType: outcome.outcomeType,
    outcomeStatus: outcome.outcomeStatus,
    outcomeAmountMinor: outcome.amountMinor,
    outcomeCurrency: outcome.currency,
    modelType: "LAST_TOUCH",
    modelVersion: "attribution-last-touch/v1",
    windowStart: "2026-09-01T00:00:00.000Z",
    windowEnd: "2026-10-01T10:00:00.000Z",
    journeyHash: H("j"),
    touchpoints: [campaignTouchpoint(500)],
    excludedTouchpoints: [],
    totalCreditBps: 100000,
    confidenceClass: "HIGH",
    evidenceClass: "DIRECT_LINKAGE",
    policyVersion: "attribution-policy/v1",
    sourceVersions: {
      outcomeProjectionVersion: "conversion-outcome/v1",
      conversionProjectionVersion: "conversion-to-attribution/v1",
      attributionContractVersion: "attribution/v1",
      policyVersion: "attribution-policy/v1",
    },
    supersedesAttributionId: null,
    calculatedAt: "2026-10-01T11:00:00.000Z",
    ...overrides,
  };
  const key = deriveAttributionKey({
    tenantUserId: 1,
    businessId: 10,
    outcomeId: outcome.outcomeId as string,
    modelType: "LAST_TOUCH",
    modelVersion: "attribution-last-touch/v1",
    windowStart: "2026-09-01T00:00:00.000Z",
    windowEnd: "2026-10-01T10:00:00.000Z",
    journeyHash: H("j"),
    totalCreditBps: material.totalCreditBps as number,
    confidenceClass: material.confidenceClass as string,
    evidenceClass: material.evidenceClass as string,
    outcomeStatus: outcome.outcomeStatus as string,
    policyVersion: "attribution-policy/v1",
  });
  material.attributionKey = key;
  material.attributionId = toAttributionId(key);
  material.recordHash = deriveRecordHash(material as never);
  return material;
}

describe("R7-X X4: canonical attribution → learning binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  function seedEnv(seed: Record<string, Record<string, unknown>[]>) {
    const env = createFakeDb(seed);
    // Canonical-table existence checks (the only db.execute consumer in the
    // seam) see every table; store reads run on the select chain.
    (env.db.execute as ReturnType<typeof vi.fn>).mockResolvedValue([{ c: 1 }]);
    (getDb as unknown as ReturnType<typeof vi.fn>).mockReturnValue(env.db);
    return env;
  }

  it("outcome + attribution → deterministic bundle → exactly-once immutable learning", async () => {
    const outcome = makeOutcomeRow();
    const attribution = makeAttributionRow(outcome);
    const env = seedEnv({
      business_outcomes: [outcome],
      business_outcome_lifecycle_events: [],
      attribution_results: [attribution],
    });
    const ports = createUpstreamPorts(env.db as never);
    const input = { outcomeIds: [outcome.outcomeId], attributionIds: [attribution.attributionId] };

    const first = await deriveBusinessLearning(1, input, { ports });
    expect(first.results.length).toBeGreaterThan(0);
    const learning = first.results[0].learning;
    expect(learning.learningId).toMatch(/^lrn1:[a-f0-9]{64}$/);
    // Context-scoped: bounded campaign ids, never tenant-global.
    const scope = learning.contextScope as { campaignIds: number[] };
    expect(Array.isArray(scope.campaignIds)).toBe(true);
    expect(scope.campaignIds).toContain(500);
    // A single outcome never mints STRONG learning.
    expect(learning.confidenceClass).not.toBe("STRONG");
    // Causation never flows through learning.
    const projection = first.results[0].projection as { causationClaimed?: boolean };
    expect(projection.causationClaimed ?? false).toBe(false);

    // Replay converges: same bundle identity, exactly one durable row.
    const second = await deriveBusinessLearning(1, input, { ports });
    expect(second.evidenceBundleId).toBe(first.evidenceBundleId);
    expect(env.seed.business_learning_records).toHaveLength(1);
    const persisted = env.seed.business_learning_records[0];
    expect(persisted.learningId).toBe(learning.learningId);
    expect(persisted.recordHash).toBe(learning.recordHash);
  });

  it("attribution supersession lineage reads through B store authority", async () => {
    const outcome = makeOutcomeRow();
    const atr1 = makeAttributionRow(outcome);
    const atr2 = makeAttributionRow(outcome, { supersedesAttributionId: atr1.attributionId, attributionKey: H("k2") });
    // atr2 needs its own identity (different key material)
    atr2.attributionKey = H("k2");
    atr2.attributionId = toAttributionId(atr2.attributionKey as string);
    atr2.recordHash = deriveRecordHash(atr2 as never);
    const env = seedEnv({ attribution_results: [atr1, atr2] });

    const ports = createUpstreamPorts(env.db as never);
    expect(await ports.attributions.findSupersedingAttribution(1, atr1.attributionId as string)).toBe(
      atr2.attributionId
    );
    expect(await ports.attributions.findSupersedingAttribution(1, atr2.attributionId as string)).toBeNull();
  });

  it("outcome verification change produces a distinct learning identity", async () => {
    const verified = makeOutcomeRow();
    const verifiedAttr = makeAttributionRow(verified);
    const env = seedEnv({
      business_outcomes: [verified],
      business_outcome_lifecycle_events: [],
      attribution_results: [verifiedAttr],
    });
    const ports = createUpstreamPorts(env.db as never);
    const input = { outcomeIds: [verified.outcomeId], attributionIds: [verifiedAttr.attributionId] };
    const first = await deriveBusinessLearning(1, input, { ports });
    const learningA = first.results[0].learning;

    // Same subject, but the outcome is now PROVISIONAL (verification changed):
    // upstream state fingerprint differs → distinct identity, no silent edit.
    const provisional = makeOutcomeRow({
      outcomeStatus: "PROVISIONAL",
      evidenceAuthority: "USER_ATTESTATION",
      evidenceSource: "user_attestation",
      version: 1,
    });
    env.seed.business_outcomes = [provisional];
    const second = await deriveBusinessLearning(1, input, { ports });
    const learningB = second.results[0].learning;
    expect(learningB.learningId).not.toBe(learningA.learningId);
    expect(learningB.upstreamStateFingerprint).not.toBe(learningA.upstreamStateFingerprint);
    // Provisional evidence caps confidence at MODERATE — never above.
    const RANK: Record<string, number> = { WEAK: 1, MODERATE: 2, STRONG: 3 };
    expect(RANK[learningB.confidenceClass as string]).toBeLessThanOrEqual(RANK.MODERATE);
    // The earlier learning was not mutated: rows are insert-only.
    expect(env.seed.business_learning_records).toHaveLength(2);
  });

  it("contradictory evidence (purchase + refund) is counted and visible", async () => {
    const purchase = makeOutcomeRow();
    const purchaseAttr = makeAttributionRow(purchase);
    const refund = makeOutcomeRow({
      id: 2,
      outcomeId: `out1:${H("f")}`,
      conversionId: `cnv1:${H("g")}`,
      outcomeType: "REFUND",
      amountMinor: -50000,
      reversesOutcomeId: purchase.outcomeId,
      evidenceIdentity: "invoice-123-refund",
    });
    const refundAttr = makeAttributionRow(refund, {
      touchpoints: [],
      excludedTouchpoints: [
        {
          touchpointId: `tpp:campaign:${H("6").slice(0, 24)}`,
          type: "CAMPAIGN",
          sourceIdentity: "500",
          businessId: 10,
          occurredAt: "2026-09-20T09:00:00.000Z",
          eligibility: "excluded",
          creditBps: 0,
          reason: "TOUCHPOINT_DUPLICATE",
        },
      ],
      totalCreditBps: 0,
      confidenceClass: "NONE",
      evidenceClass: "INSUFFICIENT_EVIDENCE",
    });
    const env = seedEnv({
      business_outcomes: [purchase, refund],
      business_outcome_lifecycle_events: [],
      attribution_results: [purchaseAttr, refundAttr],
    });
    const ports = createUpstreamPorts(env.db as never);
    const result = await deriveBusinessLearning(
      1,
      { outcomeIds: [purchase.outcomeId, refund.outcomeId], attributionIds: [purchaseAttr.attributionId, refundAttr.attributionId] },
      { ports }
    );
    const withContradiction = result.results.find((r) => Number(r.learning.contradictionCount) > 0);
    expect(withContradiction).toBeDefined();
  });

  it("hash-drifted attribution row fails closed before C consumes it", async () => {
    const outcome = makeOutcomeRow();
    const attribution = makeAttributionRow(outcome);
    attribution.totalCreditBps = 12345; // drift after hashing
    const env = seedEnv({
      business_outcomes: [outcome],
      business_outcome_lifecycle_events: [],
      attribution_results: [attribution],
    });
    const ports = createUpstreamPorts(env.db as never);
    await expect(
      ports.attributions.getAttributionForLearning(1, attribution.attributionId as string)
    ).rejects.toThrow(/hash drift detected/);
  });
});
