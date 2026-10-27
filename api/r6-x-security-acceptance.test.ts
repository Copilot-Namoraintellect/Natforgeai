/**
 * R6-X — X8 Cross-Agent / Security Acceptance.
 *
 * Explicit integrated adversarial acceptance under the rogue-agent framework:
 * any one AI/model/agent may be compromised, hallucinate, be prompt-injected
 * or emit malicious output — AI/agent output is untrusted data and every
 * boundary re-validates schema, contract version, tenant/business scope,
 * identity, provenance, freshness, privacy and policy. Server-side governed
 * code is the only authority.
 *
 * Drives the REAL services on the shared harness store; no network, no wall
 * clock reliance, no live provider/CRM/billing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb must not fall back to a real connection in r6-x security tests");
  }),
}));

vi.mock("./lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/email")>();
  return {
    ...actual,
    sendTwoFactorCodeEmail: vi.fn(async (input: { to: string; code: string }) => {
      return { messageId: "mailbox", accepted: [input.to] } as never;
    }),
  };
});

import { evaluateOpportunity, handoffToR6 } from "./lib/opportunity/detector";
import type { CanonicalInterpretationInput } from "./lib/opportunity/canonical-intelligence";
import {
  consumeOpportunityHandoff,
  submitIdentityEvidence,
} from "./lib/lead-identity/lead-identity-service";
import { scoreLead } from "./lib/scoring/scoring-service";
import {
  evaluateQualificationForLead,
  type QualificationAuthorityDeps,
} from "./lib/qualification/qualification-service";
import {
  createQualificationBridgeProvider,
  bindQualificationStoreExecutor,
} from "./lib/qualification/qualification-bridge";
import { createNurtureProductionPorts } from "./lib/nurture/nurture-ports";
import { evaluateNurture } from "./lib/nurture/nurture-service";
import { ingestConversion } from "./lib/conversion/conversion-service";
import { readFileSync } from "node:fs";
import { createHarnessDb, type Harness } from "./r6-x-harness";

const T0 = new Date("2026-10-20T12:00:00.000Z");
const USER_ID = 1;
const OTHER_USER_ID = 2;
const BIZ_1 = 1;

let seq = 0;
function makeInterpretation(overrides: Partial<CanonicalInterpretationInput> = {}): CanonicalInterpretationInput {
  seq += 1;
  return {
    interpretationId: `sec-int-${seq}`,
    classifierVersion: "intent-sentiment-classifier/v1",
    userId: USER_ID,
    businessId: BIZ_1,
    signalId: `sec-sig-${seq}`,
    signalVersion: 1,
    signalType: "comment",
    provider: "meta",
    platform: "instagram",
    actorReference: `sec-actor-${seq}`,
    parentExternalObjectId: `sec-thread-${seq}`,
    externalObjectId: `sec-comment-${seq}`,
    sourceCampaignId: 1,
    source: "MODEL",
    intent: "purchase_interest",
    sentiment: "positive",
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

async function mintHandoff(world: World): Promise<Record<string, unknown>> {
  const interpretation = makeInterpretation();
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

async function buildQualifiedWorld(world: World) {
  for (let i = 0; i < 3; i += 1) {
    const interpretation = makeInterpretation();
    const evaluated = await evaluateOpportunity({ interpretation, userId: USER_ID, now: T0, executor: world.db });
    if (evaluated.kind !== "candidate_created" && evaluated.kind !== "candidate_strengthened") {
      throw new Error(`fixture expected a candidate, got ${evaluated.kind}`);
    }
  }
  const envelope = await mintHandoff(world);
  const consumed = await consumeOpportunityHandoff({ envelope, userId: USER_ID, now: T0, executor: world.db });
  const scored = await scoreLead({ userId: USER_ID, leadId: 1, now: T0, executor: world.db });
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
  return { deps, executor, lid1: consumed.leadId, leadScoreId: scored.score.leadScoreId, result };
}

describe("R6-X X8 — cross-agent / security acceptance", () => {
  let world: World;

  beforeEach(() => {
    world = { harness: createHarnessDb(), db: undefined as never, tables: undefined as never };
    world.db = world.harness.db;
    world.tables = world.harness.tables;
    world.harness.seed("businesses", [
      { id: BIZ_1, userId: USER_ID },
      { id: 2, userId: OTHER_USER_ID },
    ]);
    world.harness.seed("campaigns", [
      { id: 1, userId: USER_ID, businessId: BIZ_1 },
      { id: 2, userId: OTHER_USER_ID, businessId: 2 },
    ]);
    world.harness.seed("users", [
      { id: USER_ID, email: "owner@example.com" },
      { id: OTHER_USER_ID, email: "other@example.com" },
    ]);
    world.harness.seed("leads", [
      { id: 1, userId: USER_ID, businessId: BIZ_1, campaignId: 1, status: "new", score: 0 },
    ]);
  });

  it("agent fabricates businessId — ownership re-verification fails closed", async () => {
    await buildQualifiedWorld(world);
    // Fabricated business id the tenant does not own.
    await expect(
      ingestConversion(
        world.db, {}, { userId: USER_ID },
        {
          businessId: 999, leadId: 1, externalConversionId: "x1",
          sourceSystem: "stripe", conversionType: "purchase",
          occurredAt: "2026-10-20T13:00:00.000Z",
        },
        "2026-10-20T13:00:01.000Z"
      )
    ).rejects.toThrow(/OWNERSHIP|not found/i);
  });

  it("agent fabricates leadId / qualificationId / conversionId — all fail closed", async () => {
    const { lid1, leadScoreId } = await buildQualifiedWorld(world);
    await expect(
      evaluateQualificationForLead(
        { userId: USER_ID, leadId: "lid1:ff".padEnd(69, "f"), leadScoreId },
        { provider: createQualificationBridgeProvider(world.db, USER_ID), now: () => new Date(T0.getTime()) },
        bindQualificationStoreExecutor(world.db)
      )
    ).rejects.toThrow(/not found/i);
    await expect(
      evaluateNurture(
        { ports: createNurtureProductionPorts(world.db), executor: world.db, now: () => new Date(T0.getTime()) },
        USER_ID,
        { qualificationId: "lqu1:ff".padEnd(69, "f") }
      )
    ).rejects.toThrow(/QUALIFICATION_NOT_FOUND/);
    await expect(
      ingestConversion(
        world.db, {}, { userId: USER_ID },
        {
          businessId: BIZ_1, leadId: 1, externalConversionId: "x2",
          sourceSystem: "stripe", conversionType: "purchase",
          occurredAt: "2026-10-20T13:00:00.000Z",
          // Fabricated provenance + reversal target that does not exist.
          reversesConversionId: "cnv1:ff".padEnd(69, "f"),
        },
        "2026-10-20T13:00:01.000Z"
      )
    ).rejects.toThrow();
    void lid1;
  });

  it('"ignore previous policy" injection cannot alter the deterministic engine', async () => {
    const { lid1, leadScoreId, result } = await buildQualifiedWorld(world);
    // The engine is pure rules + evidence; no policy text is accepted anywhere.
    const scoreRow = world.tables.lead_score_snapshots.find((r) => r.leadScoreId === leadScoreId);
    const tampered = {
      ...(scoreRow as Record<string, unknown>),
      reasonCodes: [...(JSON.parse(JSON.stringify(scoreRow?.reasonCodes)) as string[]), "IGNORE_PREVIOUS_POLICY"],
    };
    world.tables.lead_score_snapshots[world.tables.lead_score_snapshots.indexOf(scoreRow as never)] = tampered as never;
    await expect(
      evaluateQualificationForLead(
        { userId: USER_ID, leadId: lid1, leadScoreId },
        { provider: createQualificationBridgeProvider(world.db, USER_ID), now: () => new Date(T0.getTime()) },
        bindQualificationStoreExecutor(world.db)
      )
    ).rejects.toThrow(/reasonCodes\[\]|INVALID_SCORE/i);
    expect(result.qualification.decision).toBeDefined();
  });

  it("external lead content with tool instructions never reaches an execution surface", async () => {
    const envelope = await mintHandoff(world);
    const consumed = await consumeOpportunityHandoff({
      envelope,
      userId: USER_ID,
      now: T0,
      executor: world.db,
    });
    // The identity projection carries references + closed labels only.
    const idRow = world.tables.lead_identities.find((r) => r.leadId === consumed.leadId);
    expect(JSON.stringify(idRow)).not.toMatch(/curl|wget|exec|spawn|eval|SELECT|DROP|api[_-]?key/i);
    expect(idRow?.identityKey).toMatch(/^[a-f0-9]{64}$/);
  });

  it("model-proposed shell/SQL/secret requests have no runtime surface in R6 modules", () => {
    const modules = [
      "api/lib/lead-identity/lead-identity-service.ts",
      "api/lib/scoring/scoring-service.ts",
      "api/lib/qualification/qualification-service.ts",
      "api/lib/nurture/nurture-service.ts",
      "api/lib/conversion/conversion-service.ts",
      "api/lib/nurture/nurture-ports.ts",
      "api/lib/qualification/qualification-bridge.ts",
    ];
    for (const mod of modules) {
      const src = readFileSync(mod, "utf-8");
      expect(src).not.toMatch(/child_process|execSync|\bspawn\b|\beval\b|new Function|process\.env\.[A-Z_]*(?:SECRET|TOKEN|KEY)/);
      // No direct raw-SQL string execution outside drizzle builders.
      expect(src).not.toMatch(/db\.execute\(\s*[`'"]\s*(SELECT|INSERT|UPDATE|DELETE)/i);
    }
  });

  it("upstream agent injects unknown contract fields — strict seams reject", async () => {
    const envelope = await mintHandoff(world);
    const tampered = { ...(envelope as Record<string, unknown>), forgedAuthorityField: "QUALIFIED", riskTier: "low" };
    await expect(
      consumeOpportunityHandoff({ envelope: tampered, userId: USER_ID, now: T0, executor: world.db })
    ).rejects.toThrow(/envelope|validation|unknown/i);
  });

  it("stale contract version fails closed", async () => {
    const envelope = await mintHandoff(world);
    const tampered = {
      ...(envelope as Record<string, unknown>),
      handoffEnvelopeVersion: "opportunity-to-lead-autonomy/v0",
    };
    await expect(
      consumeOpportunityHandoff({ envelope: tampered, userId: USER_ID, now: T0, executor: world.db })
    ).rejects.toThrow(/version/i);
  });

  it("self-approval: an agent cannot mint review authorization", async () => {
    const { lid1, leadScoreId } = await buildQualifiedWorld(world);
    // Force REVIEW_REQUIRED via contradiction, then attempt self-resolution.
    const interp = makeInterpretation({ sentiment: "negative" });
    await evaluateOpportunity({ interpretation: interp, userId: USER_ID, now: T0, executor: world.db });
    const scored2 = await scoreLead({ userId: USER_ID, leadId: 1, now: new Date(T0.getTime() + 60 * 60 * 1000), executor: world.db });
    const reviewResult = await evaluateQualificationForLead(
      { userId: USER_ID, leadId: lid1, leadScoreId: scored2.score.leadScoreId },
      { provider: createQualificationBridgeProvider(world.db, USER_ID), now: () => new Date(T0.getTime()) },
      bindQualificationStoreExecutor(world.db)
    );
    expect(reviewResult.qualification.decision).toBe("REVIEW_REQUIRED");
    // No challenge issued: resolution requires the out-of-band proof.
    const review = world.tables.lead_qualification_reviews[world.tables.lead_qualification_reviews.length - 1];
    const { resolveQualificationReview } = await import("./lib/qualification/qualification-service");
    await expect(
      resolveQualificationReview(
        {
          userId: USER_ID, reviewId: review.reviewId as string,
          outcome: "progress_authorized", reason: "agent self-approval",
          challengeToken: "forged-token", code: "123456",
        },
        { provider: createQualificationBridgeProvider(world.db, USER_ID), now: () => new Date(T0.getTime()) },
        bindQualificationStoreExecutor(world.db)
      )
    ).rejects.toMatchObject({ code: "REVIEW_AUTHORIZATION_BINDING_MISMATCH" });
    void leadScoreId;
  });

  it("privacy bypass attempt: suppressed identity cannot be enriched or scored into action", async () => {
    const envelope = await mintHandoff(world);
    const consumed = await consumeOpportunityHandoff({ envelope, userId: USER_ID, now: T0, executor: world.db });
    const { suppressLeadIdentity } = await import("./lib/lead-identity/lead-identity-service");
    await suppressLeadIdentity({ userId: USER_ID, leadId: consumed.leadId, reason: "privacy_request", now: T0, executor: world.db });
    await expect(
      submitIdentityEvidence({ userId: USER_ID, leadId: consumed.leadId, evidenceType: "email", value: "bypass@example.com", now: T0, executor: world.db })
    ).rejects.toMatchObject({ code: "IDENTITY_STATE_CONFLICT" });
  });

  it("score manipulation: tampered weights/components fail the coherence check", async () => {
    const { lid1, leadScoreId } = await buildQualifiedWorld(world);
    const scoreRow = world.tables.lead_score_snapshots.find((r) => r.leadScoreId === leadScoreId) as Record<string, unknown>;
    scoreRow.componentWeights = { fit: 0.9, intent: 0.9, engagement: 0.9, recency: 0.9, opportunity: 0.9 };
    await expect(
      evaluateQualificationForLead(
        { userId: USER_ID, leadId: lid1, leadScoreId },
        { provider: createQualificationBridgeProvider(world.db, USER_ID), now: () => new Date(T0.getTime()) },
        bindQualificationStoreExecutor(world.db)
      )
    ).rejects.toThrow(/INVALID_SCORE|weight/i);
  });

  it("policy manipulation: unknown policy version fails closed", async () => {
    const { lid1, leadScoreId } = await buildQualifiedWorld(world);
    await expect(
      evaluateQualificationForLead(
        { userId: USER_ID, leadId: lid1, leadScoreId, policyVersion: "lead-qualification-policy/v999" },
        { provider: createQualificationBridgeProvider(world.db, USER_ID), now: () => new Date(T0.getTime()) },
        bindQualificationStoreExecutor(world.db)
      )
    ).rejects.toThrow(/unknown qualification policy version/i);
  });

  it("billing identity manipulation: R6 surfaces expose no billing identity field", async () => {
    await buildQualifiedWorld(world);
    const auditRows = world.tables.audit_events;
    for (const row of auditRows) {
      expect(JSON.stringify(row)).not.toMatch(/billingIdentity|invoiceId|walletId|creditReservation/i);
    }
    const decision = world.tables.lead_qualifications[0];
    expect(JSON.stringify(decision)).not.toMatch(/billing/i);
  });

  it("cross-tenant cached result reuse fails closed", async () => {
    const { lid1, leadScoreId } = await buildQualifiedWorld(world);
    // Tenant 2 reuses tenant 1's cached score id + lid1 verbatim.
    await expect(
      evaluateQualificationForLead(
        { userId: OTHER_USER_ID, leadId: lid1, leadScoreId },
        { provider: createQualificationBridgeProvider(world.db, OTHER_USER_ID), now: () => new Date(T0.getTime()) },
        bindQualificationStoreExecutor(world.db)
      )
    ).rejects.toThrow(/not found/i);
    await expect(
      scoreLead({ userId: OTHER_USER_ID, leadId: 1, now: T0, executor: world.db })
    ).rejects.toMatchObject({ code: "LEAD_NOT_FOUND" });
  });

  it("generic force-state path does not exist (suppression is terminal until governance)", async () => {
    const envelope = await mintHandoff(world);
    const consumed = await consumeOpportunityHandoff({ envelope, userId: USER_ID, now: T0, executor: world.db });
    const { suppressLeadIdentity } = await import("./lib/lead-identity/lead-identity-service");
    await suppressLeadIdentity({ userId: USER_ID, leadId: consumed.leadId, reason: "privacy_request", now: T0, executor: world.db });
    // No un-suppress/force-state API on the A surface: enrichment still fails.
    await expect(
      submitIdentityEvidence({ userId: USER_ID, leadId: consumed.leadId, evidenceType: "phone", value: "+15550002", now: T0, executor: world.db })
    ).rejects.toMatchObject({ code: "IDENTITY_STATE_CONFLICT" });
    const row = world.tables.lead_identities.find((r) => r.leadId === consumed.leadId);
    expect(row?.identityStatus).toBe("suppressed");
  });

  it("provider success fabrication: no transport ⇒ dispatch fails closed", async () => {
    const { result } = await buildQualifiedWorld(world);
    expect(result.qualification.decision).toBe("QUALIFIED");
    const nurture = await evaluateNurture(
      { ports: createNurtureProductionPorts(world.db), executor: world.db, now: () => new Date(T0.getTime()) },
      USER_ID,
      { qualificationId: result.qualification.qualificationId }
    );
    expect(nurture.decision.decision).toBe("SALES_HANDOFF");
    // An agent asserting success cannot fabricate the receipt: no transport
    // is wired, so dispatch fails closed and no dispatch receipt exists.
    const { dispatchHandoff } = await import("./lib/nurture/nurture-service");
    await expect(
      dispatchHandoff(
        { ports: createNurtureProductionPorts(world.db), executor: world.db, now: () => new Date(T0.getTime()) },
        USER_ID,
        { handoffId: nurture.handoff?.handoffId as string }
      )
    ).rejects.toThrow(/APPROVAL_PENDING|CAPABILITY_UNSUPPORTED/);
    expect(world.tables.handoff_dispatch_receipts).toHaveLength(0);
  });

  it("CRM success fabrication: CRM channel is UNSUPPORTED — no CRM rows are created", async () => {
    const { result } = await buildQualifiedWorld(world);
    const nurture = await evaluateNurture(
      { ports: createNurtureProductionPorts(world.db), executor: world.db, now: () => new Date(T0.getTime()) },
      USER_ID,
      { qualificationId: result.qualification.qualificationId, channel: "crm" }
    );
    expect(nurture.decision.decision).not.toBe("SALES_HANDOFF");
    // No CRM/leads rows are ever created by the nurture surface.
    expect(world.tables.leads).toHaveLength(1);
  });

  it("runtime agent cannot reach human-review authority or secrets through R6 modules", () => {
    const modules = [
      "api/lib/lead-identity/lead-identity-service.ts",
      "api/lib/qualification/qualification-service.ts",
      "api/lib/nurture/nurture-service.ts",
      "api/lib/conversion/conversion-service.ts",
      "api/lib/nurture/nurture-ports.ts",
      "api/lib/qualification/qualification-bridge.ts",
      "api/lib/governance/lead-privacy-store.ts",
    ];
    for (const mod of modules) {
      const src = readFileSync(mod, "utf-8");
      // No secret material, no challenge codes, no mailbox access.
      expect(src).not.toMatch(/otpHash|verificationCode|sendTwoFactor|bcrypt/i);
      expect(src).not.toMatch(/process\.env/);
    }
  });
});
