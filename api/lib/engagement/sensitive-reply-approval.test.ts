import { describe, expect, it } from "vitest";
import {
  buildSensitiveReplyApprovalRequest,
  buildSensitiveReplyIdempotencyKey,
  deriveSensitiveReplyRiskLevel,
  SENSITIVE_REPLY_APPROVAL_TYPE,
  type SensitiveReplyApprovalInput,
} from "./sensitive-reply-approval";

const META_EVENT_KEY = "meta:m_abcdef1234567890";

function buildInput(
  overrides: Partial<SensitiveReplyApprovalInput> = {}
): SensitiveReplyApprovalInput {
  return {
    userId: 42,
    campaignId: 7,
    threadId: 99,
    dedupKey: META_EVENT_KEY,
    proposedReply:
      "Thanks for reaching out — let me connect you with our team.",
    escalationReason: "The contact asked about a refund.",
    sentiment: "negative",
    ...overrides,
  };
}

describe("buildSensitiveReplyApprovalRequest", () => {
  it("builds a sensitive_reply command carrying the proposed reply as recommendation", () => {
    const input = buildInput();
    const command = buildSensitiveReplyApprovalRequest(input);

    expect(command.approvalType).toBe(SENSITIVE_REPLY_APPROVAL_TYPE);
    expect(command.approvalType).toBe("sensitive_reply");
    expect(command.aiRecommendation).toBe(input.proposedReply);
    expect(command.userId).toBe(input.userId);
    expect(command.campaignId).toBe(input.campaignId);
    expect(command.threadId).toBe(input.threadId);
    expect(command.title).toContain(`Thread #${input.threadId}`);
    expect(["low", "medium", "high"]).toContain(command.riskLevel);
  });

  it("derives an sr1-prefixed SHA-256 idempotency key from the event dedupKey", () => {
    const command = buildSensitiveReplyApprovalRequest(buildInput());

    expect(command.idempotencyKey).toMatch(/^sr1:[0-9a-f]{64}$/);
    // The derived key must be a fingerprint, never the raw provider event key.
    expect(command.idempotencyKey).not.toBe(META_EVENT_KEY);
    expect(command.idempotencyKey).not.toContain(META_EVENT_KEY);
  });

  it("produces an identical approval identity for identical retry input", () => {
    const first = buildSensitiveReplyApprovalRequest(buildInput());
    const retry = buildSensitiveReplyApprovalRequest(buildInput());

    expect(retry).toEqual(first);
    expect(retry.idempotencyKey).toBe(first.idempotencyKey);
  });

  it("produces a different approval identity for different inbound events in the same thread", () => {
    const first = buildSensitiveReplyApprovalRequest(
      buildInput({ dedupKey: "meta:m_event_one" })
    );
    const second = buildSensitiveReplyApprovalRequest(
      buildInput({ dedupKey: "meta:m_event_two" })
    );

    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(second).not.toEqual(first);
  });

  it("scopes identity to the event, not the reply text or reason", () => {
    const first = buildSensitiveReplyApprovalRequest(buildInput());
    const edited = buildSensitiveReplyApprovalRequest(
      buildInput({
        proposedReply: "A completely different proposed reply.",
        escalationReason: "A different escalation reason.",
        sentiment: "urgent",
      })
    );

    // Same inbound event: identity stays stable even if the derived fields differ.
    expect(edited.idempotencyKey).toBe(first.idempotencyKey);
  });

  it("accepts a null campaignId and labels the campaign unassigned", () => {
    const command = buildSensitiveReplyApprovalRequest(
      buildInput({ campaignId: null })
    );

    expect(command.campaignId).toBeNull();
    expect(command.description).toContain("Campaign: Unassigned");
  });

  it("includes the campaign id when the thread is campaign-linked", () => {
    const command = buildSensitiveReplyApprovalRequest(
      buildInput({ campaignId: 7 })
    );

    expect(command.description).toContain("Campaign: #7");
  });

  it("describes the escalation reason and sentiment in the description", () => {
    const command = buildSensitiveReplyApprovalRequest(
      buildInput({
        escalationReason: "  Legal threat mentioned.  ",
        sentiment: "urgent",
      })
    );

    expect(command.description).toContain(
      "Escalation reason: Legal threat mentioned."
    );
    expect(command.description).toContain("Sentiment: urgent");
  });

  it("falls back to 'Not specified' when no escalation reason is given", () => {
    const command = buildSensitiveReplyApprovalRequest(
      buildInput({ escalationReason: undefined })
    );

    expect(command.description).toContain("Escalation reason: Not specified");
  });

  it("never exposes the raw provider event key in user-facing text", () => {
    const command = buildSensitiveReplyApprovalRequest(buildInput());

    expect(command.title).not.toContain(META_EVENT_KEY);
    expect(command.description).not.toContain(META_EVENT_KEY);
    expect(command.aiRecommendation).not.toContain(META_EVENT_KEY);
  });

  it("returns plain serializable data with no behaviour attached", () => {
    const command = buildSensitiveReplyApprovalRequest(buildInput());

    expect(JSON.parse(JSON.stringify(command))).toEqual(command);
    for (const value of Object.values(command)) {
      expect(typeof value).not.toBe("function");
    }
  });

  it("rejects invalid identity and payload fields", () => {
    expect(() =>
      buildSensitiveReplyApprovalRequest(buildInput({ userId: 0 }))
    ).toThrow(/userId/);
    expect(() =>
      buildSensitiveReplyApprovalRequest(buildInput({ campaignId: -1 }))
    ).toThrow(/campaignId/);
    expect(() =>
      buildSensitiveReplyApprovalRequest(buildInput({ threadId: 1.5 }))
    ).toThrow(/threadId/);
    expect(() =>
      buildSensitiveReplyApprovalRequest(buildInput({ dedupKey: "   " }))
    ).toThrow(/dedupKey/);
    expect(() =>
      buildSensitiveReplyApprovalRequest(buildInput({ proposedReply: "" }))
    ).toThrow(/proposedReply/);
    expect(() =>
      buildSensitiveReplyApprovalRequest(
        buildInput({ sentiment: "angry" as never })
      )
    ).toThrow(/sentiment/);
  });
});

describe("buildSensitiveReplyIdempotencyKey", () => {
  it("is deterministic and namespaces the dedupKey", () => {
    const first = buildSensitiveReplyIdempotencyKey(META_EVENT_KEY);
    const second = buildSensitiveReplyIdempotencyKey(META_EVENT_KEY);

    expect(first).toBe(second);
    expect(first).toMatch(/^sr1:[0-9a-f]{64}$/);
  });

  it("differs for different events and is insensitive to surrounding whitespace", () => {
    const key = buildSensitiveReplyIdempotencyKey(META_EVENT_KEY);
    const padded = buildSensitiveReplyIdempotencyKey(`  ${META_EVENT_KEY}  `);
    const other = buildSensitiveReplyIdempotencyKey("meta:m_other_event");

    expect(padded).toBe(key);
    expect(other).not.toBe(key);
  });
});

describe("deriveSensitiveReplyRiskLevel", () => {
  const cases: Array<
    [string, Parameters<typeof deriveSensitiveReplyRiskLevel>[0], string]
  > = [
    [
      "positive sentiment without escalation reason",
      { sentiment: "positive", escalationReason: null },
      "low",
    ],
    [
      "positive sentiment with escalation reason",
      { sentiment: "positive", escalationReason: "Asks about medical claims" },
      "medium",
    ],
    [
      "neutral sentiment without escalation reason",
      { sentiment: "neutral", escalationReason: null },
      "medium",
    ],
    [
      "neutral sentiment with escalation reason",
      { sentiment: "neutral", escalationReason: "Refund demand" },
      "high",
    ],
    [
      "negative sentiment without escalation reason",
      { sentiment: "negative", escalationReason: null },
      "high",
    ],
    [
      "negative sentiment with escalation reason",
      { sentiment: "negative", escalationReason: "Refund demand" },
      "high",
    ],
    [
      "urgent sentiment without escalation reason",
      { sentiment: "urgent", escalationReason: null },
      "high",
    ],
    [
      "urgent sentiment with escalation reason",
      { sentiment: "urgent", escalationReason: "Anything" },
      "high",
    ],
  ];

  for (const [name, input, expected] of cases) {
    it(`maps ${name} deterministically to ${expected}`, () => {
      expect(deriveSensitiveReplyRiskLevel(input)).toBe(expected);
      expect(deriveSensitiveReplyRiskLevel(input)).toBe(expected);
    });
  }

  it("treats blank escalation reasons as absent", () => {
    expect(
      deriveSensitiveReplyRiskLevel({
        sentiment: "positive",
        escalationReason: "   ",
      })
    ).toBe("low");
  });
});
