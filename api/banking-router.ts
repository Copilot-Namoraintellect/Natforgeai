import { z } from "zod";
import { createRouter, authedQuery, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { bankingDetails } from "@db/schema";
import { eq, and, desc } from "drizzle-orm";

export const bankingRouter = createRouter({
  // Get all banking details (admin only)
  list: adminQuery.query(async () => {
    const db = getDb();
    return db
      .select()
      .from(bankingDetails)
      .orderBy(desc(bankingDetails.createdAt));
  }),

  // Get default/active banking details (public)
  default: authedQuery.query(async () => {
    const db = getDb();
    const [detail] = await db
      .select()
      .from(bankingDetails)
      .where(and(eq(bankingDetails.isActive, true), eq(bankingDetails.isDefault, true)))
      .limit(1);
    return detail || null;
  }),

  // Create banking detail (admin only)
  create: adminQuery
    .input(
      z.object({
        accountName: z.string().optional(),
        bankName: z.string().optional(),
        accountNumber: z.string().optional(),
        accountType: z.enum(["checking", "savings", "business"]).optional(),
        branchCode: z.string().optional(),
        swiftCode: z.string().optional(),
        iban: z.string().optional(),
        routingNumber: z.string().optional(),
        stripeAccountId: z.string().optional(),
        paypalEmail: z.string().optional(),
        cryptoWalletAddress: z.string().optional(),
        cryptoNetwork: z.string().optional(),
        isDefault: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();

      // If setting as default, unset other defaults
      if (input.isDefault) {
        await db
          .update(bankingDetails)
          .set({ isDefault: false })
          .where(eq(bankingDetails.isDefault, true));
      }

      const [result] = await db.insert(bankingDetails).values({
        adminUserId: ctx.user.id,
        ...input,
      });

      return { id: Number(result.insertId), success: true };
    }),

  // Update banking detail (admin only)
  update: adminQuery
    .input(
      z.object({
        id: z.number(),
        accountName: z.string().optional(),
        bankName: z.string().optional(),
        accountNumber: z.string().optional(),
        accountType: z.enum(["checking", "savings", "business"]).optional(),
        branchCode: z.string().optional(),
        swiftCode: z.string().optional(),
        iban: z.string().optional(),
        routingNumber: z.string().optional(),
        stripeAccountId: z.string().optional(),
        paypalEmail: z.string().optional(),
        cryptoWalletAddress: z.string().optional(),
        cryptoNetwork: z.string().optional(),
        isDefault: z.boolean().optional(),
        isActive: z.boolean().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { id, ...data } = input;

      if (data.isDefault) {
        await db
          .update(bankingDetails)
          .set({ isDefault: false })
          .where(eq(bankingDetails.isDefault, true));
      }

      await db
        .update(bankingDetails)
        .set(data)
        .where(eq(bankingDetails.id, id));

      return { success: true };
    }),

  // Delete banking detail (admin only)
  delete: adminQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db
        .delete(bankingDetails)
        .where(eq(bankingDetails.id, input.id));
      return { success: true };
    }),
});
