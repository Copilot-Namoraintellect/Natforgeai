import { describe, expect, it, vi, beforeEach } from "vitest";
import { runInterpretation, type InterpretationDeps } from "./interpreter";
import {
  InterpretationTamperError,
  type ModelInterpretation,
  type SocialInterpretation,
} from "./interpretation-contract";
import type { CanonicalSocialSignalInput } from "./canonical-signal";
import type { BusinessDNASnapshot } from "../business-dna";
import {
  buildInterpretationBillingIdentity,
  computeInterpretationId,
  computeSignalContentHash,
} from "./interpretation-identity";
import { CLASSIFIER_VERSION, SOCIAL_INTELLIGENCE_SCHEMA_VERSION } from "./interpretation-contract";
import { sanitizeSignalText } from "./input-safety";
import { toCanonicalSignal } from "./canonical-signal";

const FIXED_NOW = new Date("2026-06-15T08:00:00.000Z");
const CLASSIFIER = CLASSIFIER_VERSION;

const SPAM_SIGNAL: CanonicalSocialSignalInput = {
  signalId: "sig-int-1",
  signalVersion: 1,
  signalType: "comment",
  platform: "instagram",
  text: "Double your Bitcoin in 7 days, claim your airdrop now",
};

const AMBIGUOUS_SIGNAL: CanonicalSocialSignalInput = {
  signalId: "sig-int-2",
  signalVersion: 1,
  signalType: "message",
  platform: "instagram",
  actorHandle: "@prospect",
  text: "Do you deliver artisan coffee beans on weekends?",
  occurredAt: "2026-06-14T10:00:00Z",
  metadata: { provider: "fixture" },
};

const MODEL_FIXTURE: ModelInterpretation = {
  intent: "purchase_interest",
  sentiment: "positive",
  urgency: "normal",
  modelConfidence: "high",
  relevanceHint: "not_relevant",
  topics: ["Pricing", "delivery"],
  riskHints: [],
  opportunityHints: ["purchase_intent_detected"],
  evidence: ["asks about purchasing and delivery"],
  explanation: "The signal asks about purchasing and delivery.",
};

const DNA_SNAPSHOT: BusinessDNASnapshot = {
  snapshotId: "shadow-bdna-7-fixture",
  businessId: 7,
  version: 1,
  evidenceHashSha256: "b".repeat(64),
  capturedAtIso: "2026-06-01T00:00:00Z",
  businessName: "Bean There Coffee Co",
  industry: "Food & Beverage",
  primaryOffering: "artisan coffee beans",
  productsAndServices: ["cold brew concentrate"],
  verifiedUseCases: [],
  targetCustomerSegments: [],
  customerPainPoints: [],
  supportedOutcomes: [],
  capabilities: [],
  approvedClaims: [],
  prohibitedClaims: [],
  brandLanguageConstraints: [],
  evidenceReferences: [],
};

interface Harness {
  deps: InterpretationDeps;
  state: { rows: any[]; inserts: any[]; audits: unknown[]; runModelCalls: any[] };
  runModel: ReturnType<typeof vi.fn>;
  persistAudit: ReturnType<typeof vi.fn>;
  now: ReturnType<typeof vi.fn>;
  loadDna: ReturnType<typeof vi.fn>;
}

function collectPredicateValues(conds: unknown[]): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<object>();
  const walk = (value: unknown): void => {
    if (value === null || value === undefined) return;
    if (typeof value === "number") {
      out.push(value);
      return;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed || /^[=<>!\s&|]+$/.test(trimmed) || /^(and|or)$/i.test(trimmed)) return;
      out.push(value);
      return;
    }
    if (typeof value !== "object") return;
    if (seen.has(value as object)) return;
    seen.add(value as object);
    const rec = value as Record<string, unknown>;
    if ("name" in rec && "table" in rec) return;
    if (Array.isArray(rec.value) && !("queryChunks" in rec)) return;
    if ("queryChunks" in rec) {
      for (const chunk of rec.queryChunks as unknown[]) walk(chunk);
      return;
    }
    for (const nested of Object.values(rec)) walk(nested);
  };
  for (const cond of conds) walk(cond);
  return out;
}

function createHarness(options: { dna?: BusinessDNASnapshot | null } = {}): Harness {
  const state: Harness["state"] = { rows: [], inserts: [], audits: [], runModelCalls: [] };
  const runModel = vi.fn(async (args: any) => {
    state.runModelCalls.push(args);
    return MODEL_FIXTURE;
  });
  const persistAudit = vi.fn(async (event: unknown) => {
    state.audits.push(event);
  });
  const now = vi.fn(() => FIXED_NOW);
  const loadDna = vi.fn(async () => options.dna ?? null);
  const executor: any = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((...conds: any[]) => {
          const wanted = collectPredicateValues(conds);
          const filtered = state.rows.filter((r) =>
            wanted.every((v) => Object.values(r).includes(v))
          );
          return {
            limit: vi.fn(async () => filtered.slice(0, 1)),
            orderBy: vi.fn(async () =>
              [...filtered].sort(
                (a, b) =>
                  a.signalVersion - b.signalVersion ||
                  String(a.classifierVersion).localeCompare(String(b.classifierVersion))
              )
            ),
          };
        }),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async (row: any) => {
        if (
          state.rows.some((r) => r.interpretationId === row.interpretationId) ||
          state.rows.some(
            (r) =>
              r.businessId === row.businessId &&
              r.signalId === row.signalId &&
              r.signalVersion === row.signalVersion &&
              r.classifierVersion === row.classifierVersion
          )
        ) {
          const error: any = new Error("Duplicate entry");
          error.code = "ER_DUP_ENTRY";
          error.errno = 1062;
          throw error;
        }
        state.rows.push(row);
        state.inserts.push(row);
        return [{ insertId: state.rows.length, affectedRows: 1 }];
      }),
    })),
  };
  const deps: InterpretationDeps = { runModel, persistAudit, now, executor, loadOwnedBusinessDnaSnapshot: loadDna };
  return { deps, state, runModel, persistAudit, now, loadDna };
}

function toRow(record: SocialInterpretation) {
  return {
    id: 700 + record.signalVersion,
    userId: record.userId,
    businessId: record.businessId,
    signalId: record.signalId,
    signalVersion: record.signalVersion,
    signalContentHash: record.signalContentHash,
    classifierVersion: record.classifierVersion,
    interpretationId: record.interpretationId,
    modelOrRuleSource: record.source,
    intent: record.intent,
    sentiment: record.sentiment,
    urgency: record.urgency,
    relevance: record.relevance,
    overallConfidence: record.overallConfidence,
    recommendedHandling: record.recommendedHandling,
    billingIdentity: record.billingIdentity,
    record: record as unknown as Record<string, unknown>,
    createdAt: new Date(record.createdAt),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runInterpretation — rules path", () => {
  it("spam signal: RULE record, null billing identity, no model call, one audit event", async () => {
    const h = createHarness();
    const result = await runInterpretation(
      { userId: 7, businessId: 3, signal: SPAM_SIGNAL },
      h.deps
    );

    expect(result.replayed).toBe(false);
    expect(result.record.source).toBe("RULE");
    expect(result.record.billingIdentity).toBeNull();
    expect(result.record.intent).toBe("spam");
    expect(result.record.recommendedHandling).toBe("no_action");
    expect(result.record.createdAt).toBe(FIXED_NOW.toISOString());
    expect(h.runModel).not.toHaveBeenCalled();
    expect(h.state.audits).toHaveLength(1);
    expect(h.now).toHaveBeenCalledTimes(1);
  });

  it("emits an interpretation_recorded audit event with sanitized metadata (no text)", async () => {
    const h = createHarness();
    await runInterpretation({ userId: 7, businessId: 3, signal: SPAM_SIGNAL }, h.deps);

    const event: any = h.state.audits[0];
    expect(event.eventType).toBe("interpretation_recorded");
    expect(event.source).toBe("workflow");
    expect(event.outcome).toBe("succeeded");
    expect(event.userId).toBe(7);
    expect(event.businessId).toBe(3);
    expect(event.occurredAt).toBe(FIXED_NOW.toISOString());
    expect(event.metadata.interpretationId).toBe(resultId(h));
    expect(event.metadata.modelOrRuleSource).toBe("RULE");
    expect(JSON.stringify(event.metadata)).not.toContain("Double your Bitcoin");
  });

  it("rejects unknown signalType before any model call or audit", async () => {
    const h = createHarness();
    await expect(
      runInterpretation(
        { userId: 7, businessId: 3, signal: { ...SPAM_SIGNAL, signalType: "story" as never } },
        h.deps
      )
    ).rejects.toMatchObject({ code: "UNSUPPORTED_SIGNAL_TYPE" });
    expect(h.runModel).not.toHaveBeenCalled();
    expect(h.state.audits).toHaveLength(0);
    expect(h.state.inserts).toHaveLength(0);
  });
});

describe("runInterpretation — model path", () => {
  it("calls the model once with the forward billing identity and minimal DNA context", async () => {
    const h = createHarness({ dna: DNA_SNAPSHOT });
    const result = await runInterpretation(
      { userId: 7, businessId: 7, signal: AMBIGUOUS_SIGNAL, campaignId: 9 },
      h.deps
    );

    expect(h.runModel).toHaveBeenCalledTimes(1);
    const call = h.runModel.mock.calls[0][0];
    expect(call.userId).toBe(7);
    expect(call.businessId).toBe(7);
    expect(call.campaignId).toBe(9);
    expect(call.dnaContext).toEqual({
      businessName: "Bean There Coffee Co",
      primaryOffering: "artisan coffee beans",
      productsAndServices: ["cold brew concentrate"],
    });
    expect(Object.keys(call.dnaContext).sort()).toEqual(
      ["businessName", "primaryOffering", "productsAndServices"].sort()
    );

    const signal = sanitizeSignalText(toCanonicalSignal(AMBIGUOUS_SIGNAL));
    const expectedBilling = buildInterpretationBillingIdentity({
      businessId: 7,
      signalId: signal.signalId,
      signalVersion: signal.signalVersion,
      signalContentHash: computeSignalContentHash(signal),
      classifierVersion: CLASSIFIER,
    });
    expect(call.billingIdentity).toBe(expectedBilling);

    expect(result.record.source).toBe("MODEL");
    expect(result.record.billingIdentity).toBe(expectedBilling);
    expect(result.record.businessDnaSnapshotId).toBe(DNA_SNAPSHOT.snapshotId);
  });

  it("deterministic DNA relevance wins; the model relevanceHint is ignored", async () => {
    const h = createHarness({ dna: DNA_SNAPSHOT });
    const result = await runInterpretation(
      { userId: 7, businessId: 7, signal: AMBIGUOUS_SIGNAL },
      h.deps
    );
    // Model fixture claims "not_relevant", but the DNA overlap is strong.
    expect(result.record.relevance).toBe("relevant");
    expect(result.record.relevanceConfidence).toBe("high");
    expect(result.record.businessDnaSnapshotId).toBe(DNA_SNAPSHOT.snapshotId);
    expect(
      result.record.evidenceReferences.some((ref) => ref.kind === "business_dna")
    ).toBe(true);
  });

  it("context-free run uses the model hint at bounded confidence", async () => {
    const h = createHarness({ dna: null });
    h.runModel.mockResolvedValueOnce({ ...MODEL_FIXTURE, relevanceHint: "relevant" });
    const result = await runInterpretation(
      { userId: 7, businessId: 7, signal: AMBIGUOUS_SIGNAL },
      h.deps
    );
    expect(h.runModel.mock.calls[0][0].dnaContext).toBeNull();
    expect(result.record.relevance).toBe("relevant"); // model hint consumed
    expect(result.record.relevanceConfidence).toBe("medium");
    expect(result.record.businessDnaSnapshotId).toBeNull();
  });

  it("normalizes topics (lowercase, dedup, bounded) and assembles bounded evidence", async () => {
    const h = createHarness({ dna: DNA_SNAPSHOT });
    h.runModel.mockResolvedValueOnce({
      ...MODEL_FIXTURE,
      topics: ["Pricing", "pricing", "  DELIVERY  ", "x"],
    });
    const result = await runInterpretation(
      { userId: 7, businessId: 7, signal: AMBIGUOUS_SIGNAL },
      h.deps
    );
    expect(result.record.topics).toEqual(["pricing", "delivery", "x"]);
    expect(result.record.evidenceReferences.length).toBeLessThanOrEqual(8);
    expect(
      result.record.evidenceReferences.some((ref) => ref.kind === "signal_excerpt")
    ).toBe(true);
    expect(result.record.evidenceReferences.some((ref) => ref.kind === "model")).toBe(true);
  });

  it("confidence gate: model low confidence never surfaces candidate_for_engagement", async () => {
    const h = createHarness({ dna: null });
    h.runModel.mockResolvedValueOnce({ ...MODEL_FIXTURE, modelConfidence: "low" });
    const result = await runInterpretation(
      { userId: 7, businessId: 7, signal: AMBIGUOUS_SIGNAL },
      h.deps
    );
    expect(result.record.overallConfidence).toBe("low");
    expect(result.record.recommendedHandling).toBe("human_review");
    expect(result.record.recommendedHandling).not.toBe("candidate_for_engagement");
  });
});

describe("runInterpretation — replay & tamper", () => {
  it("second identical call is a replay: no model call, no audit, no extra clock read", async () => {
    const h = createHarness({ dna: DNA_SNAPSHOT });
    const args = { userId: 7, businessId: 7, signal: AMBIGUOUS_SIGNAL };
    const first = await runInterpretation(args, h.deps);
    expect(first.replayed).toBe(false);
    expect(h.state.audits).toHaveLength(1);
    expect(h.now).toHaveBeenCalledTimes(1);

    const second = await runInterpretation(args, h.deps);
    expect(second.replayed).toBe(true);
    expect(second.record).toEqual(first.record);
    expect(h.runModel).toHaveBeenCalledTimes(1);
    expect(h.state.inserts).toHaveLength(1);
    expect(h.state.audits).toHaveLength(1);
    expect(h.now).toHaveBeenCalledTimes(1);
  });

  it("tamper at acceptance propagates as InterpretationTamperError (model already governed-billed once)", async () => {
    const h = createHarness();
    const original = await runInterpretation(
      { userId: 7, businessId: 7, signal: AMBIGUOUS_SIGNAL },
      h.deps
    );

    const tamperedSignal: CanonicalSocialSignalInput = {
      ...AMBIGUOUS_SIGNAL,
      text: "completely different content with same identity",
    };
    // Pre-seed exactly the tamper scenario: same natural key, different content.
    const signal = sanitizeSignalText(toCanonicalSignal(tamperedSignal));
    const tamperedId = computeInterpretationId({
      schemaVersion: SOCIAL_INTELLIGENCE_SCHEMA_VERSION,
      businessId: 7,
      signalId: signal.signalId,
      signalVersion: signal.signalVersion,
      signalContentHash: computeSignalContentHash(signal),
      classifierVersion: CLASSIFIER,
    });
    expect(tamperedId).not.toBe(original.record.interpretationId);

    await expect(
      runInterpretation({ userId: 7, businessId: 7, signal: tamperedSignal }, h.deps)
    ).rejects.toBeInstanceOf(InterpretationTamperError);
    expect(h.state.rows).toHaveLength(1);
  });

  it("new signalVersion produces a new record", async () => {
    const h = createHarness();
    const v1 = await runInterpretation(
      { userId: 7, businessId: 7, signal: AMBIGUOUS_SIGNAL },
      h.deps
    );
    const v2 = await runInterpretation(
      { userId: 7, businessId: 7, signal: { ...AMBIGUOUS_SIGNAL, signalVersion: 2 } },
      h.deps
    );
    expect(v1.replayed).toBe(false);
    expect(v2.replayed).toBe(false);
    expect(v2.record.interpretationId).not.toBe(v1.record.interpretationId);
    expect(h.state.rows).toHaveLength(2);
  });
});

describe("runInterpretation — audit event shape", () => {
  it("model-path audit metadata carries labels and hashes only", async () => {
    const h = createHarness({ dna: DNA_SNAPSHOT });
    await runInterpretation({ userId: 7, businessId: 7, signal: AMBIGUOUS_SIGNAL }, h.deps);
    const event: any = h.state.audits[0];
    expect(event.eventType).toBe("interpretation_recorded");
    expect(event.metadata.modelOrRuleSource).toBe("MODEL");
    expect(event.metadata.intent).toBe("purchase_interest");
    expect(event.metadata.signalVersion).toBe(1);
    expect(JSON.stringify(event.metadata)).not.toContain("artisan coffee beans");
  });
});

function resultId(h: Harness): string | undefined {
  return (h.state.rows[0]?.record as SocialInterpretation | undefined)?.interpretationId;
}
