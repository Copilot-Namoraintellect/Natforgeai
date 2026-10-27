// ─── R6-C Lead Qualification — independent human review authority ───
//
// Contract §10 blocker closure: a verified tenant session alone must never
// resolve a REVIEW_REQUIRED review, because runtime agents operate under the
// tenant's own JWT and are indistinguishable from the human at the session
// layer. Resolution therefore requires an out-of-band, single-use, expiring
// human-presence challenge (email OTP, purpose "review_authorization") bound
// to the exact reviewId before the code is even issued. The challenge is the
// independent channel: an autonomous agent holding the tenant session cannot
// observe the emailed code, so it cannot self-approve a qualification
// recommendation.
//
// The gateway is the only qualification dependency on the OTP primitive; the
// deterministic engine and evidence seams stay free of auth/email imports.
// Implementations must derive every identity server-side — no client-supplied
// reviewerId, human flag, or model output is ever accepted.

import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { users } from "@db/schema";
import { getDb } from "../../queries/connection";
import {
  createAndSendChallenge,
  verifyChallenge,
  type ChallengePurpose,
} from "../auth/otp";

export const REVIEW_AUTHORIZATION_PURPOSE: ChallengePurpose = "review_authorization";

export interface CreateReviewChallengeInput {
  /** Server-resolved tenant user the challenge is issued to. */
  readonly userId: number;
  /** Exact review binding; the code issued is only presentable for this review. */
  readonly reviewId: string;
  /** Request whose connection metadata is recorded on the durable challenge. */
  readonly req: Request;
}

export interface CreatedReviewChallenge {
  readonly challengeToken: string;
  readonly expiresAt: string;
}

export interface VerifyReviewChallengeInput {
  readonly challengeToken: string;
  readonly code: string;
}

/** The verified human actor: the tenant user the challenge was issued to. */
export interface VerifiedReviewChallenge {
  readonly userId: number;
  readonly consumedAt: string;
}

/**
 * Human-presence challenge seam. The production implementation is the OTP
 * email challenge (out of band, single use, 10-minute TTL, attempt limited);
 * tests bind a scripted fake. Resolution fails closed when verification is
 * absent, invalid, expired, consumed, or bound to a different actor/review.
 */
export interface ReviewChallengeGateway {
  createAndSend(input: CreateReviewChallengeInput): Promise<CreatedReviewChallenge>;
  verify(input: VerifyReviewChallengeInput): Promise<VerifiedReviewChallenge>;
}

/** Out-of-band email OTP gateway over the shared governed OTP primitive. */
export class OtpReviewChallengeGateway implements ReviewChallengeGateway {
  private readonly db: {
    select: (...args: never[]) => any;
    update?: (...args: never[]) => any;
  };

  constructor(db?: { select: (...args: never[]) => any; update?: (...args: never[]) => any }) {
    this.db = db ?? getDb();
  }

  async createAndSend(input: CreateReviewChallengeInput): Promise<CreatedReviewChallenge> {
    const [user] = (await this.db
      .select()
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1)) as Array<{ email: string } | undefined>;
    if (!user || typeof user.email !== "string" || user.email.length === 0) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "review authorization: reviewer email unavailable; refusing to issue a challenge",
      });
    }
    const { challengeToken, expiresAt } = await createAndSendChallenge(
      this.db,
      {
        userId: input.userId,
        email: user.email,
        purpose: REVIEW_AUTHORIZATION_PURPOSE,
        // The request context carries client connection metadata for the
        // durable challenge record (ip/userAgent); the code itself travels
        // only over email.
        ctx: { req: input.req },
      }
    );
    return { challengeToken, expiresAt: expiresAt.toISOString() };
  }

  async verify(input: VerifyReviewChallengeInput): Promise<VerifiedReviewChallenge> {
    const user = await verifyChallenge(this.db, {
      challengeToken: input.challengeToken,
      code: input.code,
    });
    return { userId: Number(user.id), consumedAt: new Date().toISOString() };
  }
}
