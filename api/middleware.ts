import { ErrorMessages } from "@contracts/constants";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { rateLimitPublic, rateLimitUser } from "./lib/rate-limiter";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const createRouter = t.router;
export const publicQuery = t.procedure;

const requireAuth = t.middleware(async (opts) => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: ErrorMessages.unauthenticated,
    });
  }

  if (!ctx.session?.verified) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Verification required. Please complete OTP/2FA verification to access this resource.",
    });
  }

  return next({ ctx: { ...ctx, user: ctx.user } });
});

function requireRole(role: string) {
  return t.middleware(async (opts) => {
    const { ctx, next } = opts;

    if (!ctx.user || ctx.user.role !== role) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: ErrorMessages.insufficientRole,
      });
    }

    return next({ ctx: { ...ctx, user: ctx.user } });
  });
}

// Rate limiting middlewares
const rateLimitPublicMiddleware = t.middleware(async (opts) => {
  await rateLimitPublic(opts.ctx, 60, 60_000); // 60 requests/minute per IP
  return opts.next();
});

const rateLimitUserMiddleware = t.middleware(async (opts) => {
  await rateLimitUser(opts.ctx, "api");
  return opts.next();
});

const rateLimitAIMiddleware = t.middleware(async (opts) => {
  await rateLimitUser(opts.ctx, "ai");
  return opts.next();
});

const rateLimitPublishMiddleware = t.middleware(async (opts) => {
  await rateLimitUser(opts.ctx, "publish");
  return opts.next();
});

export const authedQuery = t.procedure.use(requireAuth);
export const adminQuery = authedQuery.use(requireRole("admin"));

// Rate-limited variants
export const publicQueryLimited = t.procedure.use(rateLimitPublicMiddleware);
export const authedQueryLimited = t.procedure.use(requireAuth).use(rateLimitUserMiddleware);
export const aiActionQuery = t.procedure.use(requireAuth).use(rateLimitAIMiddleware);
export const publishActionQuery = t.procedure.use(requireAuth).use(rateLimitPublishMiddleware);
