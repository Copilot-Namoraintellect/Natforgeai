import { z } from "zod";
import { createRouter, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { automations } from "@db/schema";
import { eq, and, desc } from "drizzle-orm";

export const automationRouter = createRouter({
  list: authedQuery.query(async ({ ctx }) => {
    const db = getDb();
    return db
      .select()
      .from(automations)
      .where(eq(automations.userId, ctx.user.id))
      .orderBy(desc(automations.createdAt));
  }),

  get: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const [a] = await db
        .select()
        .from(automations)
        .where(
          and(
            eq(automations.id, input.id),
            eq(automations.userId, ctx.user.id)
          )
        );
      return a ?? null;
    }),

  create: authedQuery
    .input(
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        trigger: z.enum([
          "new_lead",
          "new_message",
          "new_purchase",
          "form_submit",
          "schedule",
          "manual",
        ]),
        actions: z.array(z.any()),
        businessId: z.number().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [a] = await db.insert(automations).values({
        userId: ctx.user.id,
        businessId: input.businessId,
        name: input.name,
        description: input.description,
        trigger: input.trigger,
        actions: input.actions,
        isActive: false,
      });
      return { id: Number(a.insertId), success: true };
    }),

  update: authedQuery
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        trigger: z
          .enum([
            "new_lead",
            "new_message",
            "new_purchase",
            "form_submit",
            "schedule",
            "manual",
          ])
          .optional(),
        actions: z.array(z.any()).optional(),
        isActive: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const { id, ...data } = input;
      await db
        .update(automations)
        .set(data)
        .where(
          and(eq(automations.id, id), eq(automations.userId, ctx.user.id))
        );
      return { success: true };
    }),

  delete: authedQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      await db
        .delete(automations)
        .where(
          and(
            eq(automations.id, input.id),
            eq(automations.userId, ctx.user.id)
          )
        );
      return { success: true };
    }),

  toggle: authedQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [auto] = await db
        .select()
        .from(automations)
        .where(
          and(
            eq(automations.id, input.id),
            eq(automations.userId, ctx.user.id)
          )
        );
      if (!auto) return { success: false };
      await db
        .update(automations)
        .set({ isActive: !auto.isActive })
        .where(eq(automations.id, input.id));
      return { success: true, isActive: !auto.isActive };
    }),
});
