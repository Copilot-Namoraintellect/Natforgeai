import { z } from "zod";
import { createRouter, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { leads, leadActivities } from "@db/schema";
import { eq, and, desc } from "drizzle-orm";

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
});
