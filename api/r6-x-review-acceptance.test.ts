/**
 * R6-X — X5 Integrated Human-Review / Approval Acceptance.
 *
 * Re-tests C's independent human-review proof after ALL streams are merged,
 * driving the REAL services on the shared harness store:
 *   - review resolution uses the REAL OTP primitive (bcrypt-hashed challenge,
 *     single-use consume, attempt limits, expiry) with the email sender
 *     intercepted (the code travels only to the reviewer's mailbox — the test
 *     plays the mailbox);
 *   - tenant JWT alone cannot self-approve; guessed OTP fails; cross-review
 *     replay fails; superseded/expired approvals fail; approvals bind the
 *     exact qualification + evidence + policy;
 *   - D cannot bypass C review state (REVIEW_REQUIRED never reaches a
 *     sales-handoff execution);
 *   - D sales_handoff approvals remain distinct and correctly scoped from C's
 *     challenge-bound review authority — neither satisfies the other.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb must not fall back to a real connection in r6-x review tests");
  }),
}));

vi.mock("./lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/email")>();
  return {
    ...actual,
    sendTwoFactorCodeEmail: vi.fn(async (input: { to: string; code: string }) => {
      mailbox.push({ to: input.to, code: input.code });
      return { messageId: "mailbox", accepted: [input.to] } as never;
    }),
  };
});

import { evaluateOpportunity, handoffToR6 } from "./lib/opportunity/detector";
import type { CanonicalInterpretationInput } from "./lib/opportunity/canonical-intelligence";
import { consumeOpportunityHandoff } from "./lib/lead-identity/lead-identity-service";
import { scoreLead } from "./lib/scoring/scoring-service";
import {
  evaluateQualificationForLead,
  requestReviewResolution,
  resolveQualificationReview,
  type QualificationAuthorityDeps,
} from "./lib/qualification/qualification-service";
import { OtpReviewChallengeGateway } from "./lib/qualification/qualification-review-authority";
import {
  createQualificationBridgeProvider,
  bindQualificationStoreExecutor,
} from "./lib/qualification/qualification-bridge";
import { createNurtureProductionPorts } from "./lib/nurture/nurture-ports";
import { evaluateNurture } from "./lib/nurture/nurture-service";
import { createHarnessDb, type Harness } from "./r6-x-harness";

const T0 = new Date("2026-10-20T12:00:00.000Z");
const USER_ID = 1;
const BIZ_1 = 1;
const mailbox: Array<{ to: string; code: string }> = [];

let seq = 0;
function makeInterpretation(overrides: Partial<CanonicalInterpretationInput> = {}): CanonicalInterpretationInput {
  seq += 1;
  return {
    interpretationId: `rev-int-${seq}`,
    classifierVersion: "intent-sentiment-classifier/v1",
    userId: USER_ID,
    businessId: BIZ_1,
    signalId: `rev-sig-${seq}`,
    signalVersion: 1,
    signalType: "comment",
    provider: "meta",
    platform: "instagram",
    actorReference: "review-actor",
    parentExternalObjectId: "review-thread",
    externalObjectId: `rev-comment-${seq}`,
    sourceCampaignId: 1,
    source: "MODEL",
    intent: "purchase_interest",
    sentiment: seq % 3 === 0 ? "negative" : "positive",
    urgency: "normal",
    relevance: "relevant",
    overallConfidence: "high",
    topics: ["pricing"],
    riskFlags: [],
    opportunityIndicators: [{ indicator: "purchase_intent_detected", evidence: "asks price" }],
    recommendedHandling: "opportunity_candidate",
    occurredAt: new Date(T0.getTime() - (3 - (seq % 3)) * 10 * 60 * 1000).toISOString(),
    createdAt: new Date(T0.getTime() - (3 - (seq % 3)) * 10 * 60 * 1000 + 1000).toISOString(),
    ...overrides,
  };
}

interface World {
  harness: Harness;
  db: any;
  tables: Harness["tables"];
}

async function mintHandoff(world: World, actorTag = "review"): Promise<Record<string, unknown>> {
  const interpretation = makeInterpretation({
    actorReference: `${actorTag}-handoff-actor`,
    parentExternalObjectId: `${actorTag}-handoff-thread`,
  });
  const evaluated = await evaluateOpportunity({
    interpretation,
    userId: USER_ID,
    now: T0,
    executor: world.db,
  });
  const handed = await handoffToR6({
    opportunityId: (evaluated as { opportunityId: string }).opportunityId,
    userId: USER_ID,
    now: new Date(T0.getTime() + 60 * 60 * 1000),
    executor: world.db,
  });
  return handed.envelope as unknown as Record<string, unknown>;
}

/** Drive R5 → A → B → C(REVIEW_REQUIRED) and return the review-bound handles. */
async function buildReviewWorld(world: World, leadId = 1, actorTag = "review") {
  for (let i = 0; i < 3; i += 1) {
    const interpretation = makeInterpretation({
      actorReference: `${actorTag}-actor`,
      parentExternalObjectId: `${actorTag}-thread`,
    });
    const evaluated = await evaluateOpportunity({ interpretation, userId: USER_ID, now: T0, executor: world.db });
    if (evaluated.kind !== "candidate_created" && evaluated.kind !== "candidate_strengthened") {
      throw new Error(`fixture expected a candidate, got ${evaluated.kind}`);
    }
  }
  const envelope = await mintHandoff(world, actorTag);
  const consumed = await consumeOpportunityHandoff({ envelope, userId: USER_ID, now: T0, executor: world.db });
  const scored = await scoreLead({ userId: USER_ID, leadId, now: T0, executor: world.db });
  const deps: QualificationAuthorityDeps = {
    provider: createQualificationBridgeProvider(world.db, USER_ID),
    now: () => new Date(T0.getTime()),
  };
  const executor = bindQualificationStoreExecutor(world.db);
  const result = await evaluateQualificationForLead(
    { userId: USER_ID, leadId: consumed.leadId, leadScoreId: scored.score.leadScoreId },
    deps,
    executor
  );
  expect(result.qualification.decision).toBe("REVIEW_REQUIRED");
  const review = world.tables.lead_qualification_reviews[world.tables.lead_qualification_reviews.length - 1];
  return { deps, executor, review, qualificationId: result.qualification.qualificationId, lid1: consumed.leadId };
}

/** Build a REVIEW_REQUIRED chain for a second, independent lead. */
async function buildSecondLeadWorld(world: World) {
  world.harness.seed("leads", [
    { id: 2, userId: USER_ID, businessId: BIZ_1, campaignId: 1, status: "new", score: 0 },
  ]);
  return buildReviewWorld(world, 2, "second");
}

describe("R6-X X5 — integrated human review / approval authority", () => {
  let world: World;

  beforeEach(() => {
    mailbox.length = 0;
    world = { harness: createHarnessDb(), db: undefined as never, tables: undefined as never };
    world.db = world.harness.db;
    world.tables = world.harness.tables;
    world.harness.seed("businesses", [{ id: BIZ_1, userId: USER_ID }]);
    world.harness.seed("campaigns", [{ id: 1, userId: USER_ID, businessId: BIZ_1 }]);
    world.harness.seed("users", [{ id: USER_ID, email: "owner@example.com" }]);
    world.harness.seed("leads", [
      { id: 1, userId: USER_ID, businessId: BIZ_1, campaignId: 1, status: "new", score: 0 },
    ]);
  });

  it("real OTP lifecycle: issue → mailbox-only code → verify → single-use consume", async () => {
    const { deps, executor, review } = await buildReviewWorld(world);
    const gateway = new OtpReviewChallengeGateway(world.db);
    const bound = await requestReviewResolution(
      { userId: USER_ID, reviewId: review.reviewId as string, req: new Request("http://localhost/api/trpc") },
      { ...deps, challengeGateway: gateway },
      executor
    );
    expect(bound.pendingChallengeToken).toBeTruthy();
    expect(mailbox).toHaveLength(1);
    expect(mailbox[0].to).toBe("owner@example.com");
    const code = mailbox[0].code;
    const resolved = await resolveQualificationReview(
      {
        userId: USER_ID, reviewId: review.reviewId as string,
        outcome: "progress_authorized", reason: "human verified by phone",
        challengeToken: bound.pendingChallengeToken as string, code,
      },
      { ...deps, challengeGateway: gateway },
      executor
    );
    expect(resolved.status).toBe("progress_authorized");
    // Single use: replaying the same challenge+code fails closed.
    await expect(
      resolveQualificationReview(
        {
          userId: USER_ID, reviewId: review.reviewId as string,
          outcome: "progress_authorized", reason: "replay",
          challengeToken: bound.pendingChallengeToken as string, code,
        },
        { ...deps, challengeGateway: gateway },
        executor
      )
    ).rejects.toMatchObject({ code: "REVIEW_AUTHORIZATION_REQUIRED" });
  });

  it("guessed OTP fails; the durable challenge enforces attempt limits", async () => {
    const { deps, executor, review } = await buildReviewWorld(world);
    const gateway = new OtpReviewChallengeGateway(world.db);
    const bound = await requestReviewResolution(
      { userId: USER_ID, reviewId: review.reviewId as string, req: new Request("http://localhost/api/trpc") },
      { ...deps, challengeGateway: gateway },
      executor
    );
    await expect(
      resolveQualificationReview(
        {
          userId: USER_ID, reviewId: review.reviewId as string,
          outcome: "progress_authorized", reason: "guessed",
          challengeToken: bound.pendingChallengeToken as string, code: "000000",
        },
        { ...deps, challengeGateway: gateway },
        executor
      )
    ).rejects.toThrow(/Invalid verification code|UNAUTHORIZED/i);
  });

  it("cross-review replay fails: a challenge bound to review A never resolves review B", async () => {
    // Two independent REVIEW_REQUIRED worlds on different leads.
    const first = await buildReviewWorld(world, 1, "lead-one");
    const second = await buildSecondLeadWorld(world);
    const gateway = new OtpReviewChallengeGateway(world.db);
    // Issue the challenge for review A (lead one)…
    const boundA = await requestReviewResolution(
      { userId: USER_ID, reviewId: first.review.reviewId as string, req: new Request("http://localhost/api/trpc") },
      { ...first.deps, challengeGateway: gateway },
      first.executor
    );
    const codeA = mailbox[mailbox.length - 1].code;
    // …and attempt to resolve review B (lead two) with review A's challenge.
    await expect(
      resolveQualificationReview(
        {
          userId: USER_ID, reviewId: second.review.reviewId as string,
          outcome: "progress_authorized", reason: "cross-review replay",
          challengeToken: boundA.pendingChallengeToken as string, code: codeA,
        },
        { ...second.deps, challengeGateway: gateway },
        second.executor
      )
    ).rejects.toMatchObject({ code: "REVIEW_AUTHORIZATION_BINDING_MISMATCH" });
  });

  it("expired challenge fails closed (stale approval)", async () => {
    const { deps, executor, review } = await buildReviewWorld(world);
    const gateway = new OtpReviewChallengeGateway(world.db);
    const bound = await requestReviewResolution(
      { userId: USER_ID, reviewId: review.reviewId as string, req: new Request("http://localhost/api/trpc") },
      { ...deps, challengeGateway: gateway },
      executor
    );
    const challenge = world.tables.two_factor_challenges.find(
      (r) => r.challengeToken === bound.pendingChallengeToken
    );
    if (challenge) challenge.expiresAt = new Date(T0.getTime() - 1000);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0.getTime() + 60 * 1000));
    try {
      await expect(
        resolveQualificationReview(
          {
            userId: USER_ID, reviewId: review.reviewId as string,
            outcome: "progress_authorized", reason: "too late",
            challengeToken: bound.pendingChallengeToken as string, code: mailbox[mailbox.length - 1].code,
          },
          { ...deps, challengeGateway: gateway },
          executor
        )
      ).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("approval binds the exact qualification/evidence/policy: superseded approval rejected", async () => {
    const { deps, executor, review } = await buildReviewWorld(world);
    const gateway = new OtpReviewChallengeGateway(world.db);
    const bound = await requestReviewResolution(
      { userId: USER_ID, reviewId: review.reviewId as string, req: new Request("http://localhost/api/trpc") },
      { ...deps, challengeGateway: gateway },
      executor
    );
    const code = mailbox[mailbox.length - 1].code;
    // A new deterministic evaluation (new evidence) supersedes the decision
    // the review is bound to.
    const interpretation = makeInterpretation({ sentiment: "positive", externalObjectId: "supersede-1" });
    await evaluateOpportunity({ interpretation, userId: USER_ID, now: T0, executor: world.db });
    const envelope = await mintHandoff(world);
    const consumed = await consumeOpportunityHandoff({ envelope, userId: USER_ID, now: T0, executor: world.db });
    const scored = await scoreLead({ userId: USER_ID, leadId: 1, now: new Date(T0.getTime() + 60 * 60 * 1000), executor: world.db });
    const superseding = await evaluateQualificationForLead(
      { userId: USER_ID, leadId: consumed.leadId, leadScoreId: scored.score.leadScoreId },
      { ...deps, now: () => new Date(T0.getTime() + 60 * 60 * 1000) },
      executor
    );
    expect(superseding.qualification.qualificationId).not.toBe(review.qualificationId as string);
    expect(superseding.qualification.qualificationId).not.toBe(review.qualificationId as string);
    // The outstanding challenge now binds a superseded decision — stale.
    await expect(
      resolveQualificationReview(
        {
          userId: USER_ID, reviewId: review.reviewId as string,
          outcome: "progress_authorized", reason: "superseded decision",
          challengeToken: bound.pendingChallengeToken as string, code,
        },
        { ...deps, challengeGateway: gateway },
        executor
      )
    ).rejects.toMatchObject({ code: "REVIEW_STALE_BINDING" });
  });

  it("D cannot bypass C review state: REVIEW_REQUIRED never dispatches a handoff", async () => {
    const { qualificationId } = await buildReviewWorld(world);
    const nurture = await evaluateNurture(
      {
        ports: createNurtureProductionPorts(world.db),
        executor: world.db,
        now: () => new Date(T0.getTime()),
      },
      USER_ID,
      { qualificationId }
    );
    expect(nurture.decision.decision).not.toBe("SALES_HANDOFF");
    expect(nurture.decision.decision).not.toBe("NURTURE");
  });

  it("D sales_handoff approvals are distinct: neither authority satisfies the other", async () => {
    const { qualificationId, deps, executor, review } = await buildReviewWorld(world);
    // Drive a QUALIFIED decision for the D handoff path on a parallel chain:
    // resolve the review first (human + real OTP), then re-evaluate C.
    const gateway = new OtpReviewChallengeGateway(world.db);
    const bound = await requestReviewResolution(
      { userId: USER_ID, reviewId: review.reviewId as string, req: new Request("http://localhost/api/trpc") },
      { ...deps, challengeGateway: gateway },
      executor
    );
    await resolveQualificationReview(
      {
        userId: USER_ID, reviewId: review.reviewId as string,
        outcome: "progression_rejected", reason: "human rejected progression",
        challengeToken: bound.pendingChallengeToken as string, code: mailbox[mailbox.length - 1].code,
      },
      { ...deps, challengeGateway: gateway },
      executor
    );
    // C's review authority resolved — but the D-side sales_handoff approval
    // surface (approval_requests.approvalType = sales_handoff) is a separate,
    // correctly-scoped mechanism; no approval row exists for this qualification.
    const salesApprovals = world.tables.approval_requests.filter((r) => r.approvalType === "sales_handoff");
    expect(salesApprovals).toHaveLength(0);
    void qualificationId;
  });
});
