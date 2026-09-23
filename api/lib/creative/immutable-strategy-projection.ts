import type {
  CreativeStrategySnapshotInput,
} from "./strategy-snapshot-input";

/**
 * Build the in-memory campaign view consumed by Creative from immutable
 * Strategy authority. No database row is mutated.
 *
 * Non-Strategy campaign facts remain available, while Strategy-derived
 * semantic fields are replaced by the exact WBS11 snapshot values.
 */
export function projectCampaignFromImmutableStrategy(
  campaign: unknown,
  strategyInput: CreativeStrategySnapshotInput
): Record<string, unknown> {
  const source =
    campaign && typeof campaign === "object"
      ? campaign as Record<string, unknown>
      : {};

  const workflowContext =
    source.workflowContext &&
    typeof source.workflowContext === "object"
      ? source.workflowContext as Record<string, unknown>
      : {};

  const context =
    strategyInput.creativeContext;

  return {
    ...source,

    coreMessage:
      context.coreMessage,

    personas:
      [...context.personas],

    workflowContext: {
      ...workflowContext,

      coreMessage:
        context.coreMessage,

      valueProposition:
        context.valueProposition,

      positioning:
        context.positioning,

      campaignTheme:
        context.campaignTheme,

      strategySnapshotId:
        strategyInput.authority.strategySnapshotId,

      strategyVersion:
        strategyInput.authority.strategyVersion,

      businessDnaSnapshotId:
        strategyInput.authority.businessDnaSnapshotId,

      strategyHashSha256:
        strategyInput.authority.strategyHashSha256,
    },
  };
}
