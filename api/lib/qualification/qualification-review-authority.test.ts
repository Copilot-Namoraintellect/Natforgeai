// ─── R6-C — Review Challenge Gateway unit evidence ───
//
// The happy path (issue → email → verify → consume) runs end to end with the
// REAL OTP primitive, REAL bcrypt and the REAL router in
// api/qualification-router.test.ts and scenario 23d of api/r6-c-acceptance
// .test.ts. This file pins the gateway's own fail-closed obligations: the
// reviewer identity is server-derived from the users table, the challenge is
// issued under the review_authorization human-presence purpose, and the code
// travels only over email (never through any API payload).

import { describe, expect, it, vi } from "vitest";

vi.mock("../email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../email")>();
  return {
    ...actual,
    sendTwoFactorCodeEmail: vi.fn(async (input: { to: string; code: string }) => {
      captured.push(input);
      return { messageId: "test", accepted: [input.to] } as never;
    }),
  };
});

import { sendTwoFactorCodeEmail } from "../email";
import {
  OtpReviewChallengeGateway,
  REVIEW_AUTHORIZATION_PURPOSE,
} from "./qualification-review-authority";
import { HUMAN_PRESENCE_PURPOSES } from "../auth/otp";

const captured: Array<{ to: string; code: string }> = [];

/** Minimal structural db: serves the users lookup; OTP insert captured. */
function makeDb(userRow: { id: number; email: string } | null) {
  const inserted: Array<Record<string, unknown>> = [];
  return {
    inserted,
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => (userRow ? [userRow] : []),
          }),
        }),
      }),
      update: () => ({ set: () => ({ where: async () => [{ affectedRows: 0 }] }) }),
      insert: () => ({
        values: async (row: Record<string, unknown>) => {
          inserted.push(row);
          return [{ insertId: inserted.length, affectedRows: 1 }];
        },
      }),
    },
  };
}

describe("OtpReviewChallengeGateway", () => {
  it("issues the challenge under the human-presence review purpose and emails the code", async () => {
    captured.length = 0;
    const { db, inserted } = makeDb({ id: 7, email: "reviewer@example.com" });
    const gateway = new OtpReviewChallengeGateway(db as never);

    const result = await gateway.createAndSend({
      userId: 7,
      reviewId: `lqr1:${"ab".repeat(32)}`,
      req: new Request("http://localhost/api/trpc"),
    });

    expect(REVIEW_AUTHORIZATION_PURPOSE).toBe("review_authorization");
    expect(HUMAN_PRESENCE_PURPOSES.has("review_authorization")).toBe(true);
    expect(result.challengeToken).toMatch(/^[a-f0-9]{64}$/);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      userId: 7,
      purpose: "review_authorization",
      sentToEmail: "reviewer@example.com",
    });
    expect(inserted[0].expiresAt).toBeInstanceOf(Date);
    expect(inserted[0].consumedAt ?? null).toBeNull();
    expect(captured).toHaveLength(1);
    expect(captured[0].to).toBe("reviewer@example.com");
    expect(captured[0].code).toMatch(/^\d{6}$/);
    expect(sendTwoFactorCodeEmail).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the reviewer identity has no authoritative email", async () => {
    captured.length = 0;
    const missing = makeDb(null);
    const gateway = new OtpReviewChallengeGateway(missing.db as never);

    await expect(
      gateway.createAndSend({
        userId: 7,
        reviewId: `lqr1:${"ab".repeat(32)}`,
        req: new Request("http://localhost/api/trpc"),
      })
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(missing.inserted).toHaveLength(0);
    expect(captured).toHaveLength(0);
  });
});
