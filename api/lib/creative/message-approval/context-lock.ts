import type { MessageApprovalContextLock } from "./contracts";
import { DEFAULT_V2_MESSAGE_QUALITY_POLICY } from "./policy";
import {
  buildLegacyShadowContextProjection,
  type LegacyLoadedShadowContextInput,
} from "./integration/legacy-shadow-context";
import type { InMemoryWorkflowOperationRegistry } from "../../workflow/workflow-operation";

export interface BuildMessageApprovalContextLockInput {
  readonly mode: "shadow" | "canary";
  readonly campaignId: number;
  readonly loadedContext: LegacyLoadedShadowContextInput;
  readonly traceNonce?: string;
  readonly registry?: InMemoryWorkflowOperationRegistry;
}

export function buildMessageApprovalContextLock(
  input: BuildMessageApprovalContextLockInput
): MessageApprovalContextLock {
  const projection = buildLegacyShadowContextProjection({
    ...input.loadedContext,
    registry: input.registry ?? input.loadedContext.registry ?? null,
  });
  const nonceSuffix = input.traceNonce ? `-${input.traceNonce}` : "";
  return Object.freeze({
    contextLockId: `ctx-${input.campaignId}-${Date.now()}${nonceSuffix}`,
    mode: input.mode,
    campaignId: input.campaignId,
    businessDna: projection.businessDna,
    businessDnaSnapshotId: projection.businessDna.snapshotId,
    evidenceHashSha256: projection.businessDna.evidenceHashSha256,
    campaignStrategy: projection.campaignStrategy,
    campaignStrategySnapshotId: projection.campaignStrategy.snapshotId,
    strategyHashSha256: projection.campaignStrategy.strategyHashSha256,
    policy: DEFAULT_V2_MESSAGE_QUALITY_POLICY,
    policyId: DEFAULT_V2_MESSAGE_QUALITY_POLICY.policyId,
    policyVersion: DEFAULT_V2_MESSAGE_QUALITY_POLICY.policyVersion,
    policyHashSha256: DEFAULT_V2_MESSAGE_QUALITY_POLICY.policyHashSha256,
    diagnostics: projection.diagnostics,
  });
}
