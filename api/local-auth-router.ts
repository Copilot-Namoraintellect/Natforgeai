import { z } from "zod";
import bcrypt from "bcryptjs";
import { createRouter, publicQuery, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { users, businesses } from "@db/schema";
import { eq, or, and } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { signLocalToken, verifyLocalToken } from "./lib/session";
import { env } from "./lib/env";
import { ensureFreeSubscription } from "./lib/subscription";

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
    .mutation(async ({ input }) => {
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
          throw new TRPCError({
            code: "CONFLICT",
            message: "Email already registered",
          });
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

      // Generate JWT
      const token = await signLocalToken({ userId, type: "local" });

      return {
        token,
        user: {
          id: userId,
          username: input.username,
          email: input.email,
          name: input.name,
          role: "user",
        },
      };
    }),

  // Login with username/email + password
  // TODO: 2FA login challenge is not yet implemented. When twoFactorEnabled is true,
  // the login flow must verify a TOTP code before issuing a token.
  login: publicQuery
    .input(
      z.object({
        usernameOrEmail: z.string().min(1),
        password: z.string().min(1),
      })
    )
    .mutation(async ({ input }) => {
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

      // Generate JWT
      const token = await signLocalToken({ userId: user.id, type: "local" });

      return {
        token,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          name: user.name,
          role: user.role,
        },
      };
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
    .mutation(async ({ input }) => {
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

      // Generate JWT
      const token = await signLocalToken({ userId: user.id, type: "google" });

      return {
        token,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          name: user.name,
          role: user.role,
        },
      };
    }),

  // Firebase Auth: verify ID token and find or create user
  firebaseAuth: publicQuery
    .input(
      z.object({
        idToken: z.string().min(1),
      })
    )
    .mutation(async ({ input }) => {
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

      const token = await signLocalToken({ userId: user.id, type: "firebase" });

      return {
        token,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          name: user.name,
          role: user.role,
        },
      };
    }),

  // Get current user from token
  me: publicQuery.query(async ({ ctx }) => {
    const authHeader = ctx.req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return null;
    }

    const token = authHeader.slice(7);
    const payload = await verifyLocalToken(token);
    if (!payload) return null;

    const db = getDb();
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, payload.userId))
      .limit(1);

    if (!user) return null;

    // Treat user as onboarded if they have a completed business profile
    let onboardingComplete = user.onboardingComplete;
    if (!onboardingComplete) {
      const [biz] = await db
        .select()
        .from(businesses)
        .where(and(eq(businesses.userId, user.id), eq(businesses.onboardingComplete, true)))
        .limit(1);
      if (biz) onboardingComplete = true;
    }

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
