import {
  compileApprovedCreativeContract,
  getQualityAuthorityMode,
  isApprovedLineageAuthoritative,
  type ObservationDiagnostics,
} from "./creative-contract";
import {
  observeRenderedQualityIfEnabled,
  type QualityAuthorityObservationInput,
  type RenderedQualityAuthorityObservationInput,
} from "./observe-quality-authority";
import {
  buildCandidateContentFingerprint,
  buildCandidateId,
  type CandidateSpecification,
} from "../quality/candidate-selection";
import { compileDirectionPlans } from "../quality/creative-direction-planner";
import { InMemoryRenderedEvidenceRegistry } from "../quality/rendered-evidence-registry";
import { isTrustedRenderedCreativeEvidence } from "../quality/rendered-creative-evaluator";
import type { RenderedCreativeEvidence } from "../quality/premium-rubric";
import type { InMemoryWorkflowOperationRegistry } from "../../workflow/workflow-operation";

/**
 * Opaque, request-owned observation capability. It is runtime-unforgeable: only
 * scope objects issued by `createRenderedQualityObservationScope` are accepted by
 * `registerRenderedQualityEvidence`/`observeRenderedQualityScope` (module WeakSet).
 * Never serialize, clone, or persist this value; the exact in-process object
 * identity is the authorization mechanism.
 */
export type RenderedQualityObservationScope = object;

/**
 * Workflow authority owned by the existing Slice 3-4 request orchestration
 * owner. The scope reuses this exact registry and already-running operation;
 * it never creates, registers, transitions, or finalizes workflow operations.
 */
export interface RenderedQualityObservationAuthority {
  registry: InMemoryWorkflowOperationRegistry;
  workflowOperationId: string;
}

export interface RenderedQualityObservationScopeInput extends QualityAuthorityObservationInput {
  /** Exact request-scoped workflow registry owned by the orchestration owner. */
  registry?: InMemoryWorkflowOperationRegistry | null;
  /** Existing running workflowOperationId owned by the orchestration owner. */
  workflowOperationId?: string | null;
  /** Request-scoped in-memory rendered-evidence registry. */
  renderedEvidenceRegistry?: InMemoryRenderedEvidenceRegistry | null;
}

export type RenderedQualityObservationRegistration =
  | { status: "registered" | "idempotent_replay"; renderedAssetFingerprint: string }
  | { status: "not_requested" | "rejected_untrusted" | "rejected_identity_mismatch" | "rejected_conflicting_duplicate" };

interface ScopeState {
  readonly observationInput: Omit<RenderedQualityAuthorityObservationInput, "renderedCandidateEvidenceEntries">;
  readonly candidate: CandidateSpecification;
  readonly workflowOperationId: string;
  readonly contractFingerprint: string;
  renderedAssetFingerprint: string | null;
}

const issuedScopes = new WeakSet<object>();
const scopeState = new WeakMap<object, ScopeState>();

function isScope(scope: unknown): scope is object {
  return !!scope && typeof scope === "object" && issuedScopes.has(scope as object);
}

/**
 * Creates an unforgeable, request-owned observation capability. Its identity is
 * compiled from the same approved authority state consumed by the observer.
 *
 * Workflow authority is supplied, never manufactured: the exact registry and
 * the already-running workflowOperationId must come from the existing Slice 3-4
 * request orchestration owner. Any missing, unknown, or non-running operation
 * fails closed (null) — no substitute registry or operation is ever created.
 */
export function createRenderedQualityObservationScope(
  input: RenderedQualityObservationScopeInput
): RenderedQualityObservationScope | null {
  if (getQualityAuthorityMode().effectiveMode !== "observe") return null;

  const registry = input.registry ?? null;
  const workflowOperationId =
    typeof input.workflowOperationId === "string" ? input.workflowOperationId.trim() : "";
  const renderedEvidenceRegistry = input.renderedEvidenceRegistry ?? null;
  if (!registry || !renderedEvidenceRegistry || workflowOperationId.length === 0) {
    return null;
  }
  const operation = registry.findOperation(workflowOperationId);
  if (!operation || operation.status !== "running") {
    return null;
  }

  const expectedFingerprint =
    input.expectedApprovedStrategyFingerprint ?? input.lineage?.approvedStrategyFingerprint ?? null;
  if (!isApprovedLineageAuthoritative(input.lineage, input.campaignId, input.userId, expectedFingerprint) || !input.lineage || !input.proposedContent) {
    return null;
  }

  try {
    const contract = compileApprovedCreativeContract({
      campaignId: input.lineage.campaignId,
      userId: input.lineage.userId,
      businessId: input.businessId,
      businessName: input.businessName ?? null,
      strategyRunId: input.lineage.strategyRunId,
      approvalRequestId: input.lineage.approvalRequestId,
      approvedAt: input.lineage.approvedAt,
      approvedStrategyFingerprint: input.lineage.approvedStrategyFingerprint,
      funnelStage: input.funnelStage,
      stageCtas: input.stageCtas,
      campaignWideCta: input.campaignWideCta,
      campaignInputCta: input.campaignInputCta,
      offerActionCta: input.offerActionCta,
      aiDelegated: input.aiDelegated,
      targetAudience: input.targetAudience,
      offer: input.offer,
      offerRequired: input.offerRequired,
      businessCapabilities: input.businessCapabilities,
      requiredBenefitCount: input.requiredBenefitCount,
      brandConstraints: input.brandConstraints,
      requiredContactDetails: input.requiredContactDetails,
      prohibitedClaims: input.prohibitedClaims,
    });
    const direction = compileDirectionPlans({ workflowOperationId, contract }).directions.find((item) => item.available);
    if (!direction) return null;

    const candidate: CandidateSpecification = {
      candidateId: buildCandidateId({
        workflowOperationId,
        contractFingerprint: contract.contractFingerprint,
        directionFingerprint: direction.directionFingerprint,
        candidateOrdinal: 1,
        contentFingerprint: buildCandidateContentFingerprint(input.proposedContent),
      }),
      candidateOrdinal: 1,
      candidate: input.proposedContent,
      directionKey: direction.directionKey,
    };
    const observationInput: Omit<RenderedQualityAuthorityObservationInput, "renderedCandidateEvidenceEntries"> = {
      ...input,
      registry,
      renderedEvidenceRegistry,
      candidateEntries: [candidate],
    };
    const scope = Object.freeze({});
    issuedScopes.add(scope);
    scopeState.set(scope, {
      observationInput,
      candidate,
      workflowOperationId,
      contractFingerprint: contract.contractFingerprint,
      renderedAssetFingerprint: null,
    });
    return scope;
  } catch {
    return null;
  }
}

/** Registers only exact evaluator-issued evidence under scope-derived keys. */
export function registerRenderedQualityEvidence(
  scope: unknown,
  evidence: unknown
): RenderedQualityObservationRegistration {
  if (!isScope(scope)) return { status: "not_requested" };
  if (!isTrustedRenderedCreativeEvidence(evidence)) return { status: "rejected_untrusted" };

  const state = scopeState.get(scope)!;
  const result = state.observationInput.renderedEvidenceRegistry.register(
    {
      workflowOperationId: state.workflowOperationId,
      contractFingerprint: state.contractFingerprint,
      candidateId: state.candidate.candidateId,
      renderedAssetFingerprint: evidence.renderedAssetFingerprint,
    },
    evidence as RenderedCreativeEvidence
  );
  if (result.evidence) {
    state.renderedAssetFingerprint = result.evidence.renderedAssetFingerprint;
    return {
      status: result.status === "idempotent_replay" ? "idempotent_replay" : "registered",
      renderedAssetFingerprint: result.evidence.renderedAssetFingerprint,
    };
  }
  switch (result.status) {
    case "rejected_identity_mismatch":
      return { status: "rejected_identity_mismatch" };
    case "rejected_conflicting_duplicate":
      return { status: "rejected_conflicting_duplicate" };
    default:
      return { status: "rejected_untrusted" };
  }
}

/** Runs the existing observer using only the state held by an issued scope. */
export function observeRenderedQualityScope(scope: unknown): ObservationDiagnostics | null {
  if (!isScope(scope)) return null;
  const state = scopeState.get(scope)!;
  return observeRenderedQualityIfEnabled("premium V2 rendered quality observation", {
    ...state.observationInput,
    renderedCandidateEvidenceEntries: state.renderedAssetFingerprint
      ? [{ candidateId: state.candidate.candidateId, renderedAssetFingerprint: state.renderedAssetFingerprint }]
      : [],
  });
}