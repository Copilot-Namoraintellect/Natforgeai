// ─── R5-X acceptance — engagement receipt → opportunity seam binding (X3.3) ───
//
// Proves the integrated C→D engagement-evidence binding:
//   1. a valid server-minted R5-C receipt strengthens an appropriate candidate;
//   2. a forged receipt id / non-successful receipt is rejected (fail closed);
//   3. a cross-business receipt is rejected;
//   4. receipt replay does not duplicate opportunity evidence;
//   5. lack of engagement receipt never blocks base A+B opportunity detection;
//   6. engagement evidence never turns an opportunity into a lead (no R6
//      handoff, candidate lifecycle unchanged).
//
// The public boundary is server-side: only an opaque engagementReceiptId
// crosses the API; the receipt row is loaded through R5-C's read-only store.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { getDb } from "../../queries/connection";
import { createFakeDb } from "../../r5-test-support";
import { evaluateOpportunity } from "./detector";
import {
  attachEngagementReceiptById,
  toEngagementReceiptLike,
  type EngagementReceiptLoader,
} from "./engagement-evidence-binding";
import { toValidatedEngagementReceipt } from "./engagement-evidence-seam";
import type { CanonicalInterpretationInput } from "./canonical-intelligence";

vi.mock("../../queries/connection", () => ({ getDb: vi.fn() }));
const mockedGetDb = vi.mocked(getDb);

type FakeRow = Record<string, unknown>;
type FakeTables = Record<string, FakeRow[]>;

function createSeededDb(extraSeed: FakeTables = {}) {
  return createFakeDb({
    businesses: [
      { id: 1, userId: 1 },
      { id: 2, userId: 2 },
    ],
    campaigns: [
      { id: 1, userId: 1 },
      { id: 2, userId: 2 },
    ],
    ...extraSeed,
  });
}

const T0 = new Date("2026-10-20T12:00:00.000Z");
let seq = 0;
function makeInterpretation(
  overrides: Partial<CanonicalInterpretationInput> = {}
): CanonicalInterpretationInput {
  seq += 1;
  return {
    interpretationId: `int-${seq}`,
    classifierVersion: "intent-sentiment-classifier/v1",
    userId: 1,
    businessId: 1,
    signalId: `sig-${seq}`,
    signalVersion: 1,
    signalType: "comment",
    provider: "meta",
    platform: "instagram",
    actorReference: "actor-1",
    parentExternalObjectId: "thread-1",
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

/** Builds an R5-C immutable receipt row (engagement_receipts shape). */
function makeReceiptRow(overrides: FakeRow = {}): FakeRow {
  return {
    id: 1,
    engagementReceiptId: "erec-1",
    executionId: "exec-1",
    businessId: 1,
    userId: 1,
    signalId: "sig-1",
    interpretationId: "int-1",
    actionRequestId: "mar-1",
    policyDecisionId: "pol-1",
    approvalRequestId: null,
    responseContentId: "rc-1",
    responseContentVersion: 1,
    provider: "meta",
    integrationId: 1,
    providerAccountRef: "acct-1",
    externalTarget: "comment-1",
    providerOperationIdentity: "op-1",
    providerExternalReceipt: "meta:mid-1",
    executedAt: "2026-10-20T13:00:00.000Z",
    status: "succeeded",
    reconciliationState: "none",
    createdAt: new Date("2026-10-20T13:00:05.000Z"),
    ...overrides,
  };
}

function loaderWith(row: FakeRow | null): EngagementReceiptLoader {
  return () => Promise.resolve(row as never);
}

async function expectErrorCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    expect.unreachable(`expected rejection with code ${code}`);
  } catch (err) {
    expect((err as { code?: string }).code).toBe(code);
  }
}

const OPPORTUNITY_AUDIT_TYPES = [
  "opportunity_detected",
  "opportunity_suppressed",
  "opportunity_state_changed",
  "opportunity_handed_off",
] as const;

function expectOnlyOpportunityAuditEvents(tables: FakeTables): void {
  for (const row of tables.audit_events) {
    expect(OPPORTUNITY_AUDIT_TYPES).toContain(row.eventType);
  }
}

beforeEach(() => {
  mockedGetDb.mockReset();
  seq = 0;
});

describe("R5-X3.3 engagement receipt → opportunity binding", () => {
  it("maps an R5-C receipt row to a seam-valid DTO (provider-confirmed follow-up)", () => {
    const dto = toEngagementReceiptLike(makeReceiptRow() as never);
    expect(dto.outcome).toBe("provider_confirmed_follow_up");
    expect(dto.sourceInterpretationId).toBe("int-1");
    expect(dto.sourceSignalId).toBe("sig-1");
    expect(dto.providerReceiptRef).toBe("meta:mid-1");
    expect(dto.occurredAt).toBe("2026-10-20T13:00:00.000Z");
    expect(dto.recordedAt).toBe("2026-10-20T13:00:05.000Z");
    // The derived hash passes the seam's own verification.
    expect(toValidatedEngagementReceipt(dto).engagementReceiptId).toBe("erec-1");
  });

  it("refuses a non-succeeded receipt as outcome evidence", () => {
    try {
      toEngagementReceiptLike(makeReceiptRow({ status: "failed" }) as never);
      expect.unreachable("expected a non-succeeded receipt to be refused");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("RECEIPT_NOT_SUCCESSFUL");
    }
  });

  it("1+5: valid receipt strengthens; base detection needs no receipt", async () => {
    const fake = createSeededDb();
    mockedGetDb.mockReturnValue(fake.db as never);
    const interpretation = makeInterpretation({ interpretationId: "int-1", signalId: "sig-1" });
    const created = await evaluateOpportunity({
      interpretation,
      userId: 1,
      now: T0,
      executor: fake.db as never,
    });
    expect(created.kind).toBe("candidate_created");
    const opportunityId = (created as { opportunityId: string }).opportunityId;
    // Base candidate evidence exists without any engagement receipt.
    expect(fake.seed.opportunity_evidence.some((r) => r.kind === "engagement_receipt")).toBe(false);

    const attached = await attachEngagementReceiptById({
      userId: 1,
      opportunityId,
      engagementReceiptId: "erec-1",
      loadReceipt: loaderWith(makeReceiptRow()),
      now: new Date(T0.getTime() + 3600_000),
      executor: fake.db as never,
    });
    expect(attached.kind).toBe("engagement_evidence_attached");
    expect(attached.evidenceCount).toBe(2);
    expect(
      fake.seed.opportunity_evidence.some((r) => r.kind === "engagement_receipt")
    ).toBe(true);
    expectOnlyOpportunityAuditEvents(fake.seed);
  });

  it("2: forged receipt id fails closed (no server-minted receipt)", async () => {
    const fake = createSeededDb();
    mockedGetDb.mockReturnValue(fake.db as never);
    const created = await evaluateOpportunity({
      interpretation: makeInterpretation({ interpretationId: "int-1", signalId: "sig-1" }),
      userId: 1,
      now: T0,
      executor: fake.db as never,
    });
    await expectErrorCode(
      attachEngagementReceiptById({
        userId: 1,
        opportunityId: (created as { opportunityId: string }).opportunityId,
        engagementReceiptId: "erec-forged",
        loadReceipt: loaderWith(null),
        now: new Date(T0.getTime() + 3600_000),
        executor: fake.db as never,
      }),
      "RECEIPT_NOT_FOUND"
    );
    expect(fake.seed.opportunity_evidence).toHaveLength(1);
  });

  it("3: cross-business receipt rejected; candidate unchanged", async () => {
    const fake = createSeededDb();
    mockedGetDb.mockReturnValue(fake.db as never);
    const created = await evaluateOpportunity({
      interpretation: makeInterpretation({ interpretationId: "int-1", signalId: "sig-1" }),
      userId: 1,
      now: T0,
      executor: fake.db as never,
    });
    await expectErrorCode(
      attachEngagementReceiptById({
        userId: 1,
        opportunityId: (created as { opportunityId: string }).opportunityId,
        engagementReceiptId: "erec-xbiz",
        loadReceipt: loaderWith(makeReceiptRow({ businessId: 2, userId: 2 })),
        now: new Date(T0.getTime() + 3600_000),
        executor: fake.db as never,
      }),
      "EVIDENCE_BINDING_MISMATCH"
    );
    expect(fake.seed.opportunity_evidence).toHaveLength(1);
  });

  it("4: receipt replay does not duplicate opportunity evidence", async () => {
    const fake = createSeededDb();
    mockedGetDb.mockReturnValue(fake.db as never);
    const created = await evaluateOpportunity({
      interpretation: makeInterpretation({ interpretationId: "int-1", signalId: "sig-1" }),
      userId: 1,
      now: T0,
      executor: fake.db as never,
    });
    const opportunityId = (created as { opportunityId: string }).opportunityId;
    const input = {
      userId: 1,
      opportunityId,
      engagementReceiptId: "erec-1",
      loadReceipt: loaderWith(makeReceiptRow()),
      now: new Date(T0.getTime() + 3600_000),
      executor: fake.db as never,
    };
    const first = await attachEngagementReceiptById(input);
    expect(first.kind).toBe("engagement_evidence_attached");
    const second = await attachEngagementReceiptById(input);
    expect(second.kind).toBe("idempotent_replay");
    expect(second.evidenceCount).toBe(2);
    expect(fake.seed.opportunity_evidence).toHaveLength(2);
    expect(fake.seed.opportunity_candidates).toHaveLength(1);
  });

  it("6: engagement evidence never turns the opportunity into a lead", async () => {
    const fake = createSeededDb();
    mockedGetDb.mockReturnValue(fake.db as never);
    const created = await evaluateOpportunity({
      interpretation: makeInterpretation({ interpretationId: "int-1", signalId: "sig-1" }),
      userId: 1,
      now: T0,
      executor: fake.db as never,
    });
    const opportunityId = (created as { opportunityId: string }).opportunityId;
    await attachEngagementReceiptById({
      userId: 1,
      opportunityId,
      engagementReceiptId: "erec-1",
      loadReceipt: loaderWith(makeReceiptRow()),
      now: new Date(T0.getTime() + 3600_000),
      executor: fake.db as never,
    });
    // Candidate remains a pre-handoff candidate; no R6 handoff envelope exists;
    // the CRM leads table is never written by R5.
    const candidate = fake.seed.opportunity_candidates[0];
    expect(String(candidate.status)).not.toBe("handed_off_to_r6");
    expect(fake.seed.opportunity_handoffs ?? []).toHaveLength(0);
    expect(fake.seed.leads ?? []).toHaveLength(0);
  });
});
