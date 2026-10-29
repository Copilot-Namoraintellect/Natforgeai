// ─── R8-F Strategic Intelligence Governance — independent human review authority (F5) ───
//
// A verified tenant session alone must never authorize a REVIEW_REQUIRED
// strategic recommendation, because runtime agents operate under the tenant's
// own JWT and are indistinguishable from the human at the session layer.
// Authorization therefore requires an out-of-band, single-use, expiring
// human-presence challenge (email OTP, purpose "review_authorization") issued
// only after the exact governance decision is re-read for this tenant — the
// same governed OTP primitive R6-C uses for qualification reviews
// (api/lib/qualification/qualification-review-authority.ts, api/lib/auth/otp).
// The challenge is the independent channel: an autonomous agent holding the
// tenant session cannot observe the emailed code, so it cannot self-approve a
// strategic recommendation (AC22).
//
// This module is the ONLY strategic-governance dependency on the OTP
// primitive; the deterministic engine and evidence seams stay free of
// auth/email imports. Implementations derive every identity server-side — no
// client-supplied reviewerId, human flag, or model output is ever accepted.

import { TRPCError } from "@trpc/server";
import { users } from "@db/schema";
import { eq } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import {
  createAndSendChallenge,
  verifyChallenge,
  type ChallengePurpose,
} from "../auth/otp";

export const STRATEGIC_REVIEW_AUTHORIZATION_PURPOSE: ChallengePurpose = "review_authorization";

export interface CreateStrategicReviewChallengeInput {
  /** Server-resolved tenant user the challenge is issued to. */
  readonly userId: number;
  /**
   * Exact governance decision the challenge is issued against. The caller
   * must have re-read the durable decision for this tenant before issuing;
   * the code is only meaningful in that binding.
   */
  readonly governanceDecisionId: string;
  /** Request whose connection metadata is recorded on the durable challenge. */
  readonly req: Request;
}

export interface CreatedStrategicReviewChallenge {
  readonly challengeToken: string;
  readonly expiresAt: string;
}

export interface VerifyStrategicReviewChallengeInput {
  readonly challengeToken: string;
  readonly code: string;
}

/** The verified human actor: the tenant user the challenge was issued to. */
export interface VerifiedStrategicReviewChallenge {
  readonly userId: number;
  readonly consumedAt: string;
}

/**
 * Human-presence challenge seam. The production implementation is the OTP
 * email challenge (out of band, single use, 10-minute TTL, attempt limited);
 * tests bind a scripted fake. Verification fails closed when the challenge is
 * absent, invalid, expired, consumed, or bound to a different actor.
 */
export interface StrategicReviewChallengeGateway {
  createAndSend(
    input: CreateStrategicReviewChallengeInput
  ): Promise<CreatedStrategicReviewChallenge>;
  verify(input: VerifyStrategicReviewChallengeInput): Promise<VerifiedStrategicReviewChallenge>;
}

/** Out-of-band email OTP gateway over the shared governed OTP primitive. */
export class OtpStrategicReviewChallengeGateway implements StrategicReviewChallengeGateway {
  private readonly db: {
    select: (...args: never[]) => any;
    update?: (...args: never[]) => any;
  };

  constructor(db?: { select: (...args: never[]) => any; update?: (...args: never[]) => any }) {
    this.db = db ?? getDb();
  }

  async createAndSend(
    input: CreateStrategicReviewChallengeInput
  ): Promise<CreatedStrategicReviewChallenge> {
    const [user] = (await this.db
      .select()
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1)) as Array<{ email: string } | undefined>;
    if (!user || typeof user.email !== "string" || user.email.length === 0) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message:
          "strategic review authorization: reviewer email unavailable; refusing to issue a challenge",
      });
    }
    const { challengeToken, expiresAt } = await createAndSendChallenge(
      this.db,
      {
        userId: input.userId,
        email: user.email,
        purpose: STRATEGIC_REVIEW_AUTHORIZATION_PURPOSE,
        // The request context carries client connection metadata for the
        // durable challenge record (ip/userAgent); the code itself travels
        // only over email.
        ctx: { req: input.req },
      }
    );
    return { challengeToken, expiresAt: expiresAt.toISOString() };
  }

  async verify(
    input: VerifyStrategicReviewChallengeInput
  ): Promise<VerifiedStrategicReviewChallenge> {
    const user = await verifyChallenge(this.db, {
      challengeToken: input.challengeToken,
      code: input.code,
    });
    return { userId: Number(user.id), consumedAt: new Date().toISOString() };
  }
}
