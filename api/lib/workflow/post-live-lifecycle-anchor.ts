type UnknownRecord =
  Record<string, unknown>;

function asRecord(
  value: unknown
): UnknownRecord {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  ) {
    return value as UnknownRecord;
  }

  return {};
}

function normalizeTimestamp(
  value: unknown
): string | null {
  if (
    typeof value !== "string" ||
    !value.trim()
  ) {
    return null;
  }

  const parsed = new Date(value);

  if (
    Number.isNaN(
      parsed.getTime()
    )
  ) {
    return null;
  }

  return parsed.toISOString();
}

/**
 * Reads the immutable campaign-live boundary from workflow context.
 *
 * Preferred authority:
 *   workflowContext.campaignLiveAt
 *
 * Legacy P1.1 compatibility:
 * while a campaign is still in campaign_live, lastTransition still contains
 * the original go_live transition. That timestamp can therefore seed the
 * immutable anchor before P1.2 performs its first post-live transition.
 */
export function readCampaignLiveAtFromWorkflowContext(
  workflowContext: unknown
): Date | null {
  const context =
    asRecord(workflowContext);

  const persisted =
    normalizeTimestamp(
      context.campaignLiveAt
    );

  if (persisted) {
    return new Date(persisted);
  }

  const lastTransition =
    asRecord(
      context.lastTransition
    );

  if (
    lastTransition.action !==
      "go_live" ||
    lastTransition.to !==
      "campaign_live"
  ) {
    return null;
  }

  const legacyTransitionAt =
    normalizeTimestamp(
      lastTransition.at
    );

  return legacyTransitionAt
    ? new Date(
        legacyTransitionAt
      )
    : null;
}

/**
 * Builds workflowContext for one governed transition while preserving the
 * immutable campaign-live lifecycle boundary.
 *
 * A fresh go_live action always establishes a fresh lifecycle anchor.
 * Later transitions preserve it.
 *
 * For a campaign created before campaignLiveAt existed, the first transition
 * out of campaign_live backfills the anchor from the existing P1.1
 * lastTransition record.
 */
export function buildWorkflowTransitionContext(
  input: {
    existingContext: unknown;
    currentState: string;
    nextState: string;
    action: string;
    transitionAt: string;
  }
): UnknownRecord {
  const context =
    asRecord(
      input.existingContext
    );

  const transitionAt =
    normalizeTimestamp(
      input.transitionAt
    );

  if (!transitionAt) {
    throw new Error(
      "transitionAt must be a valid timestamp"
    );
  }

  let campaignLiveAt =
    normalizeTimestamp(
      context.campaignLiveAt
    );

  if (
    input.action === "go_live" &&
    input.nextState ===
      "campaign_live"
  ) {
    campaignLiveAt =
      transitionAt;
  } else if (
    !campaignLiveAt &&
    input.currentState ===
      "campaign_live"
  ) {
    const recovered =
      readCampaignLiveAtFromWorkflowContext(
        context
      );

    campaignLiveAt =
      recovered
        ? recovered.toISOString()
        : null;
  }

  return {
    ...context,

    ...(campaignLiveAt
      ? { campaignLiveAt }
      : {}),

    lastTransition: {
      from: input.currentState,
      to: input.nextState,
      action: input.action,
      at: transitionAt,
    },
  };
}