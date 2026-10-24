// ─── R5-B Intent & Sentiment Intelligence — orchestration (§5, §9, §11, §12) ───
//
// Interpretation orchestrator: route → interpret → normalize → persist →
// audit. One call produces exactly one accepted durable interpretation per
// signal version + classifier (contract §5): idempotent replays return the
// committed row with no model call, no billing and no second audit event.
// Rules path is deterministic and non-billable; the model path is a single
// governed runAgent call billed at most once per logical interpretation
// version. No logging, no PII, no hidden clocks — the single time read at the
// persistence boundary is caller-supplied.

import type { BusinessDNASnapshot } from "../business-dna";
import { createAuditEvent } from "../audit/audit-event";
import {
  CLASSIFIER_VERSION,
  InterpretationInputError,
  SOCIAL_INTELLIGENCE_SCHEMA_VERSION,
  UnsupportedSignalTypeError,
  assertValidInterpretationRecord,
  type ConfidenceLabel,
  type EvidenceReference,
  type HandlingClass,
  type IntentLabel,
  type ModelInterpretation,
  type OpportunityEntry,
  type RelevanceLabel,
  type RiskFlagEntry,
  type SentimentLabel,
  type SocialInterpretation,
  type UrgencyLabel,
} from "./interpretation-contract";
import type { CanonicalSocialSignalInput } from "./canonical-signal";
import { toCanonicalSignal } from "./canonical-signal";
import { excerptOf, sanitizeSignalText } from "./input-safety";
import {
  buildInterpretationBillingIdentity,
  computeInterpretationFingerprint,
  computeInterpretationId,
  computeSignalContentHash,
} from "./interpretation-identity";
import { evaluateRules } from "./rules-engine";
import { interpretWithModel } from "./model-boundary";
import {
  combineOverallConfidence,
  gateHandling,
  mapModelConfidence,
} from "./confidence";
import {
  classifyRisks,
  deriveOpportunityIndicators,
  resolveRecommendedHandling,
} from "./risk-classifier";
import { assessRelevanceWithContext, assessRelevanceWithoutContext } from "./relevance";
import {
  acceptInterpretation,
  getInterpretationById,
  type InterpretationDbExecutor,
} from "./interpretation-store";

/**
 * In-flight evaluation registry: concurrent duplicates of the same
 * interpretation identity in one process collapse onto ONE evaluation
 * promise (the caller-stable billing identity means a second concurrent
 * evaluation would double-bill). Sync Map get/set is atomic under the JS
 * event loop: two concurrent callers cannot both win registration.
 */
export interface InFlightInterpretationRegistry {
  lookup(id: string): Promise<RunInterpretationResult> | undefined;
  register(id: string, p: Promise<RunInterpretationResult>): Promise<RunInterpretationResult>;
  forget(id: string): void;
}

/**
 * Process-local in-flight registry with FIFO eviction at a fixed cap. A
 * registered entry is the single shared evaluation promise; forget() runs in
 * a finally so a rejected evaluation still clears the slot and a later call
 * can retry. Entries are transient coordination only — the durable authority
 * for replay remains the store.
 */
export class InMemoryInterpretationRegistry implements InFlightInterpretationRegistry {
  private readonly entries = new Map<string, Promise<RunInterpretationResult>>();
  private readonly maxEntries: number;

  constructor(maxEntries = 1000) {
    this.maxEntries = maxEntries;
  }

  lookup(id: string): Promise<RunInterpretationResult> | undefined {
    return this.entries.get(id);
  }

  register(id: string, p: Promise<RunInterpretationResult>): Promise<RunInterpretationResult> {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(id, p);
    return p;
  }

  forget(id: string): void {
    this.entries.delete(id);
  }
}

/** Shared default registry; tests may inject their own (e.g. fresh instance). */
const sharedInFlightRegistry = new InMemoryInterpretationRegistry();

/** Injectable seams: defaults hit the real store/model; tests substitute fakes. */
export interface InterpretationDeps {
  /** Owner-scoped Business DNA snapshot; null/absent = context-free (§9).
   * Only invoked when args.businessId is non-null (unattributed signals skip
   * DNA context entirely). */
  readonly loadOwnedBusinessDnaSnapshot?: (args: {
    userId: number;
    businessId: number;
  }) => Promise<BusinessDNASnapshot | null>;
  /** Governed model call; defaults to interpretWithModel. */
  readonly runModel?: (
    args: Parameters<typeof interpretWithModel>[0]
  ) => Promise<ModelInterpretation>;
  /** Audit sink; when absent, no audit is emitted (router wires the real one). */
  readonly persistAudit?: (event: unknown) => Promise<void>;
  /** Single clock read at the persistence boundary; defaults to new Date(). */
  readonly now?: () => Date;
  /** Store executor seam (fake in tests). */
  readonly executor?: InterpretationDbExecutor;
  /** In-flight collapse seam; defaults to the module-level shared registry. */
  readonly registry?: InFlightInterpretationRegistry;
}

export interface RunInterpretationArgs {
  readonly userId: number;
  readonly businessId: number | null;
  readonly signal: CanonicalSocialSignalInput;
  readonly campaignId?: number;
}

export interface RunInterpretationResult {
  readonly record: SocialInterpretation;
  readonly replayed: boolean;
}

function normalizeTopics(topics: readonly string[]): string[] {
  const normalized: string[] = [];
  for (const raw of topics) {
    let topic = raw.trim().toLowerCase();
    if (topic.length > 48) {
      topic = topic.slice(0, 48);
      // Never leave a split surrogate pair at the cut boundary.
      if (/[\uD800-\uDFFF]/.test(topic.charAt(topic.length - 1))) {
        topic = topic.slice(0, -1);
      }
    }
    if (topic && !normalized.includes(topic)) normalized.push(topic);
    if (normalized.length >= 5) break;
  }
  return normalized;
}

/**
 * Sanitized audit metadata carries ids, labels and hashes only — never
 * social text (contract §15, SENSITIVE_METADATA_KEY hygiene).
 */
function buildInterpretationAuditEvent(record: SocialInterpretation) {
  return createAuditEvent({
    eventType: "interpretation_recorded",
    occurredAt: record.createdAt,
    userId: record.userId,
    source: "workflow",
    outcome: "succeeded",
    businessId: record.businessId,
    metadata: {
      interpretationId: record.interpretationId,
      signalId: record.signalId,
      signalVersion: record.signalVersion,
      classifierVersion: record.classifierVersion,
      businessId: record.businessId,
      modelOrRuleSource: record.source,
      intent: record.intent,
      sentiment: record.sentiment,
      urgency: record.urgency,
      relevance: record.relevance,
      overallConfidence: record.overallConfidence,
      recommendedHandling: record.recommendedHandling,
    },
  });
}

interface RecordBody {
  readonly source: "RULE" | "MODEL";
  readonly intent: IntentLabel;
  readonly intentConfidence: ConfidenceLabel;
  readonly sentiment: SentimentLabel;
  readonly sentimentConfidence: ConfidenceLabel;
  readonly urgency: UrgencyLabel;
  readonly relevance: RelevanceLabel;
  readonly relevanceConfidence: ConfidenceLabel;
  readonly overallConfidence: ConfidenceLabel;
  readonly confidenceBasis: SocialInterpretation["confidenceBasis"];
  readonly topics: readonly string[];
  readonly riskFlags: readonly RiskFlagEntry[];
  readonly opportunityIndicators: readonly OpportunityEntry[];
  readonly recommendedHandling: HandlingClass;
  readonly businessDnaSnapshotId: string | null;
  readonly evidenceReferences: SocialInterpretation["evidenceReferences"];
  readonly explanation: string;
  readonly billingIdentity: string | null;
}

/**
 * Assemble, validate and durably accept the canonical record. The clock is
 * read exactly once per accepted record; the audit event fires exactly once
 * per new durable row.
 */
async function finalizeAndAccept(
  identity: {
    readonly userId: number;
    readonly businessId: number | null;
    readonly signalId: string;
    readonly signalVersion: number;
    readonly signalContentHash: string;
    readonly signalType: SocialInterpretation["signalType"];
    readonly interpretationId: string;
  },
  body: RecordBody,
  deps: InterpretationDeps
): Promise<RunInterpretationResult> {
  const now = deps.now ?? (() => new Date());
  const createdAt = now().toISOString();

  const candidate = {
    interpretationId: identity.interpretationId,
    schemaVersion: SOCIAL_INTELLIGENCE_SCHEMA_VERSION,
    classifierVersion: CLASSIFIER_VERSION,
    userId: identity.userId,
    businessId: identity.businessId,
    signalId: identity.signalId,
    signalVersion: identity.signalVersion,
    signalContentHash: identity.signalContentHash,
    signalType: identity.signalType,
    ...body,
    interpretationFingerprint: "",
    createdAt,
    status: "accepted" as const,
  };
  candidate.interpretationFingerprint = computeInterpretationFingerprint(
    candidate as unknown as SocialInterpretation
  );
  const record = assertValidInterpretationRecord(candidate);

  const accepted = await acceptInterpretation(record, deps.executor);
  if (!accepted.replayed && deps.persistAudit) {
    await deps.persistAudit(buildInterpretationAuditEvent(accepted.record));
  }
  return { record: accepted.record, replayed: accepted.replayed };
}

/**
 * Interpret one canonical social signal for one business. Replay-safe,
 * fail-closed, single-authority per evaluation (contract §12): exactly one
 * of the rules path or the model path writes the record. Concurrent
 * duplicates collapse onto one in-flight evaluation; a failed evaluation
 * rejects its waiters and clears the slot so a later call can retry.
 */
export async function runInterpretation(
  args: RunInterpretationArgs,
  deps: InterpretationDeps = {}
): Promise<RunInterpretationResult> {
  // a. Canonical identity derivation (server-side; clients supply none of it).
  const canonical = toCanonicalSignal(args.signal);
  const signal = sanitizeSignalText(canonical);
  const signalContentHash = computeSignalContentHash(signal);
  const interpretationId = computeInterpretationId({
    schemaVersion: SOCIAL_INTELLIGENCE_SCHEMA_VERSION,
    businessId: args.businessId,
    signalId: signal.signalId,
    signalVersion: signal.signalVersion,
    signalContentHash,
    classifierVersion: CLASSIFIER_VERSION,
  });

  // b. Replay short-circuit: existing row → no model call, no billing, no audit.
  const existing = await getInterpretationById(interpretationId, deps.executor);
  if (existing) {
    return { record: assertValidInterpretationRecord(existing.record), replayed: true };
  }

  // In-flight collapse: lookup→register has no await between, so concurrent
  // duplicates in this process share exactly one evaluation promise.
  const registry = deps.registry ?? sharedInFlightRegistry;
  const inflight = registry.lookup(interpretationId);
  if (inflight) return inflight;

  const evaluation = evaluateAndAccept(args, deps, {
    signal,
    signalContentHash,
    interpretationId,
  }).finally(() => registry.forget(interpretationId));
  return registry.register(interpretationId, evaluation);
}

/**
 * Single-evaluation body: rule-first routing, governed model path,
 * normalization and durable acceptance. Never called concurrently for the
 * same interpretationId within one process (registry).
 */
async function evaluateAndAccept(
  args: RunInterpretationArgs,
  deps: InterpretationDeps,
  ctx: {
    readonly signal: ReturnType<typeof sanitizeSignalText>;
    readonly signalContentHash: string;
    readonly interpretationId: string;
  }
): Promise<RunInterpretationResult> {
  const { signal, signalContentHash, interpretationId } = ctx;
  const billingIdentity = buildInterpretationBillingIdentity({
    businessId: args.businessId,
    signalId: signal.signalId,
    signalVersion: signal.signalVersion,
    signalContentHash,
    classifierVersion: CLASSIFIER_VERSION,
  });

  const identity = {
    userId: args.userId,
    businessId: args.businessId,
    signalId: signal.signalId,
    signalVersion: signal.signalVersion,
    signalContentHash,
    signalType: signal.signalType,
    interpretationId,
  };

  // c./d. Rule-first routing (contract §12).
  const verdict = evaluateRules(signal);
  if (verdict.kind === "reject") {
    if (verdict.reason === "unsupported_signal_type") {
      throw new UnsupportedSignalTypeError(
        "UNSUPPORTED_SIGNAL_TYPE",
        `signalType for signal "${signal.signalId}" is outside the closed canonical vocabulary; rejected before any processing.`
      );
    }
    throw new InterpretationInputError(
      "INVALID_SIGNAL_INPUT",
      `signal "${signal.signalId}" failed pre-interpretation validation; rejected before any processing.`
    );
  }

  if (verdict.kind === "definitive") {
    return finalizeAndAccept(
      identity,
      {
        source: "RULE",
        intent: verdict.intent,
        intentConfidence: verdict.intentConfidence,
        sentiment: verdict.sentiment,
        sentimentConfidence: verdict.sentimentConfidence,
        urgency: verdict.urgency,
        relevance: verdict.relevance,
        relevanceConfidence: verdict.relevanceConfidence,
        overallConfidence: verdict.overallConfidence,
        confidenceBasis: verdict.confidenceBasis,
        topics: verdict.topics,
        riskFlags: verdict.riskFlags,
        opportunityIndicators: verdict.opportunityIndicators,
        recommendedHandling: verdict.recommendedHandling,
        businessDnaSnapshotId: null,
        evidenceReferences: verdict.evidenceReferences,
        explanation: verdict.explanation,
        billingIdentity: null,
      },
      deps
    );
  }

  // e. Governed model path. Unattributed (businessId null) evaluations never
  // fetch DNA context (contract §9): relevance stays context-free.
  const dna =
    args.businessId !== null && deps.loadOwnedBusinessDnaSnapshot
      ? await deps.loadOwnedBusinessDnaSnapshot({
          userId: args.userId,
          businessId: args.businessId,
        })
      : null;
  const dnaContext = dna
    ? {
        businessName: dna.businessName,
        primaryOffering: dna.primaryOffering,
        productsAndServices: dna.productsAndServices,
      }
    : null;

  const runModel =
    deps.runModel ?? ((modelArgs) => interpretWithModel(modelArgs).then((r) => r.model));
  const model = await runModel({
    userId: args.userId,
    businessId: args.businessId,
    signal,
    dnaContext,
    billingIdentity,
    campaignId: args.campaignId,
  });

  const intent = model.intent;
  const sentiment = model.sentiment;
  const urgency = model.urgency;
  const intentConfidence = mapModelConfidence(model.modelConfidence);
  const sentimentConfidence = mapModelConfidence(model.modelConfidence);

  const riskFlags = classifyRisks({
    text: signal.contentText,
    intent,
    sentiment,
    urgency,
    modelRiskHints: model.riskHints,
  }).riskFlags;

  // Deterministic Business DNA relevance wins when a snapshot exists (§9);
  // otherwise the validated model hint bounds an honest context-free result.
  const assessment = dna
    ? assessRelevanceWithContext(signal.contentText, dna)
    : assessRelevanceWithoutContext(model.relevanceHint);
  const relevance = assessment.relevance;
  const relevanceConfidence = assessment.relevanceConfidence;

  const opportunityIndicators = deriveOpportunityIndicators({
    intent,
    sentiment,
    relevance,
    opportunityHints: model.opportunityHints,
  });

  const overallConfidence = combineOverallConfidence({
    intentConfidence,
    sentimentConfidence,
    relevanceConfidence,
  });
  const desiredHandling = resolveRecommendedHandling({
    riskFlags,
    overallConfidence,
    intent,
    relevance,
    opportunityIndicators,
  });
  const recommendedHandling = gateHandling(overallConfidence, desiredHandling);

  const evidenceReferences: EvidenceReference[] = [];
  if (signal.contentText.trim().length > 0) {
    evidenceReferences.push({
      kind: "signal_excerpt",
      ref: signal.signalId,
      excerpt: excerptOf(signal.contentText, 160),
    });
  }
  if (assessment.evidence) evidenceReferences.push(assessment.evidence);
  if (model.evidence.length > 0) {
    evidenceReferences.push({
      kind: "model",
      ref: "interpretation-model",
      excerpt: excerptOf(model.evidence[0], 160),
    });
  }

  return finalizeAndAccept(
    identity,
    {
      source: "MODEL",
      intent,
      intentConfidence,
      sentiment,
      sentimentConfidence,
      urgency,
      relevance,
      relevanceConfidence,
      overallConfidence,
      confidenceBasis: "model_self_assessed",
      topics: normalizeTopics(model.topics),
      riskFlags,
      opportunityIndicators,
      recommendedHandling,
      businessDnaSnapshotId: dna?.snapshotId ?? null,
      evidenceReferences,
      explanation: model.explanation,
      billingIdentity,
    },
    deps
  );
}
