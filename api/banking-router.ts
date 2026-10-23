import { z } from "zod";
import { createRouter, authedQuery, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { bankingDetails } from "@db/schema";
import { eq, and, desc } from "drizzle-orm";
import {
  extractAdminRequestId,
  recordAdminMutationAudit,
} from "./lib/governance/admin-audit";

type BankingMethodKind = "bank_transfer" | "stripe" | "paypal" | "crypto";

/**
 * Classifies the receiving method from the fields present. Never derived
 * from secret-bearing values; used only as coarse audit metadata.
 */
function bankingMethodKind(input: {
  stripeAccountId?: string | null;
  paypalEmail?: string | null;
  cryptoWalletAddress?: string | null;
}): BankingMethodKind {
  if (input.stripeAccountId) return "stripe";
  if (input.paypalEmail) return "paypal";
  if (input.cryptoWalletAddress) return "crypto";
  return "bank_transfer";
}

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

      // Mutation + canonical audit evidence are one atomic unit. Audit
      // metadata records ONLY the method kind and default flag — never
      // account numbers, wallet addresses, or any credential material.
      let createdId = 0;
      const methodKind = bankingMethodKind(input);
      await db.transaction(async (tx) => {
        // If setting as default, unset other defaults
        if (input.isDefault) {
          await tx
            .update(bankingDetails)
            .set({ isDefault: false })
            .where(eq(bankingDetails.isDefault, true));
        }

        const [result] = await tx.insert(bankingDetails).values({
          adminUserId: ctx.user.id,
          ...input,
        });
        createdId = Number(result.insertId);

        await recordAdminMutationAudit({
          actorUserId: ctx.user.id,
          action: "admin.banking_detail_created",
          targetType: "banking_detail",
          targetId: createdId,
          occurredAt: new Date(),
          metadata: { isDefault: input.isDefault ?? false, methodKind },
          requestId: extractAdminRequestId(ctx.req),
          executor: tx,
        });
      });

      return { id: createdId, success: true };
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
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const { id, ...data } = input;

      // Field NAMES only in the audit metadata — values may carry account
      // numbers or credential material and must never reach the ledger.
      const changedFields = Object.keys(data).sort();
      await db.transaction(async (tx) => {
        if (data.isDefault) {
          await tx
            .update(bankingDetails)
            .set({ isDefault: false })
            .where(eq(bankingDetails.isDefault, true));
        }

        await tx
          .update(bankingDetails)
          .set(data)
          .where(eq(bankingDetails.id, id));

        await recordAdminMutationAudit({
          actorUserId: ctx.user.id,
          action: "admin.banking_detail_updated",
          targetType: "banking_detail",
          targetId: id,
          occurredAt: new Date(),
          metadata: { changedFields },
          requestId: extractAdminRequestId(ctx.req),
          executor: tx,
        });
      });

      return { success: true };
    }),

  // Delete banking detail (admin only)
  delete: adminQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      await db.transaction(async (tx) => {
        await tx
          .delete(bankingDetails)
          .where(eq(bankingDetails.id, input.id));

        await recordAdminMutationAudit({
          actorUserId: ctx.user.id,
          action: "admin.banking_detail_deleted",
          targetType: "banking_detail",
          targetId: input.id,
          occurredAt: new Date(),
          requestId: extractAdminRequestId(ctx.req),
          executor: tx,
        });
      });
      return { success: true };
    }),
});
