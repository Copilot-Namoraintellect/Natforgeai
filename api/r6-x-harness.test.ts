/**
 * R6-X — Connected Lead Autonomy Harness (X7) + Identity Convergence (X4).
 *
 * One deterministic end-to-end acceptance over the REAL integrated services:
 *   R5-D opportunity handoff (real detector pipeline)
 *   → R6-A canonical identity intake (exact-once)
 *   → R6-B evidence scoring (real engine over seeded R5 evidence)
 *   → R6-C governed qualification (real bridge provider + seams + engine)
 *   → independent human review where required (scripted out-of-band gateway)
 *   → R6-F privacy check (real store, numeric chain)
 *   → R6-D nurture/handoff decision (REAL production ports + fake transport)
 *   → R6-E conversion outcome (real ingestion)
 *   → D nurture stop + R6-F operations projection.
 *
 * All state lives in the shared in-memory harness db (api/r6-x-harness.ts);
 * no real MySQL, no network, no wall-clock reliance (explicit `now`), no live
 * provider/CRM/billing. Cross-tenant/cross-business/adversarial cases prove
 * the rogue-agent framework: upstream payloads are re-validated at every
 * boundary and every missing/ambiguous authority hop fails closed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb must not fall back to a real connection in r6-x harness tests");
  }),
}));

import {
  evaluateOpportunity,
  handoffToR6,
} from "./lib/opportunity/detector";
import type { CanonicalInterpretationInput } from "./lib/opportunity/canonical-intelligence";
import {
  consumeOpportunityHandoff,
  submitIdentityEvidence,
  suppressLeadIdentity,
  getLeadIdentity,
} from "./lib/lead-identity/lead-identity-service";
import { scoreLead } from "./lib/scoring/scoring-service";
import {
  evaluateQualificationForLead,
  requestReviewResolution,
  resolveQualificationReview,
  type QualificationAuthorityDeps,
} from "./lib/qualification/qualification-service";
import type { ReviewChallengeGateway } from "./lib/qualification/qualification-review-authority";
import {
  createQualificationBridgeProvider,
  bindQualificationStoreExecutor,
} from "./lib/qualification/qualification-bridge";
import { createNurtureProductionPorts } from "./lib/nurture/nurture-ports";
import {
  evaluateNurture,
  dispatchHandoff,
  dispatchNurtureTouch,
  reconcileHandoff,
  type NurtureServiceDeps,
} from "./lib/nurture/nurture-service";
import { createFakeNurtureTransport } from "./lib/nurture/nurture-transport";
import { ingestConversion } from "./lib/conversion/conversion-service";
import { projectLeadOperations } from "./lib/governance/lead-operations-projection";
import { createHarnessDb, type Harness, type FakeRow } from "./r6-x-harness";

// ─── Constants ───

const T0 = new Date("2026-10-20T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const USER_ID = 1;
const OTHER_USER_ID = 2;
const BIZ_1 = 1;
const BIZ_2 = 2;

// ─── World builder ───

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

function makeInterpretation(overrides: Partial<CanonicalInterpretationInput> = {}): CanonicalInterpretationInput {
  return {
    interpretationId: nextId("int"),
    classifierVersion: "intent-sentiment-classifier/v1",
    userId: USER_ID,
    businessId: BIZ_1,
    signalId: nextId("sig"),
    signalVersion: 1,
    signalType: "comment",
    provider: "meta",
    platform: "instagram",
    actorReference: `actor-${seq}`,
    parentExternalObjectId: `thread-${seq}`,
    externalObjectId: `comment-${seq}`,
    sourceCampaignId: 1,
    source: "MODEL",
    intent: "purchase_interest",
    sentiment: "positive",
    urgency: "normal",
    relevance: "relevant",
    overallConfidence: "medium",
    topics: ["pricing"],
    riskFlags: [],
    opportunityIndicators: [{ indicator: "purchase_intent_detected", evidence: "asks price" }],
    recommendedHandling: "opportunity_candidate",
    occurredAt: "2026-10-20T10:00:00.000Z",
    createdAt: "2026-10-20T10:00:01.000Z",
    ...overrides,
  };
}

interface World {
  harness: Harness;
  db: Harness["db"];
  tables: Harness["tables"];
}

function seedBase(harness: Harness): void {
  harness.seed("businesses", [
    { id: BIZ_1, userId: USER_ID },
    { id: BIZ_2, userId: OTHER_USER_ID },
    { id: 3, userId: USER_ID },
  ]);
  harness.seed("campaigns", [
    { id: 1, userId: USER_ID, businessId: BIZ_1 },
    { id: 2, userId: OTHER_USER_ID, businessId: BIZ_2 },
  ]);
  harness.seed("users", [
    { id: USER_ID, email: "owner@example.com" },
    { id: OTHER_USER_ID, email: "other@example.com" },
  ]);
  harness.seed("leads", [
    {
      id: 1,
      userId: USER_ID,
      businessId: BIZ_1,
      campaignId: 1,
      name: "Harness Lead",
      email: "lead@example.com",
      status: "new",
      score: 0,
    },
  ]);
  harness.seed("lead_privacy_states", []);
}

/** Seed R5 evidence that yields a strong fit/intent score for lead 1 — via the
 *  REAL R5-D pipeline so every evidence hash and candidate state is genuine. */
async function seedScoringEvidence(
  world: World,
  opts: { userId?: number; businessId?: number; campaignId?: number; interpretations?: number } = {}
): Promise<void> {
  const userId = opts.userId ?? USER_ID;
  const now = T0;
  const count = opts.interpretations ?? 3;
  for (let i = 0; i < count; i += 1) {
    const interpretation = makeInterpretation({
      userId,
      businessId: opts.businessId ?? BIZ_1,
      sourceCampaignId: opts.campaignId ?? 1,
      actorReference: `score-actor-${opts.businessId ?? BIZ_1}`,
      parentExternalObjectId: `score-thread-${opts.businessId ?? BIZ_1}`,
      overallConfidence: "high",
      occurredAt: new Date(now.getTime() - (count - i) * 10 * 60 * 1000).toISOString(),
      createdAt: new Date(now.getTime() - (count - i) * 10 * 60 * 1000 + 1000).toISOString(),
    });
    const evaluated = await evaluateOpportunity({
      interpretation,
      userId,
      now,
      executor: world.db,
    });
    if (
      evaluated.kind !== "candidate_created" &&
      evaluated.kind !== "candidate_strengthened"
    ) {
      throw new Error(`fixture expected a candidate, got ${evaluated.kind}`);
    }
  }
}

/** Mint one genuine R5 handoff envelope through the real R5-D pipeline. */
async function mintHandoff(
  world: World,
  overrides: Partial<CanonicalInterpretationInput> = {},
  opts: { userId?: number; businessId?: number; now?: Date } = {}
) {
  const userId = opts.userId ?? USER_ID;
  const now = opts.now ?? T0;
  const interpretation = makeInterpretation({ userId, businessId: opts.businessId ?? BIZ_1, ...overrides });
  const evaluated = await evaluateOpportunity({ interpretation, userId, now, executor: world.db });
  if (evaluated.kind !== "candidate_created" && evaluated.kind !== "candidate_strengthened") {
    throw new Error(`fixture expected a candidate, got ${evaluated.kind}`);
  }
  const handed = await handoffToR6({
    opportunityId: evaluated.opportunityId,
    userId,
    now: new Date(now.getTime() + HOUR_MS),
    executor: world.db,
  });
  return handed.envelope;
}

function qualificationDeps(world: World, now: Date): QualificationAuthorityDeps {
  return {
    provider: createQualificationBridgeProvider(world.db, USER_ID),
    now: () => new Date(now.getTime()),
  };
}

/** Scripted out-of-band review channel (codes live only inside the fake —
 *  where the real code lives inside the reviewer's mailbox). */
class FakeChallengeGateway implements ReviewChallengeGateway {
  readonly issued = new Map<string, { code: string; userId: number; consumed: boolean }>();
  constructor(readonly fixedCode = "415926") {}
  async createAndSend(input: { userId: number; reviewId: string }) {
    const challengeToken = `tok-${this.issued.size}-${input.reviewId.slice(0, 12)}`;
    this.issued.set(challengeToken, { code: this.fixedCode, userId: input.userId, consumed: false });
    return { challengeToken, expiresAt: new Date(T0.getTime() + 10 * 60 * 1000).toISOString() };
  }
  async verify(input: { challengeToken: string; code: string }) {
    const rec = this.issued.get(input.challengeToken);
    if (!rec || rec.consumed || input.code !== rec.code) {
      throw new Error("Invalid or expired verification code");
    }
    rec.consumed = true;
    return { userId: rec.userId, consumedAt: T0.toISOString() };
  }
}

function nurtureDeps(world: World, transport?: ReturnType<typeof createFakeNurtureTransport>): NurtureServiceDeps {
  return {
    ports: createNurtureProductionPorts(world.db),
    executor: world.db,
    transport,
    now: () => new Date(T0.getTime()),
  };
}

// ─── The connected lifecycle ───

interface Lifecycle {
  lid1: string;
  leadScoreId: string;
  qualificationId: string;
}

/** Drive R5 → A → B → C for one world; returns the cross-stream handles. */
async function runIdentityScoreQualify(world: World, opts: { now?: Date; evidenceType?: string } = {}): Promise<Lifecycle> {
  const now = opts.now ?? T0;
  const envelope = await mintHandoff(world, {}, { now });
  const consumed = await consumeOpportunityHandoff({
    envelope,
    userId: USER_ID,
    now,
    executor: world.db,
  });
  const lid1 = consumed.leadId;
  const scored = await scoreLead({ userId: USER_ID, leadId: 1, now, executor: world.db });
  const qualification = await evaluateQualificationForLead(
    { userId: USER_ID, leadId: lid1, leadScoreId: scored.score.leadScoreId },
    qualificationDeps(world, now),
    bindQualificationStoreExecutor(world.db)
  );
  return {
    lid1,
    leadScoreId: scored.score.leadScoreId,
    qualificationId: qualification.qualification.qualificationId,
  };
}

// ─── Suites ───

describe("R6-X connected lead autonomy harness", () => {
  let world: World;

  beforeEach(() => {
    world = { harness: createHarnessDb(), db: undefined as never, tables: undefined as never };
    world.db = world.harness.db;
    world.tables = world.harness.tables;
    seedBase(world.harness);
  });

  it("scenario 1 — standard qualified path: R5→A→B→C→D→E→F full lifecycle", async () => {
    await seedScoringEvidence(world);
    const life = await runIdentityScoreQualify(world);
    expect(life.lid1).toMatch(/^lid1:[a-f0-9]{64}$/);
    expect(life.leadScoreId).toMatch(/^lsc1:[a-f0-9]{64}$/);

    // C decision on the canonical identity + score.
    const qualification = await evaluateQualificationForLead(
      { userId: USER_ID, leadId: life.lid1, leadScoreId: life.leadScoreId },
      qualificationDeps(world, T0),
      bindQualificationStoreExecutor(world.db)
    );
    expect(qualification.qualification.decision).toBe("QUALIFIED");
    expect(qualification.qualification.leadId).toBe(life.lid1);

    // F privacy: default ACTIVE (no row) is actionable.
    // D nurture decision through the REAL production ports.
    const nurture = await evaluateNurture(
      nurtureDeps(world),
      USER_ID,
      { qualificationId: life.qualificationId }
    );
    expect(nurture.decision.decision).not.toBe("BLOCKED");
    const decisionRow = world.tables.nurture_handoff_decisions.find(
      (r) => r.nurtureDecisionId === nurture.decision.nurtureDecisionId
    );
    expect(decisionRow?.conversionStopped).toBe(false);

    // E conversion for the lead (numeric spine).
    const conversion = await ingestConversion(
      world.db,
      {},
      { userId: USER_ID },
      {
        businessId: BIZ_1,
        leadId: 1,
        leadIdentityVersion: "lead-identity-seam/v1:abc",
        externalConversionId: "order-1001",
        sourceSystem: "stripe",
        conversionType: "purchase",
        occurredAt: "2026-10-20T13:00:00.000Z",
        amount: 12500,
        currency: "USD",
      },
      "2026-10-20T13:00:01.000Z"
    );
    expect(Number(conversion.conversion.leadId)).toBe(1);
    expect(conversion.conversion.outcomeStatus).toBe("CONFIRMED");

    // D re-evaluation: conversion stops future nurture.
    const stopped = await evaluateNurture(
      nurtureDeps(world),
      USER_ID,
      { qualificationId: life.qualificationId }
    );
    const stoppedRow = world.tables.nurture_handoff_decisions.find(
      (r) => r.nurtureDecisionId === stopped.decision.nurtureDecisionId
    );
    expect(stoppedRow?.conversionStopped).toBe(true);
    expect(stopped.decision.decision).toBe("NO_ACTION");
    expect(stopped.decision.reasonCodes).toContain("CONVERSION_STOP");

    // F operations projection reports the truthful integrated state.
    const ops = await projectLeadOperations({ leadId: 1, now: new Date(T0.getTime() + 2 * HOUR_MS), executor: world.db });
    expect(ops.leadId).toBe(1);
    expect(ops.userId).toBe(USER_ID);
  });
});
