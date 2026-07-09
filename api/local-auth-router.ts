import { z } from "zod";
import bcrypt from "bcryptjs";
import { createRouter, publicQuery, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { users, businesses, twoFactorChallenges } from "@db/schema";
import { eq, or, and } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { signLocalToken, verifyLocalToken, type LocalSessionPayload } from "./lib/session";
import { env } from "./lib/env";
import { ensureFreeSubscription } from "./lib/subscription";
import {
  getChallengePurpose,
  isAccountVerified,
  createAndSendChallenge,
  verifyChallenge,
  markUserVerified,
} from "./lib/auth/otp";

function requiresTwoFactorPolicy(user: { twoFactorEnabled: boolean }): boolean {
  // Product-level mandatory verification can be disabled with REQUIRE_TWO_FACTOR=false.
  // Per-user two-factor settings also trigger a challenge.
  return env.requireTwoFactor || user.twoFactorEnabled;
}

function publicUser(user: {
  id: number;
  username: string | null;
  email: string | null;
  name: string | null;
  role: string;
}) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    name: user.name,
    role: user.role,
  };
}

// ─── Local Auth Router ───
export const localAuthRouter = createRouter({
  // Register with username/password
  register: publicQuery
    .input(
      z.object({
        username: z.string().min(3).max(50),
        email: z.string().email(),
        password: z.string().min(6),
        name: z.string().min(1),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();

      // Check if username or email already exists
      const existing = await db
        .select()
        .from(users)
        .where(
          or(eq(users.username, input.username), eq(users.email, input.email))
        )
        .limit(1);

      if (existing.length > 0) {
        const match = existing[0];

        if (match.username === input.username) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Username already taken",
          });
        }

        if (match.email === input.email) {
          // Verified account → direct them to login.
          if (isAccountVerified(match)) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "Account already exists, please log in",
            });
          }

          // Unverified account → resend verification code instead of trapping them.
          const purpose = getChallengePurpose(match);
          const { challengeToken } = await createAndSendChallenge(db, {
            userId: match.id,
            email: match.email!,
            purpose,
            ctx,
          });

          return {
            requiresTwoFactor: true,
            challengeToken,
            purpose,
            user: publicUser(match),
            message:
              "An account with this email exists but is not verified. A new verification code has been sent.",
          };
        }
      }

      // Hash password
      const passwordHash = await bcrypt.hash(input.password, 12);

      // Create user
      const [result] = await db.insert(users).values({
        username: input.username,
        email: input.email,
        passwordHash,
        name: input.name,
        authType: "local",
        role: "user",
        lastSignInAt: new Date(),
      });

      const userId = Number(result.insertId);

      // Auto-assign free tier and usage tracking
      await ensureFreeSubscription(userId);

      // Verification is required for new registrations under the current policy
      const { challengeToken } = await createAndSendChallenge(db, {
        userId,
        email: input.email,
        purpose: "email_verification",
        ctx,
      });

      return {
        requiresTwoFactor: true,
        challengeToken,
        purpose: "email_verification",
        user: {
          id: userId,
          username: input.username,
          email: input.email,
          name: input.name,
          role: "user",
        },
        message: "A verification code has been sent to your email.",
      };
    }),

  // Login with username/email + password
  login: publicQuery
    .input(
      z.object({
        usernameOrEmail: z.string().min(1),
        password: z.string().min(1),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();

      // Find user by username or email
      const [user] = await db
        .select()
        .from(users)
        .where(
          or(
            eq(users.username, input.usernameOrEmail),
            eq(users.email, input.usernameOrEmail)
          )
        )
        .limit(1);

      if (!user || !user.passwordHash) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Invalid username or password",
        });
      }

      // Verify password
      const valid = await bcrypt.compare(input.password, user.passwordHash);
      if (!valid) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Invalid username or password",
        });
      }

      // Update last sign in
      await db
        .update(users)
        .set({ lastSignInAt: new Date() })
        .where(eq(users.id, user.id));

      // Account email verification takes precedence over login 2FA.
      if (!isAccountVerified(user)) {
        const email = user.email;
        if (!email) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "An email address is required to verify your account.",
          });
        }

        const { challengeToken } = await createAndSendChallenge(db, {
          userId: user.id,
          email,
          purpose: "email_verification",
          ctx,
        });

        return {
          requiresTwoFactor: true,
          challengeToken,
          purpose: "email_verification",
          user: publicUser(user),
          message: "Account not verified. We sent a new verification code.",
        };
      }

      // If verification is required by product policy or user preference, create a challenge
      if (requiresTwoFactorPolicy(user)) {
        const email = user.email;
        if (!email) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "An email address is required to verify your login.",
          });
        }

        const { challengeToken } = await createAndSendChallenge(db, {
          userId: user.id,
          email,
          purpose: "login_2fa",
          ctx,
        });

        return {
          requiresTwoFactor: true,
          challengeToken,
          purpose: "login_2fa",
          user: publicUser(user),
          message: "A verification code has been sent to your email.",
        };
      }

      // Generate fully-verified JWT
      const token = await signLocalToken({ userId: user.id, type: "local", verified: true });

      return {
        token,
        user: publicUser(user),
      };
    }),

  verifyTwoFactor: publicQuery
    .input(
      z.object({
        challengeToken: z.string().min(1),
        otpCode: z.string().length(6),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const user = await verifyChallenge(db, {
        challengeToken: input.challengeToken,
        code: input.otpCode,
      });

      // Mark account/email verified on first successful verification and record the
      // most recent 2FA verification time.
      await markUserVerified(db, user.id);

      const token = await signLocalToken({
        userId: user.id,
        type: user.authType === "google" || user.authType === "firebase" ? user.authType : "local",
        verified: true,
      });

      return {
        token,
        user: publicUser(user),
      };
    }),

  resendVerificationCode: publicQuery
    .input(
      z.object({
        challengeToken: z.string().min(1),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();

      const [challenge] = await db
        .select()
        .from(twoFactorChallenges)
        .where(eq(twoFactorChallenges.challengeToken, input.challengeToken))
        .limit(1);

      if (!challenge) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Invalid verification session. Please sign in again.",
        });
      }

      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.id, challenge.userId))
        .limit(1);

      if (!user || !user.email) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Could not resend verification code. Please try again.",
        });
      }

      const purpose = challenge.purpose as "email_verification" | "login_2fa";

      const { challengeToken } = await createAndSendChallenge(db, {
        userId: user.id,
        email: user.email,
        purpose,
        ctx,
      });

      return {
        challengeToken,
        purpose,
        message: "A new verification code has been sent.",
      };
    }),

  enableTwoFactor: authedQuery
    .input(z.object({ method: z.enum(["email"]) }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      await db
        .update(users)
        .set({
          twoFactorEnabled: true,
          twoFactorMethod: input.method,
          lastTwoFactorVerifiedAt: new Date(),
        })
        .where(eq(users.id, ctx.user.id));
      return { success: true };
    }),

  disableTwoFactor: authedQuery
    .mutation(async ({ ctx }) => {
      const db = getDb();
      await db
        .update(users)
        .set({
          twoFactorEnabled: false,
          twoFactorMethod: null,
          lastTwoFactorVerifiedAt: null,
        })
        .where(eq(users.id, ctx.user.id));
      return { success: true };
    }),

  // Google OAuth: find or create user
  googleAuth: publicQuery
    .input(
      z.object({
        googleId: z.string().min(1),
        email: z.string().email(),
        name: z.string().min(1),
        avatar: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();

      // Check if user exists
      let [user] = await db
        .select()
        .from(users)
        .where(eq(users.googleId, input.googleId))
        .limit(1);

      if (!user) {
        // Check if email already used by local account
        const [existingEmail] = await db
          .select()
          .from(users)
          .where(eq(users.email, input.email))
          .limit(1);

        if (existingEmail) {
          // Link Google to existing account
          await db
            .update(users)
            .set({ googleId: input.googleId, authType: "google" })
            .where(eq(users.id, existingEmail.id));
          user = { ...existingEmail, googleId: input.googleId, authType: "google" };
        } else {
          // Create new Google user
          const [result] = await db.insert(users).values({
            googleId: input.googleId,
            email: input.email,
            name: input.name,
            avatar: input.avatar ?? null,
            authType: "google",
            role: "user",
            username: input.email.split("@")[0],
            lastSignInAt: new Date(),
          });
          const userId = Number(result.insertId);
          user = {
            id: userId,
            unionId: null,
            googleId: input.googleId,
            firebaseUid: null,
            email: input.email,
            name: input.name,
            avatar: input.avatar ?? null,
            authType: "google" as const,
            role: "user" as const,
            username: input.email.split("@")[0],
            passwordHash: null,
            onboardingComplete: false,
            twoFactorEnabled: false,
            twoFactorMethod: null,
            twoFactorVerifiedAt: null,
            emailVerifiedAt: null,
            lastTwoFactorVerifiedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            lastSignInAt: new Date(),
          };

          // Auto-assign free tier and usage tracking for new Google users
          await ensureFreeSubscription(userId);
        }
      }

      // Update last sign in
      await db
        .update(users)
        .set({ lastSignInAt: new Date() })
        .where(eq(users.id, user.id));

      // Verification is required for Google users under the current policy
      if (requiresTwoFactorPolicy(user)) {
        const email = user.email;
        if (!email) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "An email address is required to verify your Google login.",
          });
        }
        const purpose = getChallengePurpose(user);
        const { challengeToken } = await createAndSendChallenge(db, {
          userId: user.id,
          email,
          purpose,
          ctx: { req: ctx.req },
        });
        return {
          requiresTwoFactor: true,
          challengeToken,
          purpose,
          user: publicUser(user),
          message: "A verification code has been sent to your email.",
        };
      }

      // Generate fully-verified JWT
      const token = await signLocalToken({ userId: user.id, type: "google", verified: true });

      return {
        token,
        user: publicUser(user),
      };
    }),

  // Firebase Auth: verify ID token and find or create user
  firebaseAuth: publicQuery
    .input(
      z.object({
        idToken: z.string().min(1),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { firebaseAuth } = await import("./lib/firebase-admin");
      const decoded = await firebaseAuth.verifyIdToken(input.idToken);
      const firebaseUid = decoded.uid;
      const email = decoded.email ?? "";
      const name = decoded.name ?? email.split("@")[0] ?? "User";
      const avatar = decoded.picture ?? null;

      const db = getDb();

      let [user] = await db
        .select()
        .from(users)
        .where(eq(users.firebaseUid, firebaseUid))
        .limit(1);

      if (!user) {
        // Check if email already used by local account
        const [existingEmail] = await db
          .select()
          .from(users)
          .where(eq(users.email, email))
          .limit(1);

        if (existingEmail) {
          // Link Firebase to existing account
          await db
            .update(users)
            .set({ firebaseUid, authType: "firebase" })
            .where(eq(users.id, existingEmail.id));
          user = { ...existingEmail, firebaseUid, authType: "firebase" };
        } else {
          // Create new Firebase user
          const [result] = await db.insert(users).values({
            firebaseUid,
            email,
            name,
            avatar,
            authType: "firebase",
            role: "user",
            username: email.split("@")[0],
            lastSignInAt: new Date(),
          });
          const userId = Number(result.insertId);
          user = {
            id: userId,
            unionId: null,
            googleId: null,
            firebaseUid,
            email,
            name,
            avatar,
            authType: "firebase" as const,
            role: "user" as const,
            username: email.split("@")[0],
            passwordHash: null,
            onboardingComplete: false,
            twoFactorEnabled: false,
            twoFactorMethod: null,
            twoFactorVerifiedAt: null,
            emailVerifiedAt: null,
            lastTwoFactorVerifiedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            lastSignInAt: new Date(),
          };

          // Auto-assign free tier and usage tracking for new Firebase users
          await ensureFreeSubscription(userId);
        }
      }

      // Update last sign in
      await db
        .update(users)
        .set({ lastSignInAt: new Date() })
        .where(eq(users.id, user.id));

      // Check owner for admin role
      if (firebaseUid === env.ownerUnionId && user.role !== "admin") {
        await db
          .update(users)
          .set({ role: "admin" })
          .where(eq(users.id, user.id));
        user.role = "admin";
      }

      // Verification is required for Firebase/Google users under the current policy
      if (requiresTwoFactorPolicy(user)) {
        const email = user.email;
        if (!email) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "An email address is required to verify your Google login.",
          });
        }
        const purpose = getChallengePurpose(user);
        const { challengeToken } = await createAndSendChallenge(db, {
          userId: user.id,
          email,
          purpose,
          ctx: { req: ctx.req },
        });
        return {
          requiresTwoFactor: true,
          challengeToken,
          purpose,
          user: publicUser(user),
          message: "A verification code has been sent to your email.",
        };
      }

      const token = await signLocalToken({ userId: user.id, type: "firebase", verified: true });

      return {
        token,
        user: publicUser(user),
      };
    }),

  // Get current user from token
  me: publicQuery.query(async ({ ctx }) => {
    let payload: LocalSessionPayload | null = ctx.session ?? null;
    if (!payload) {
      // Fallback to header for non-context callers (keeps backward compatibility)
      const authHeader = ctx.req.headers.get("authorization");
      if (!authHeader?.startsWith("Bearer ")) {
        return null;
      }
      const token = authHeader.slice(7);
      payload = await verifyLocalToken(token);
      if (!payload) return null;
    }

    const userId = payload.userId;
    if (!userId) return null;

    const db = getDb();
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) return null;

    // Admins and super-admins bypass business onboarding so they can manage
    // users, businesses, credits, system health and settings immediately.
    let onboardingComplete = user.onboardingComplete || user.role === "admin";
    if (!onboardingComplete) {
      const [biz] = await db
        .select()
        .from(businesses)
        .where(and(eq(businesses.userId, user.id), eq(businesses.onboardingComplete, true)))
        .limit(1);
      if (biz) onboardingComplete = true;
    }

    const requiresVerification = !payload?.verified;

    return {
      id: user.id,
      username: user.username,
      email: user.email,
      name: user.name,
      avatar: user.avatar,
      role: user.role,
      authType: user.authType,
      onboardingComplete,
      twoFactorEnabled: user.twoFactorEnabled,
      requiresVerification,
      isFullyVerified: !requiresVerification,
      createdAt: user.createdAt,
      lastSignInAt: user.lastSignInAt,
    };
  }),

  updateMe: authedQuery
    .input(
      z.object({
        name: z.string().optional(),
        onboardingComplete: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const { name, onboardingComplete } = input;
      const updateData: any = {};
      if (name !== undefined) updateData.name = name;
      if (onboardingComplete !== undefined) updateData.onboardingComplete = onboardingComplete;

      await db
        .update(users)
        .set(updateData)
        .where(eq(users.id, ctx.user.id));

      return { success: true };
    }),
});
