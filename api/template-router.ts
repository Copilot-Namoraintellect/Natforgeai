import { z } from "zod";
import { createRouter, authedQuery, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { templates } from "@db/schema";
import { eq, and, desc } from "drizzle-orm";

export const templateRouter = createRouter({
  list: publicQuery
    .input(
      z
        .object({
          category: z
            .enum([
              "strategy",
              "content",
              "ads",
              "design",
              "video",
              "targeting",
              "scheduling",
              "chatbot",
              "crm",
              "automation",
            ])
            .optional(),
        })
        .optional()
    )
    .query(async ({ input }) => {
      const db = getDb();
      const results = await db
        .select()
        .from(templates)
        .where(eq(templates.isDefault, true))
        .orderBy(templates.category);

      if (input?.category) {
        return results.filter((t) => t.category === input.category);
      }
      return results;
    }),

  myTemplates: authedQuery.query(async ({ ctx }) => {
    const db = getDb();
    return db
      .select()
      .from(templates)
      .where(eq(templates.userId, ctx.user.id))
      .orderBy(desc(templates.createdAt));
  }),

  get: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const [t] = await db
        .select()
        .from(templates)
        .where(
          and(
            eq(templates.id, input.id),
            eq(templates.userId, ctx.user.id)
          )
        );
      return t ?? null;
    }),

  create: authedQuery
    .input(
      z.object({
        name: z.string().min(1),
        category: z.enum([
          "strategy",
          "content",
          "ads",
          "design",
          "video",
          "targeting",
          "scheduling",
          "chatbot",
          "crm",
          "automation",
        ]),
        description: z.string().optional(),
        prompt: z.string().min(1),
        variables: z.array(z.any()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [t] = await db.insert(templates).values({
        userId: ctx.user.id,
        name: input.name,
        category: input.category,
        description: input.description,
        prompt: input.prompt,
        variables: input.variables,
        isDefault: false,
      });
      return { id: Number(t.insertId), success: true };
    }),

  update: authedQuery
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        prompt: z.string().optional(),
        variables: z.array(z.any()).optional(),
        isFavorite: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const { id, ...data } = input;
      await db
        .update(templates)
        .set(data)
        .where(
          and(eq(templates.id, id), eq(templates.userId, ctx.user.id))
        );
      return { success: true };
    }),

  delete: authedQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      await db
        .delete(templates)
        .where(
          and(
            eq(templates.id, input.id),
            eq(templates.userId, ctx.user.id)
          )
        );
      return { success: true };
    }),
});
