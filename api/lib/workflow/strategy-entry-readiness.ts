import {
  buildBusinessDNASnapshot,
  type BusinessProfileSnapshotSource,
} from "../business-dna";
import { evaluateBusinessDnaReadiness } from "../business-dna-governance";

/**
 * Shared Strategy-entry Business DNA readiness gate (WBS-R4 A1-1).
 *
 * Pure/evaluative only: no database writes, no clock, no strategy-agent
 * imports. The readiness projection is built exactly the way governed
 * materialization will build it — the same canonical Business DNA snapshot
 * derived from the owned business row and its captured websiteEvidence (see
 * materializeGovernedBusinessDna's identity probe) — so the entry decision and
 * the materialization decision can never disagree. Readiness is evaluated
 * against the governed minimum only; optional style/profile fields never
 * gate.
 */

export type StrategyEntryBusinessDnaReadiness =
  | { readonly ready: true }
  | {
      readonly ready: false;
      readonly code: "BUSINESS_DNA_READINESS_FAILED";
      readonly gate: "business_dna";
      readonly missing: readonly string[];
      readonly userMessage: string;
      readonly action: { readonly path: string; readonly label: string };
    };

/**
 * Fixed identity anchor, mirroring the governance identity probe: snapshot
 * identity is evidence-derived and never depends on wall-clock time, so the
 * gate itself holds no time authority.
 */
const STRATEGY_ENTRY_PROBE_CAPTURED_AT_ISO = new Date(0).toISOString();

const STRATEGY_ENTRY_ACTION = {
  path: "/settings?tab=businesses",
  label: "Complete business profile",
} as const;

const MISSING_FIELD_LABELS: Record<string, string> = {
  businessId: "a valid linked business",
  businessName: "the business name",
  primaryOffering: "the primary product or service",
  productsAndServices: "at least one product or service",
  targetCustomerSegments: "at least one target customer segment",
};

function describeMissingField(field: string): string {
  return MISSING_FIELD_LABELS[field] ?? field;
}

/**
 * Evaluates whether the business profile linked to a campaign is ready for
 * governed Strategy generation. `campaign` is carried as caller context (the
 * projection intentionally mirrors materialization, which derives readiness
 * from the business row alone); `business` must be the owned business row
 * including its captured websiteEvidence.
 */
export function evaluateStrategyEntryBusinessDnaReadiness(input: {
  campaign?: unknown;
  business: unknown;
}): StrategyEntryBusinessDnaReadiness {
  const snapshot = buildBusinessDNASnapshot({
    business: (input.business ?? {}) as BusinessProfileSnapshotSource,
    capturedAtIso: STRATEGY_ENTRY_PROBE_CAPTURED_AT_ISO,
  });

  const readiness = evaluateBusinessDnaReadiness(snapshot);
  if (readiness.ready) {
    return { ready: true };
  }

  const described = readiness.missing.map(describeMissingField);
  const userMessage =
    described.length === 1
      ? `Your business profile is missing ${described[0]}. Run website analysis or complete the profile in Settings → Businesses, then retry strategy generation.`
      : `Your business profile is missing ${described
          .slice(0, -1)
          .join(", ")} and ${described[described.length - 1]}. Run website analysis or complete the profile in Settings → Businesses, then retry strategy generation.`;

  return {
    ready: false,
    code: "BUSINESS_DNA_READINESS_FAILED",
    gate: "business_dna",
    missing: readiness.missing,
    userMessage,
    action: STRATEGY_ENTRY_ACTION,
  };
}
