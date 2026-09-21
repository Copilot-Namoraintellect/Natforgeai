import { z } from "zod";
import { runAgent } from "./runner";
import { getDb } from "../../queries/connection";
import { conversationThreads, conversationMessages, leads, leadActivities } from "@db/schema";
import { eq, and, desc } from "drizzle-orm";
import { isMySqlDuplicateKeyError } from "../billing/credit-engine";
import { buildSensitiveReplyApprovalRequest } from "../engagement/sensitive-reply-approval";
import {
  createOrReuseSensitiveReplyApproval,
  type SensitiveReplyApprovalExecutor,
} from "../engagement/sensitive-reply-approval-store";

const ReplySchema = z.object({
  reply: z.string(),
  shouldQualify: z.boolean(),
  qualificationQuestions: z.array(z.string()).optional(),
  leadScore: z.number().min(0).max(100).optional(),
  shouldEscalate: z.boolean(),
  escalationReason: z.string().optional(),
  sentiment: z.enum(["positive", "neutral", "negative", "urgent"]),
  extractedData: z.object({
    name: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    company: z.string().optional(),
    interest: z.string().optional(),
    budget: z.string().optional(),
  }).optional(),
});

export type ReplyOutput = z.infer<typeof ReplySchema>;

export async function generateReply({
  userId,
  campaignId,
  threadId,
  messageText,
  platform,
  businessContext,
  dedupKey,
  approvalExecutor,
}: {
  userId: number;
  campaignId: number | null;
  threadId: number;
  messageText: string;
  platform: string;
  businessContext: {
    name: string;
    productOrService?: string;
    brandTone?: string;
    mainGoal?: string;
  };
  /** Event-scoped idempotency key; when set, the persisted AI reply is deduplicated per event. */
  dedupKey?: string;
  /**
   * Optional test seam for the sensitive-reply approval bridge; production
   * callers omit this and the durable store uses its drizzle executor.
   */
  approvalExecutor?: SensitiveReplyApprovalExecutor;
}) {
  const db = getDb();

  // Get conversation history
  const messages = await db
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.threadId, threadId))
    .orderBy(desc(conversationMessages.createdAt))
    .limit(10);

  const conversationHistory = messages
    .reverse()
    .map((m) => `${m.senderType}: ${m.messageText}`)
    .join("\n");

  const prompt = `You are a professional customer engagement specialist for ${businessContext.name}. 

BUSINESS CONTEXT:
- Product/Service: ${businessContext.productOrService || "Not specified"}
- Brand Tone: ${businessContext.brandTone || "professional"}
- Main Goal: ${businessContext.mainGoal || "Convert prospects to customers"}
- Platform: ${platform}

CONVERSATION HISTORY:
${conversationHistory}

NEW INCOMING MESSAGE:
"""
${messageText}
"""

Your task:
1. Write a natural, helpful reply that matches the brand tone
2. Determine if this is a lead qualification opportunity
3. Score the lead potential (0-100)
4. Decide if escalation to a human is needed
5. Extract any contact/company information
6. Assess sentiment

Guidelines:
- Be conversational but professional
- Ask follow-up questions to qualify prospects
- Never make false claims or promises
- If pricing is asked, give ranges or ask for a call
- If sensitive/unclear, escalate to human
- Keep replies concise for ${platform}

Respond with structured data.`;

  const result = await runAgent({
    userId,
    campaignId: campaignId ?? undefined,
    agentType: "engagement",
    prompt,
    schema: ReplySchema,
    system:
      "You are an expert customer service and sales engagement AI. You write natural, persuasive replies that build trust and move conversations toward conversion. You are careful with sensitive topics and always escalate when unsure. Always respond with valid structured data.",
  });

  // Save the AI reply. When driven by the inbound pipeline's event-scoped
  // dedupKey, a recovery retry of an event whose reply was already persisted
  // must not write a second proposal.
  try {
    await db.insert(conversationMessages).values({
      threadId,
      senderType: "ai",
      messageText: result.output.reply,
      aiGenerated: true,
      sentiment: result.output.sentiment,
      dedupKey: dedupKey ? `${dedupKey}:ai-reply` : null,
    });
  } catch (err: any) {
    if (!dedupKey || !isMySqlDuplicateKeyError(err)) throw err;
    // Reply proposal already recorded for this event; continue with the
    // thread update and lead linkage below.
  }

  // Update thread
  const threadUpdates: any = {
    aiHandled: true,
  };
  if (result.output.shouldEscalate) {
    threadUpdates.status = "escalated";
    threadUpdates.escalationRequired = true;
  } else if (result.output.shouldQualify) {
    threadUpdates.status = "ai_handled";
  }

  await db
    .update(conversationThreads)
    .set(threadUpdates)
    .where(eq(conversationThreads.id, threadId));

  // Create or update lead if qualified
  if (result.output.shouldQualify && result.output.extractedData) {
    const data = result.output.extractedData;
    const [existingLead] = await db
      .select()
      .from(leads)
      .where(
        and(
          eq(leads.userId, userId),
          data.email ? eq(leads.email, data.email) : undefined
        )
      )
      .limit(1);

    if (!existingLead && (data.name || data.email)) {
      const [leadResult] = await db.insert(leads).values({
        userId,
        campaignId,
        name: data.name || "Unknown",
        email: data.email || null,
        phone: data.phone || null,
        company: data.company || null,
        source: platform,
        status: "new",
        score: result.output.leadScore || 0,
        notes: `Interest: ${data.interest || "Not specified"}\nBudget: ${data.budget || "Not specified"}`,
      });

      const leadId = Number(leadResult.insertId);

      // Link thread to lead
      await db
        .update(conversationThreads)
        .set({ leadId })
        .where(eq(conversationThreads.id, threadId));

      // Log activity
      await db.insert(leadActivities).values({
        leadId,
        type: "note",
        description: `Lead created from ${platform} conversation. AI scored: ${result.output.leadScore}/100`,
      });
    }
  }

  // Durable sensitive-reply approval bridge (WBS14B). Only escalated,
  // event-scoped invocations create an approval: without a dedupKey there is
  // no replay-safe approval identity (e.g. the manual runEngagementAgent
  // path). The store keys on the WBS14A hashed idempotency key, so a webhook
  // recovery replay reuses the same request instead of duplicating it. The
  // proposed reply stays a proposal — zero outbound dispatch.
  if (result.output.shouldEscalate && dedupKey) {
    const approvalCommand = buildSensitiveReplyApprovalRequest({
      userId,
      campaignId,
      threadId,
      dedupKey,
      proposedReply: result.output.reply,
      escalationReason: result.output.escalationReason,
      sentiment: result.output.sentiment,
    });
    await createOrReuseSensitiveReplyApproval(
      approvalCommand,
      approvalExecutor
    );
  }

  return result;
}

export async function handleNewMessage({
  userId,
  campaignId,
  platform,
  externalThreadId,
  messageText,
  businessContext,
  dedupKey,
  approvalExecutor,
}: {
  userId: number;
  campaignId: number | null;
  platform: string;
  externalThreadId: string;
  messageText: string;
  businessContext: {
    name: string;
    productOrService?: string;
    brandTone?: string;
    mainGoal?: string;
  };
  /**
   * Event-scoped idempotency key (e.g. `<provider>:<externalEventId>`).
   * When set, the persisted inbound message and the AI reply proposal are
   * deduplicated per event, so a pipeline recovery retry cannot duplicate
   * them even if the original attempt failed partway through.
   */
  dedupKey?: string;
  /** Optional test seam forwarded to the sensitive-reply approval bridge. */
  approvalExecutor?: SensitiveReplyApprovalExecutor;
}) {
  const db = getDb();

  // Find or create thread
  let [thread] = await db
    .select()
    .from(conversationThreads)
    .where(
      and(
        eq(conversationThreads.userId, userId),
        eq(conversationThreads.externalThreadId, externalThreadId),
        eq(conversationThreads.platform, platform)
      )
    )
    .limit(1);

  if (!thread) {
    const [result] = await db.insert(conversationThreads).values({
      userId,
      campaignId,
      platform,
      externalThreadId,
      status: "open",
    });
    const threadId = Number(result.insertId);
    thread = {
      id: threadId,
      userId,
      campaignId,
      platform,
      externalThreadId,
      status: "open",
      aiHandled: false,
      escalationRequired: false,
    } as any;
  }

  // Save incoming message. The (threadId, dedupKey) unique index makes this
  // insert idempotent per webhook event: a recovery retry of an event whose
  // inbound message was already recorded skips the re-insert.
  try {
    await db.insert(conversationMessages).values({
      threadId: thread.id,
      senderType: "lead",
      messageText,
      aiGenerated: false,
      dedupKey: dedupKey ?? null,
    });
  } catch (err: any) {
    if (!dedupKey || !isMySqlDuplicateKeyError(err)) throw err;
    // Inbound message already recorded for this event (retry path).
  }

  // Generate AI reply
  const result = await generateReply({
    userId,
    campaignId,
    threadId: thread.id,
    messageText,
    platform,
    businessContext,
    dedupKey,
    approvalExecutor,
  });

  return { threadId: thread.id, result };
}
