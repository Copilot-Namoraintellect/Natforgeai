import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { eq, and, gt, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import type { SentMessageInfo } from "nodemailer";
import { users, twoFactorChallenges, type User } from "@db/schema";
import { sendTwoFactorCodeEmail } from "../email";
import { logInfo, logError } from "../logger";

export type ChallengePurpose = "email_verification" | "login_2fa";

const CHALLENGE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function generateVerificationCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function hashVerificationCode(code: string): Promise<string> {
  return bcrypt.hash(code, 10);
}

export function getChallengePurpose(
  user: Pick<User, "emailVerifiedAt">
): ChallengePurpose {
  return user.emailVerifiedAt ? "login_2fa" : "email_verification";
}

export function isAccountVerified(user: Pick<User, "emailVerifiedAt">): boolean {
  return !!user.emailVerifiedAt;
}

function getClientMeta(ctx: { req: Request }) {
  return {
    ipAddress:
      ctx.req.headers.get("x-forwarded-for") ||
      ctx.req.headers.get("x-real-ip") ||
      ctx.req.headers.get("host") ||
      undefined,
    userAgent: ctx.req.headers.get("user-agent") || undefined,
  };
}

export async function consumeActiveChallenges(
  db: any,
  userId: number,
  purpose: ChallengePurpose
): Promise<void> {
  await db
    .update(twoFactorChallenges)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(twoFactorChallenges.userId, userId),
        eq(twoFactorChallenges.purpose, purpose),
        gt(twoFactorChallenges.expiresAt, new Date()),
        isNull(twoFactorChallenges.consumedAt)
      )
    );
}

export async function createAndSendChallenge(
  db: any,
  {
    userId,
    email,
    purpose,
    ctx,
  }: {
    userId: number;
    email: string;
    purpose: ChallengePurpose;
    ctx: { req: Request };
  }
): Promise<{ challengeToken: string; info: SentMessageInfo }> {
  const otpCode = generateVerificationCode();
  const otpHash = await hashVerificationCode(otpCode);
  const challengeToken = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
  const { ipAddress, userAgent } = getClientMeta(ctx);

  // Invalidate any previous active codes for the same user + purpose before sending.
  await consumeActiveChallenges(db, userId, purpose);

  let info: SentMessageInfo;
  try {
    info = await sendTwoFactorCodeEmail({ to: email, code: otpCode });
  } catch (err: any) {
    logError("[otp] failed to send verification email", {
      userId,
      purpose,
      recipient: email,
      error: err?.message || String(err),
    });
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Could not send verification code. Please try again.",
    });
  }

  const [inserted] = await db.insert(twoFactorChallenges).values({
    userId,
    challengeToken,
    otpHash,
    expiresAt,
    purpose,
    sentToEmail: email,
    ipAddress,
    userAgent,
  });

  const challengeId = inserted?.insertId ?? null;

  logInfo("[otp] verification email sent", {
    userId,
    challengeId: challengeId ? Number(challengeId) : null,
    purpose,
    recipient: email,
    messageId: info.messageId,
    accepted: Array.isArray(info.accepted) ? info.accepted : [info.accepted].filter(Boolean),
    rejected: Array.isArray(info.rejected) ? info.rejected : [info.rejected].filter(Boolean),
    response: typeof info.response === "string" ? info.response : undefined,
  });

  return { challengeToken, info };
}

export async function verifyChallenge(
  db: any,
  {
    challengeToken,
    code,
  }: { challengeToken: string; code: string }
): Promise<User> {
  const [challenge] = await db
    .select()
    .from(twoFactorChallenges)
    .where(
      and(
        eq(twoFactorChallenges.challengeToken, challengeToken),
        gt(twoFactorChallenges.expiresAt, new Date()),
        isNull(twoFactorChallenges.consumedAt)
      )
    )
    .limit(1);

  if (!challenge) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Invalid or expired verification code",
    });
  }

  if (challenge.attempts >= challenge.maxAttempts) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Too many attempts. Please request a new code.",
    });
  }

  const newAttempts = challenge.attempts + 1;
  await db
    .update(twoFactorChallenges)
    .set({ attempts: newAttempts })
    .where(eq(twoFactorChallenges.id, challenge.id));

  const valid = await bcrypt.compare(code, challenge.otpHash);
  if (!valid) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Invalid verification code",
    });
  }

  await db
    .update(twoFactorChallenges)
    .set({ consumedAt: new Date() })
    .where(eq(twoFactorChallenges.id, challenge.id));

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, challenge.userId))
    .limit(1);

  if (!user) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Verification failed. Please try again.",
    });
  }

  return user;
}

export async function markUserVerified(
  db: any,
  userId: number
): Promise<void> {
  const now = new Date();
  await db
    .update(users)
    .set({
      emailVerifiedAt: now,
      lastTwoFactorVerifiedAt: now,
      updatedAt: now,
    })
    .where(eq(users.id, userId));
}
