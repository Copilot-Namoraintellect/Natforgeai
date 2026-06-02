import { z } from "zod";
import { createRouter, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { leads, leadActivities } from "@db/schema";
import { eq, and, desc } from "drizzle-orm";
import { checkLimit, incrementResultUsage } from "./lib/subscription";
import { TRPCError } from "@trpc/server";

export const leadRouter = createRouter({
  list: authedQuery
    .input(
      z
        .object({
          status: z
            .enum([
              "new",
              "contacted",
              "qualified",
              "proposal",
              "negotiation",
              "won",
              "lost",
            ])
            .optional(),
          businessId: z.number().optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const results = await db
        .select()
        .from(leads)
        .where(eq(leads.userId, ctx.user.id))
        .orderBy(desc(leads.createdAt));

      return results.filter((lead) => {
        if (input?.status && lead.status !== input.status) return false;
        if (input?.businessId && lead.businessId !== input.businessId)
          return false;
        return true;
      });
    }),

  get: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const [lead] = await db
        .select()
        .from(leads)
        .where(
          and(eq(leads.id, input.id), eq(leads.userId, ctx.user.id))
        );
      return lead ?? null;
    }),

  create: authedQuery
    .input(
      z.object({
        name: z.string().min(1),
        email: z.string().optional(),
        phone: z.string().optional(),
        company: z.string().optional(),
        jobTitle: z.string().optional(),
        source: z.string().optional(),
        businessId: z.number().optional(),
        campaignId: z.number().optional(),
        score: z.number().optional(),
        notes: z.string().optional(),
        customFields: z.any().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [lead] = await db.insert(leads).values({
        userId: ctx.user.id,
        businessId: input.businessId,
        campaignId: input.campaignId,
        name: input.name,
        email: input.email,
        phone: input.phone,
        company: input.company,
        jobTitle: input.jobTitle,
        source: input.source,
        score: input.score ?? 0,
        notes: input.notes,
        customFields: input.customFields,
      });
      return { id: Number(lead.insertId), success: true };
    }),

  update: authedQuery
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).optional(),
        email: z.string().optional(),
        phone: z.string().optional(),
        company: z.string().optional(),
        jobTitle: z.string().optional(),
        status: z
          .enum([
            "new",
            "contacted",
            "qualified",
            "proposal",
            "negotiation",
            "won",
            "lost",
          ])
          .optional(),
        score: z.number().optional(),
        notes: z.string().optional(),
        lastContact: z.string().optional(),
        nextFollowUp: z.string().optional(),
        customFields: z.any().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const { id, lastContact, nextFollowUp, ...data } = input;

      // Check if lead status is changing to won and linked to a campaign
      if (data.status === "won") {
        const [current] = await db
          .select()
          .from(leads)
          .where(and(eq(leads.id, id), eq(leads.userId, ctx.user.id)))
          .limit(1);

        if (current && current.status !== "won" && current.campaignId) {
          const resultCheck = await checkLimit(ctx.user.id, "result");
          if (!resultCheck.allowed) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: resultCheck.reason!,
            });
          }
          await incrementResultUsage(ctx.user.id);
        }
      }

      const updateData: any = { ...data };
      if (lastContact) updateData.lastContact = new Date(lastContact);
      if (nextFollowUp) updateData.nextFollowUp = new Date(nextFollowUp);
      await db
        .update(leads)
        .set(updateData)
        .where(and(eq(leads.id, id), eq(leads.userId, ctx.user.id)));
      return { success: true };
    }),

  delete: authedQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      await db
        .delete(leads)
        .where(
          and(eq(leads.id, input.id), eq(leads.userId, ctx.user.id))
        );
      return { success: true };
    }),

  // Activities
  activities: authedQuery
    .input(z.object({ leadId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      return db
        .select()
        .from(leadActivities)
        .where(eq(leadActivities.leadId, input.leadId))
        .orderBy(desc(leadActivities.createdAt));
    }),

  addActivity: authedQuery
    .input(
      z.object({
        leadId: z.number(),
        type: z.enum([
          "note",
          "call",
          "email",
          "meeting",
          "task",
          "status_change",
        ]),
        description: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      await db.insert(leadActivities).values({
        leadId: input.leadId,
        type: input.type,
        description: input.description,
        createdBy: ctx.user.id,
      });
      return { success: true };
    }),

  // Auto-score lead based on engagement data
  autoScore: authedQuery
    .input(z.object({ leadId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [lead] = await db
        .select()
        .from(leads)
        .where(and(eq(leads.id, input.leadId), eq(leads.userId, ctx.user.id)))
        .limit(1);

      if (!lead) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Lead not found" });
      }

      // Get activities
      const activities = await db
        .select()
        .from(leadActivities)
        .where(eq(leadActivities.leadId, input.leadId));

      // Simple scoring algorithm
      let score = lead.score || 0;
      const activityCount = activities.length;

      // Base score from source
      const sourceScores: Record<string, number> = {
        instagram: 15,
        facebook: 15,
        linkedin: 25,
        tiktok: 10,
        twitter: 10,
        whatsapp: 30,
        email: 20,
        referral: 40,
        website: 35,
      };
      score += sourceScores[lead.source || ""] || 10;

      // Activity engagement
      score += activityCount * 5;

      // Contact info completeness
      if (lead.email) score += 10;
      if (lead.phone) score += 10;
      if (lead.company) score += 15;
      if (lead.jobTitle) score += 10;

      // Cap at 100
      score = Math.min(score, 100);

      // Auto-update status based on score
      let newStatus = lead.status;
      if (score >= 80 && lead.status === "new") {
        newStatus = "qualified";
      } else if (score >= 50 && lead.status === "new") {
        newStatus = "contacted";
      }

      await db
        .update(leads)
        .set({ score, status: newStatus })
        .where(eq(leads.id, input.leadId));

      if (newStatus !== lead.status) {
        await db.insert(leadActivities).values({
          leadId: input.leadId,
          type: "status_change",
          description: `Auto-updated status from ${lead.status} to ${newStatus} based on engagement score: ${score}`,
        });
      }

      return { success: true, score, status: newStatus };
    }),

  // Bulk auto-score all leads
  bulkAutoScore: authedQuery.mutation(async ({ ctx }) => {
    const db = getDb();
    const userLeads = await db
      .select()
      .from(leads)
      .where(eq(leads.userId, ctx.user.id));

    const results = [];
    for (const lead of userLeads) {
      const activities = await db
        .select()
        .from(leadActivities)
        .where(eq(leadActivities.leadId, lead.id));

      let score = lead.score || 0;
      const activityCount = activities.length;

      const sourceScores: Record<string, number> = {
        instagram: 15,
        facebook: 15,
        linkedin: 25,
        tiktok: 10,
        twitter: 10,
        whatsapp: 30,
        email: 20,
        referral: 40,
        website: 35,
      };
      score += sourceScores[lead.source || ""] || 10;
      score += activityCount * 5;
      if (lead.email) score += 10;
      if (lead.phone) score += 10;
      if (lead.company) score += 15;
      if (lead.jobTitle) score += 10;
      score = Math.min(score, 100);

      let newStatus = lead.status;
      if (score >= 80 && lead.status === "new") {
        newStatus = "qualified";
      } else if (score >= 50 && lead.status === "new") {
        newStatus = "contacted";
      }

      await db
        .update(leads)
        .set({ score, status: newStatus })
        .where(eq(leads.id, lead.id));

      if (newStatus !== lead.status) {
        await db.insert(leadActivities).values({
          leadId: lead.id,
          type: "status_change",
          description: `Auto-updated status from ${lead.status} to ${newStatus} based on engagement score: ${score}`,
        });
      }

      results.push({ id: lead.id, score, status: newStatus });
    }

    return { success: true, results };
  }),
});
