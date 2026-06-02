import { z } from "zod";
import { createRouter, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { conversationThreads, conversationMessages, leads } from "@db/schema";
import { eq, and, desc } from "drizzle-orm";
import { TRPCError } from "@trpc/server";

export const conversationRouter = createRouter({
  listThreads: authedQuery
    .input(
      z
        .object({
          campaignId: z.number().optional(),
          status: z.enum(["open", "ai_handled", "escalated", "closed"]).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const results = await db
        .select()
        .from(conversationThreads)
        .where(eq(conversationThreads.userId, ctx.user.id))
        .orderBy(desc(conversationThreads.createdAt));

      return results.filter((thread) => {
        if (input?.campaignId && thread.campaignId !== input.campaignId) return false;
        if (input?.status && thread.status !== input.status) return false;
        return true;
      });
    }),

  readThread: authedQuery
    .input(z.object({ threadId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = getDb();

      const [thread] = await db
        .select()
        .from(conversationThreads)
        .where(
          and(
            eq(conversationThreads.id, input.threadId),
            eq(conversationThreads.userId, ctx.user.id)
          )
        )
        .limit(1);

      if (!thread) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Thread not found" });
      }

      const messages = await db
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.threadId, input.threadId))
        .orderBy(desc(conversationMessages.createdAt));

      return { thread, messages };
    }),

  aiReply: authedQuery
    .input(
      z.object({
        threadId: z.number(),
        messageText: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();

      const [thread] = await db
        .select()
        .from(conversationThreads)
        .where(
          and(
            eq(conversationThreads.id, input.threadId),
            eq(conversationThreads.userId, ctx.user.id)
          )
        )
        .limit(1);

      if (!thread) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Thread not found" });
      }

      await db.insert(conversationMessages).values({
        threadId: input.threadId,
        senderType: "ai",
        messageText: input.messageText,
        aiGenerated: true,
      });

      await db
        .update(conversationThreads)
        .set({ aiHandled: true })
        .where(eq(conversationThreads.id, input.threadId));

      return { success: true };
    }),

  escalateThread: authedQuery
    .input(z.object({ threadId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();

      const [thread] = await db
        .select()
        .from(conversationThreads)
        .where(
          and(
            eq(conversationThreads.id, input.threadId),
            eq(conversationThreads.userId, ctx.user.id)
          )
        )
        .limit(1);

      if (!thread) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Thread not found" });
      }

      await db
        .update(conversationThreads)
        .set({
          status: "escalated",
          escalationRequired: true,
        })
        .where(eq(conversationThreads.id, input.threadId));

      return { success: true };
    }),

  convertThreadToLead: authedQuery
    .input(
      z.object({
        threadId: z.number(),
        leadData: z.object({
          name: z.string().min(1),
          email: z.string().email().optional(),
          phone: z.string().optional(),
          company: z.string().optional(),
          source: z.string().optional(),
        }),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();

      const [thread] = await db
        .select()
        .from(conversationThreads)
        .where(
          and(
            eq(conversationThreads.id, input.threadId),
            eq(conversationThreads.userId, ctx.user.id)
          )
        )
        .limit(1);

      if (!thread) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Thread not found" });
      }

      const [leadResult] = await db.insert(leads).values({
        userId: ctx.user.id,
        campaignId: thread.campaignId,
        name: input.leadData.name,
        email: input.leadData.email || null,
        phone: input.leadData.phone || null,
        company: input.leadData.company || null,
        source: input.leadData.source || thread.platform,
        status: "new",
      });

      const leadId = Number(leadResult.insertId);

      await db
        .update(conversationThreads)
        .set({ leadId })
        .where(eq(conversationThreads.id, input.threadId));

      return { success: true, leadId };
    }),
});
