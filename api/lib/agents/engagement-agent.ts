import { z } from "zod";
import { runAgent } from "./runner";
import { getDb } from "../../queries/connection";
import { conversationThreads, conversationMessages, leads, leadActivities } from "@db/schema";
import { eq, and, desc } from "drizzle-orm";

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
}: {
  userId: number;
  campaignId: number;
  threadId: number;
  messageText: string;
  platform: string;
  businessContext: {
    name: string;
    productOrService?: string;
    brandTone?: string;
    mainGoal?: string;
  };
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
    campaignId,
    agentType: "engagement",
    prompt,
    schema: ReplySchema,
    system:
      "You are an expert customer service and sales engagement AI. You write natural, persuasive replies that build trust and move conversations toward conversion. You are careful with sensitive topics and always escalate when unsure. Always respond with valid structured data.",
  });

  // Save the AI reply
  await db.insert(conversationMessages).values({
    threadId,
    senderType: "ai",
    messageText: result.output.reply,
    aiGenerated: true,
    sentiment: result.output.sentiment,
  });

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

  return result;
}

export async function handleNewMessage({
  userId,
  campaignId,
  platform,
  externalThreadId,
  messageText,
  businessContext,
}: {
  userId: number;
  campaignId: number;
  platform: string;
  externalThreadId: string;
  messageText: string;
  businessContext: {
    name: string;
    productOrService?: string;
    brandTone?: string;
    mainGoal?: string;
  };
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

  // Save incoming message
  await db.insert(conversationMessages).values({
    threadId: thread.id,
    senderType: "lead",
    messageText,
    aiGenerated: false,
  });

  // Generate AI reply
  const result = await generateReply({
    userId,
    campaignId,
    threadId: thread.id,
    messageText,
    platform,
    businessContext,
  });

  return result;
}
