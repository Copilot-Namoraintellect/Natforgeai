/**
 * Sensitive-reply approval contract (WBS 4F / Wave 2 / WBS14A, first slice).
 *
 * Deterministic, side-effect-free builder for the approval request command
 * that bridges escalated engagement conversations into the Approval Centre as
 * `sensitive_reply` approval requests.
 *
 * Contract guarantees:
 * - Pure: no database access, no clock, no randomness, no I/O, and absolutely
 *   no outbound platform call. The returned command is plain serializable
 *   data ready for a later slice to persist via the shared approval creation
 *   infrastructure.
 * - Deterministic identity: the idempotency key is derived only from the
 *   event-scoped dedupKey supplied by inbound processing, so an identical
 *   retry produces an identical approval identity while two different inbound
 *   events in the same thread necessarily produce different identities.
 * - No provider key leakage: the raw provider event key (e.g. a Meta message
 *   id) is never echoed into user-facing text; user-facing fields carry only
 *   internal thread/campaign identifiers and the derived key fingerprint.
 *
 * `requireApprovalBeforeReplying` is currently frontend/onboarding state only
 * and is intentionally NOT consulted here; it is not backend authority.
 */

import { createHash } from "crypto";

export const SENSITIVE_REPLY_APPROVAL_TYPE = "sensitive_reply" as const;

/**
 * Namespace bound into the idempotency hash. Bumping this version
 * invalidates previously derived keys for the same event dedupKey.
 */
const IDEMPOTENCY_NAMESPACE = "engagement/sensitive-reply@v1";

/** Human-greppable prefix for derived idempotency keys. */
const IDEMPOTENCY_KEY_PREFIX = "sr1";

const RISK_ORDER: readonly ApprovalRiskLevel[] = ["low", "medium", "high"];

export type SensitiveReplySentiment =
  | "positive"
  | "neutral"
  | "negative"
  | "urgent";

export type ApprovalRiskLevel = "low" | "medium" | "high";

const SENTIMENTS: readonly SensitiveReplySentiment[] = [
  "positive",
  "neutral",
  "negative",
  "urgent",
];

export interface SensitiveReplyApprovalInput {
  userId: number;
  /** Nullable: engagement threads are not always linked to a campaign. */
  campaignId: number | null;
  threadId: number;
  /**
   * Event-scoped idempotency key supplied by inbound processing
   * (e.g. `<provider>:<externalEventId>`). Never surfaced to users.
   */
  dedupKey: string;
  /** The AI-proposed reply awaiting human approval. */
  proposedReply: string;
  /** Why the engagement agent escalated; empty/omitted when not given. */
  escalationReason?: string | null;
  sentiment: SensitiveReplySentiment;
}

/**
 * The full approval request command. Identity fields pass through from the
 * input; every other field is derived deterministically from the input.
 */
export interface SensitiveReplyApprovalCommand {
  userId: number;
  campaignId: number | null;
  threadId: number;
  approvalType: typeof SENSITIVE_REPLY_APPROVAL_TYPE;
  /** Deterministic idempotency key derived from the event dedupKey. */
  idempotencyKey: string;
  title: string;
  description: string;
  aiRecommendation: string;
  riskLevel: ApprovalRiskLevel;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertPositiveInt(value: number, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    throw new Error(
      `sensitive_reply approval: ${field} must be a positive integer`
    );
  }
  return value;
}

function assertNonEmptyString(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `sensitive_reply approval: ${field} must be a non-empty string`
    );
  }
  return value;
}

function assertSentiment(
  value: SensitiveReplySentiment
): SensitiveReplySentiment {
  if (!SENTIMENTS.includes(value)) {
    throw new Error(
      `sensitive_reply approval: sentiment must be one of ${SENTIMENTS.join(", ")}`
    );
  }
  return value;
}

function normalizeOptionalText(
  value: string | null | undefined
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Derive the deterministic idempotency key for one inbound event. The key is
 * a SHA-256 fingerprint of the namespaced event dedupKey, never the raw
 * provider event key itself.
 */
export function buildSensitiveReplyIdempotencyKey(dedupKey: string): string {
  const normalized = assertNonEmptyString(dedupKey, "dedupKey").trim();
  return `${IDEMPOTENCY_KEY_PREFIX}:${sha256Hex(`${IDEMPOTENCY_NAMESPACE}:${normalized}`)}`;
}

/**
 * Deterministic risk policy:
 * - sentiment base: urgent | negative -> high, neutral -> medium,
 *   positive -> low;
 * - a non-empty escalation reason bumps the base one level (capped at high),
 *   because an escalated conversation always warrants at least a medium
 *   review even when the detected sentiment is positive.
 */
export function deriveSensitiveReplyRiskLevel(input: {
  sentiment: SensitiveReplySentiment;
  escalationReason?: string | null;
}): ApprovalRiskLevel {
  const sentiment = assertSentiment(input.sentiment);
  const base: ApprovalRiskLevel =
    sentiment === "urgent" || sentiment === "negative"
      ? "high"
      : sentiment === "neutral"
        ? "medium"
        : "low";

  if (normalizeOptionalText(input.escalationReason) === null) return base;

  const bumpedIndex = Math.min(
    RISK_ORDER.indexOf(base) + 1,
    RISK_ORDER.length - 1
  );
  return RISK_ORDER[bumpedIndex];
}

function buildDescription(input: {
  threadId: number;
  campaignId: number | null;
  sentiment: SensitiveReplySentiment;
  escalationReason: string | null;
}): string {
  return [
    "The engagement agent proposed a reply to an escalated conversation.",
    "A human must approve the reply before anything is sent.",
    "",
    `Thread: #${input.threadId}`,
    `Campaign: ${input.campaignId == null ? "Unassigned" : `#${input.campaignId}`}`,
    `Sentiment: ${input.sentiment}`,
    `Escalation reason: ${input.escalationReason ?? "Not specified"}`,
    "",
    "Review the proposed reply below and approve or reject it.",
    "Nothing has been sent to the contact.",
  ].join("\n");
}

/**
 * Build the deterministic sensitive_reply approval request command for one
 * escalated inbound event. Same input -> identical command (safe retries);
 * a different event dedupKey -> a different idempotency identity.
 */
export function buildSensitiveReplyApprovalRequest(
  input: SensitiveReplyApprovalInput
): SensitiveReplyApprovalCommand {
  const userId = assertPositiveInt(input.userId, "userId");
  const campaignId =
    input.campaignId == null
      ? null
      : assertPositiveInt(input.campaignId, "campaignId");
  const threadId = assertPositiveInt(input.threadId, "threadId");
  const dedupKey = assertNonEmptyString(input.dedupKey, "dedupKey");
  const proposedReply = assertNonEmptyString(
    input.proposedReply,
    "proposedReply"
  );
  const escalationReason = normalizeOptionalText(input.escalationReason);
  const sentiment = assertSentiment(input.sentiment);

  return {
    userId,
    campaignId,
    threadId,
    approvalType: SENSITIVE_REPLY_APPROVAL_TYPE,
    idempotencyKey: buildSensitiveReplyIdempotencyKey(dedupKey),
    title: `Sensitive Reply Approval (Thread #${threadId})`,
    description: buildDescription({
      threadId,
      campaignId,
      sentiment,
      escalationReason,
    }),
    aiRecommendation: proposedReply,
    riskLevel: deriveSensitiveReplyRiskLevel({ sentiment, escalationReason }),
  };
}
