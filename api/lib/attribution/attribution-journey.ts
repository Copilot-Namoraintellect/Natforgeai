// ─── R7-B Attribution Intelligence — eligible journey reconstruction ───
//
// PURE module (no I/O, no clock). Deterministic fold over durable upstream
// rows gathered tenant-scoped by attribution-journey-store. Rules (contract
// §5): same tenant (enforced by gathering), same business scope (null-or-equal
// house convention), same canonical lead (lid-keyed sources restricted to the
// score-mediated validated chain), bounded window, authoritative ordering,
// supported types only, dedup by (type, sourceIdentity), no fuzzy matching,
// no cross-lead/cross-business stitching, no inferred events.

import {
  AttributionTouchpointTypeEnum,
  canonicalJson,
  sha256Hex,
  type AttributionExcludedTouchpoint,
  type AttributionTouchpoint,
  type AttributionTouchpointType,
} from "./attribution-contract";
import { deriveTouchpointId } from "./attribution-identity";
import { isWithinWindow, parseTimestampMs, type AttributionWindow } from "./attribution-window";

// ─── Source rows (gathered tenant-scoped; labels/hashes/timestamps only) ───

export interface ConversionProvenanceSource {
  readonly sourceOpportunityId: string | null;
  readonly sourceEngagementReceiptId: string | null;
  readonly sourceSignalId: string | null;
  readonly sourceCampaignId: number | null;
  readonly sourcePublicationId: number | null;
}

export interface IdentityProvenanceSource {
  readonly leadId: string;
  readonly handoffId: string | null;
  readonly opportunityId: string | null;
  readonly campaignId: number | null;
  readonly publicationId: string | null;
  readonly occurredAt: string;
  readonly evidenceHash: string;
}

export interface OpportunitySource {
  readonly opportunityId: string;
  readonly businessId: number | null;
  readonly campaignId: number | null;
  readonly publicationId: string | null;
  readonly firstObservedAt: string;
}

export interface OpportunityEvidenceSource {
  readonly candidateId: number;
  readonly engagementReceiptId: string | null;
  readonly signalId: string;
  readonly occurredAt: string;
  readonly evidenceHash: string;
}

export interface EngagementReceiptSource {
  readonly engagementReceiptId: string;
  readonly businessId: number;
  readonly signalId: string;
  readonly executedAt: string;
}

export interface SignalSource {
  readonly signalKey: string;
  readonly businessId: number | null;
  readonly occurredAt: string;
  readonly sourceCampaignId: number | null;
  readonly sourcePublicationId: string | null;
  readonly attributionType: string;
}

export interface NurtureTouchSource {
  readonly touchIdentity: string;
  readonly leadId: string;
  readonly businessId: number | null;
  readonly touchedAt: string;
}

export interface SalesHandoffSource {
  readonly handoffId: string;
  readonly leadId: string;
  readonly businessId: number | null;
  readonly preparedAt: string;
}

export interface CampaignSource {
  readonly id: number;
  readonly businessId: number | null;
  readonly createdAt: string;
}

export interface PublicationQueueSource {
  readonly id: number;
  readonly publishedAt: string | null;
}

export interface JourneySourceBundle {
  readonly conversionProvenance: ConversionProvenanceSource | null;
  readonly identityProvenance: readonly IdentityProvenanceSource[];
  readonly opportunities: readonly OpportunitySource[];
  readonly opportunityEvidence: readonly OpportunityEvidenceSource[];
  readonly engagementReceipts: readonly EngagementReceiptSource[];
  readonly signals: readonly SignalSource[];
  readonly nurtureTouches: readonly NurtureTouchSource[];
  readonly salesHandoffs: readonly SalesHandoffSource[];
  readonly campaigns: readonly CampaignSource[];
  readonly publicationQueue: readonly PublicationQueueSource[];
}

// ─── Candidate plumbing ───

interface Candidate {
  readonly type: AttributionTouchpointType;
  readonly sourceIdentity: string;
  readonly businessId: number | null;
  readonly leadId: string | null;
  readonly occurredAt: string;
  readonly path: string;
  readonly references: Readonly<Record<string, string | number | null>>;
  readonly sourceMaterial: unknown;
}

function sourceRowHash(material: unknown): string {
  return sha256Hex(canonicalJson({ v: 1, material }));
}

// ─── Publication operationId parsing (frozen receipt format) ───
// publication:<platform>:<queueItemId> — documented in api/lib/publish/
// publication-receipt.ts. Anything else is unresolvable lineage (never
// re-resolved by R7-B; R5-A owns direct publication binding).

export function parsePublicationOperationId(operationId: string): number | null {
  const parts = operationId.split(":");
  if (parts.length !== 3 || parts[0] !== "publication") return null;
  const queueItemId = Number(parts[2]);
  return Number.isInteger(queueItemId) && queueItemId > 0 ? queueItemId : null;
}

// ─── Reconstruction ───

export interface ReconstructJourneyInput {
  readonly outcomeBusinessId: number;
  readonly outcomeOccurredAtMs: number;
  readonly window: AttributionWindow;
  readonly validatedLids: readonly string[];
  readonly leadChainValidated: boolean;
  readonly futureSkewMs: number;
  readonly nowMs: number;
  readonly sources: JourneySourceBundle;
}

export interface ReconstructedJourney {
  readonly eligible: readonly AttributionTouchpoint[];
  readonly excluded: readonly AttributionExcludedTouchpoint[];
}

export function reconstructJourney(input: ReconstructJourneyInput): ReconstructedJourney {
  const lidSet = new Set(input.validatedLids);
  const opportunitiesById = new Map(input.sources.opportunities.map((o) => [o.opportunityId, o]));
  const receiptsById = new Map(
    input.sources.engagementReceipts.map((r) => [r.engagementReceiptId, r])
  );
  const signalsByKey = new Map(input.sources.signals.map((s) => [s.signalKey, s]));
  const campaignsById = new Map(input.sources.campaigns.map((c) => [c.id, c]));
  const queueById = new Map(input.sources.publicationQueue.map((q) => [q.id, q]));

  const candidates: Candidate[] = [];

  const push = (c: Candidate) => {
    if (!AttributionTouchpointTypeEnum.safeParse(c.type).success) {
      // Closed type guard — unsupported types never enter the journey.
      return;
    }
    candidates.push(c);
  };

  // Campaign/publication derivation helpers (reference → derived touchpoint).
  const deriveCampaignCandidate = (
    campaignId: number,
    path: string,
    references: Readonly<Record<string, string | number | null>>
  ) => {
    const campaign = campaignsById.get(campaignId);
    if (!campaign) return; // unresolvable reference — the referencing touchpoint still stands
    push({
      type: "CAMPAIGN",
      sourceIdentity: `campaign:${campaign.id}`,
      businessId: campaign.businessId,
      leadId: null,
      occurredAt: campaign.createdAt,
      path,
      references: { ...references, campaignId: campaign.id },
      sourceMaterial: campaign,
    });
  };

  const derivePublicationCandidate = (
    queueItemId: number,
    path: string,
    references: Readonly<Record<string, string | number | null>>
  ) => {
    const queue = queueById.get(queueItemId);
    if (!queue) return;
    push({
      type: "PUBLICATION",
      sourceIdentity: `publication:${queue.id}`,
      businessId: null, // publishing_queue carries campaign scope, not business
      leadId: null,
      occurredAt: queue.publishedAt ?? "",
      path,
      references: { ...references, queueItemId: queue.id },
      sourceMaterial: queue,
    });
  };

  const deriveSignalCandidates = (signal: SignalSource, path: string) => {
    push({
      type: "ENGAGEMENT",
      sourceIdentity: signal.signalKey,
      businessId: signal.businessId,
      leadId: null,
      occurredAt: signal.occurredAt,
      path,
      references: {
        signalKey: signal.signalKey,
        sourceCampaignId: signal.sourceCampaignId,
        sourcePublicationId: signal.sourcePublicationId,
      },
      sourceMaterial: signal,
    });
    if (signal.attributionType === "direct" && signal.sourceCampaignId !== null) {
      deriveCampaignCandidate(signal.sourceCampaignId, `${path}:campaign_direct`, {
        signalKey: signal.signalKey,
      });
    }
    if (signal.attributionType === "direct" && signal.sourcePublicationId !== null) {
      const queueItemId = parsePublicationOperationId(signal.sourcePublicationId);
      if (queueItemId !== null) {
        derivePublicationCandidate(queueItemId, `${path}:publication_direct`, {
          signalKey: signal.signalKey,
        });
      }
    }
  };

  const deriveOpportunityCandidates = (
    opportunityId: string,
    path: string,
    references: Readonly<Record<string, string | number | null>>
  ) => {
    const opportunity = opportunitiesById.get(opportunityId);
    if (!opportunity) return;
    push({
      type: "OPPORTUNITY",
      sourceIdentity: opportunity.opportunityId,
      businessId: opportunity.businessId,
      leadId: null,
      occurredAt: opportunity.firstObservedAt,
      path,
      references: { ...references, opportunityId: opportunity.opportunityId },
      sourceMaterial: opportunity,
    });
    if (opportunity.campaignId !== null) {
      deriveCampaignCandidate(opportunity.campaignId, `${path}:campaign_reference`, {
        opportunityId: opportunity.opportunityId,
      });
    }
    if (opportunity.publicationId !== null) {
      // Fragmented varchar publication identity — never re-resolved (G2).
      push({
        type: "PUBLICATION",
        sourceIdentity: `unresolved:${opportunity.publicationId}`,
        businessId: opportunity.businessId,
        leadId: null,
        occurredAt: opportunity.firstObservedAt,
        path: `${path}:publication_reference`,
        references: { ...references, opportunityId: opportunity.opportunityId },
        sourceMaterial: { unresolvedPublicationId: opportunity.publicationId },
      });
    }
  };

  // 1) Lead-lineage sources (only meaningful when the chain validated them).
  for (const prov of input.sources.identityProvenance) {
    if (prov.opportunityId !== null) {
      deriveOpportunityCandidates(prov.opportunityId, "lead_identity_provenance", {
        leadId: prov.leadId,
        handoffId: prov.handoffId,
      });
    }
  }

  for (const touch of input.sources.nurtureTouches) {
    push({
      type: "NURTURE_TOUCH",
      sourceIdentity: touch.touchIdentity,
      businessId: touch.businessId,
      leadId: touch.leadId,
      occurredAt: touch.touchedAt,
      path: "nurture_touch_records",
      references: { touchIdentity: touch.touchIdentity, leadId: touch.leadId },
      sourceMaterial: touch,
    });
  }

  for (const handoff of input.sources.salesHandoffs) {
    push({
      type: "SALES_HANDOFF",
      sourceIdentity: handoff.handoffId,
      businessId: handoff.businessId,
      leadId: handoff.leadId,
      occurredAt: handoff.preparedAt,
      path: "sales_handoffs",
      references: { handoffId: handoff.handoffId, leadId: handoff.leadId },
      sourceMaterial: handoff,
    });
  }

  // Opportunity evidence: engagement receipts + signal interpretations.
  for (const ev of input.sources.opportunityEvidence) {
    if (ev.engagementReceiptId !== null) {
      const receipt = receiptsById.get(ev.engagementReceiptId);
      if (receipt) {
        push({
          type: "ENGAGEMENT",
          sourceIdentity: receipt.engagementReceiptId,
          businessId: receipt.businessId,
          leadId: null,
          occurredAt: receipt.executedAt,
          path: "opportunity_engagement_receipt",
          references: { engagementReceiptId: receipt.engagementReceiptId, signalId: receipt.signalId },
          sourceMaterial: receipt,
        });
      }
    }
    const signal = signalsByKey.get(ev.signalId);
    if (signal) {
      deriveSignalCandidates(signal, "signal_interpretation");
    }
  }

  // 2) Outcome-level provenance (the outcome's own conversion lineage).
  const conv = input.sources.conversionProvenance;
  if (conv) {
    if (conv.sourceOpportunityId !== null) {
      deriveOpportunityCandidates(conv.sourceOpportunityId, "conversion_provenance", {
        conversionProvenance: "sourceOpportunityId",
      });
    }
    if (conv.sourceEngagementReceiptId !== null) {
      const receipt = receiptsById.get(conv.sourceEngagementReceiptId);
      if (receipt) {
        push({
          type: "ENGAGEMENT",
          sourceIdentity: receipt.engagementReceiptId,
          businessId: receipt.businessId,
          leadId: null,
          occurredAt: receipt.executedAt,
          path: "conversion_provenance",
          references: { engagementReceiptId: receipt.engagementReceiptId },
          sourceMaterial: receipt,
        });
      }
    }
    if (conv.sourceSignalId !== null) {
      const signal = signalsByKey.get(conv.sourceSignalId);
      if (signal) deriveSignalCandidates(signal, "conversion_provenance");
    }
    if (conv.sourceCampaignId !== null) {
      deriveCampaignCandidate(conv.sourceCampaignId, "conversion_provenance", {
        conversionProvenance: "sourceCampaignId",
      });
    }
    if (conv.sourcePublicationId !== null) {
      derivePublicationCandidate(conv.sourcePublicationId, "conversion_provenance", {
        conversionProvenance: "sourcePublicationId",
      });
    }
  }

  // ─── Eligibility pipeline (fixed check order; first failure wins) ───

  const excluded: AttributionExcludedTouchpoint[] = [];
  const survivors: Candidate[] = [];

  const exclude = (
    c: Candidate,
    reason: AttributionExcludedTouchpoint["reason"],
    occurredAt: string | null
  ) => {
    excluded.push({
      touchpointId: deriveTouchpointId(c.type, c.sourceIdentity),
      type: c.type,
      sourceIdentity: c.sourceIdentity,
      businessId: c.businessId,
      occurredAt,
      provenance: {
        path: c.path,
        references: c.references,
        sourceRowHash: sourceRowHash(c.sourceMaterial),
      },
      eligibility: "excluded",
      reason,
    });
  };

  for (const c of candidates) {
    if (c.leadId !== null && !lidSet.has(c.leadId)) {
      exclude(c, "TOUCHPOINT_LEAD_MISMATCH", c.occurredAt);
      continue;
    }
    if (c.businessId !== null && c.businessId !== input.outcomeBusinessId) {
      exclude(c, "TOUCHPOINT_BUSINESS_MISMATCH", c.occurredAt);
      continue;
    }
    const occurredMs = parseTimestampMs(c.occurredAt);
    if (occurredMs === null) {
      exclude(c, "TOUCHPOINT_TIMESTAMP_INVALID", null);
      continue;
    }
    if (occurredMs - input.nowMs > input.futureSkewMs) {
      exclude(c, "TOUCHPOINT_FUTURE_DATED", c.occurredAt);
      continue;
    }
    if (occurredMs > input.outcomeOccurredAtMs) {
      exclude(c, "TOUCHPOINT_AFTER_OUTCOME", c.occurredAt);
      continue;
    }
    if (!isWithinWindow(occurredMs, input.window)) {
      exclude(c, "TOUCHPOINT_OUTSIDE_WINDOW", c.occurredAt);
      continue;
    }
    survivors.push(c);
  }

  // Unresolvable publication lineage (empty occurredAt sentinel set above).
  for (let i = excluded.length - 1; i >= 0; i--) {
    const e = excluded[i];
    if (e.type === "PUBLICATION" && e.sourceIdentity.startsWith("unresolved:") && e.reason === "TOUCHPOINT_TIMESTAMP_INVALID") {
      excluded[i] = { ...e, reason: "TOUCHPOINT_UNRESOLVED_LINEAGE" };
    }
  }
  // PUBLICATION candidates with empty occurredAt (unpublished queue rows).
  for (let i = 0; i < survivors.length; i++) {
    const c = survivors[i];
    if (c.type === "PUBLICATION" && c.occurredAt === "") {
      exclude(c, "TOUCHPOINT_UNRESOLVED_LINEAGE", null);
      survivors.splice(i, 1);
      i--;
    }
  }

  // ─── Deduplicate by (type, sourceIdentity); first chronological wins ───
  const byKey = new Map<string, Candidate>();
  const deduped: Candidate[] = [];
  const ordered = [...survivors].sort((a, b) => {
    const aMs = parseTimestampMs(a.occurredAt) ?? 0;
    const bMs = parseTimestampMs(b.occurredAt) ?? 0;
    if (aMs !== bMs) return aMs - bMs;
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    return a.sourceIdentity < b.sourceIdentity ? -1 : 1;
  });
  for (const c of ordered) {
    const key = `${c.type}:${c.sourceIdentity}`;
    const existing = byKey.get(key);
    if (existing) {
      exclude(c, "TOUCHPOINT_DUPLICATE", c.occurredAt);
      continue;
    }
    byKey.set(key, c);
    deduped.push(c);
  }

  const eligible: AttributionTouchpoint[] = deduped.map((c) => ({
    touchpointId: deriveTouchpointId(c.type, c.sourceIdentity),
    type: c.type,
    sourceIdentity: c.sourceIdentity,
    businessId: c.businessId,
    occurredAt: c.occurredAt,
    provenance: {
      path: c.path,
      references: c.references,
      sourceRowHash: sourceRowHash(c.sourceMaterial),
    },
    eligibility: "eligible",
    creditBps: 0,
  }));

  return { eligible, excluded };
}
