import { z } from "zod";
import { runAgent } from "./runner";
import { getDb } from "../../queries/connection";
import { campaigns, leads, leadActivities } from "@db/schema";
import { eq, and } from "drizzle-orm";

const FollowUpSequenceSchema = z.object({
  messages: z.array(
    z.object({
      day: z.number(),
      channel: z.enum(["email", "whatsapp", "sms"]),
      subject: z.string().optional(),
      body: z.string(),
      cta: z.string(),
      purpose: z.string(),
    })
  ),
});

const ProposalDraftSchema = z.object({
  title: z.string(),
  introduction: z.string(),
  problemStatement: z.string(),
  solution: z.string(),
  deliverables: z.array(z.string()),
  timeline: z.string(),
  pricing: z.object({
    packageName: z.string(),
    amount: z.number(),
    currency: z.string(),
    terms: z.string(),
  }),
  testimonials: z.array(z.string()).optional(),
  nextSteps: z.array(z.string()),
  closing: z.string(),
});

const MeetingPromptSchema = z.object({
  subject: z.string(),
  body: z.string(),
  proposedTimes: z.array(z.string()),
  duration: z.string(),
  agenda: z.array(z.string()),
});

export type FollowUpSequenceOutput = z.infer<typeof FollowUpSequenceSchema>;
export type ProposalDraftOutput = z.infer<typeof ProposalDraftSchema>;
export type MeetingPromptOutput = z.infer<typeof MeetingPromptSchema>;

export async function generateFollowUpSequence({
  userId,
  campaignId,
  leadId,
  channel = "email",
}: {
  userId: number;
  campaignId: number;
  leadId: number;
  channel?: "email" | "whatsapp" | "sms";
}) {
  const db = getDb();

  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);

  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.userId, userId)))
    .limit(1);

  if (!lead) throw new Error("Lead not found");

  const prompt = `You are a sales follow-up expert. Create a 5-day follow-up sequence for this lead.

CAMPAIGN:
- Name: ${campaign?.name || "Not specified"}
- Goal: ${campaign?.goal || "Not specified"}
- Core Message: ${campaign?.coreMessage || "Not specified"}

LEAD:
- Name: ${lead.name}
- Company: ${lead.company || "Not specified"}
- Job Title: ${lead.jobTitle || "Not specified"}
- Source: ${lead.source || "Not specified"}
- Score: ${lead.score || 0}/100
- Notes: ${lead.notes || "None"}

CHANNEL: ${channel}

Create a sequence that:
- Day 1: Thank you / introduction
- Day 2: Value-add content
- Day 3: Social proof / case study
- Day 4: Address objections
- Day 5: Final call-to-action

Each message should be personalized, concise, and have a clear CTA.

Respond with structured data.`;

  const result = await runAgent({
    userId,
    campaignId,
    agentType: "sales",
    prompt,
    schema: FollowUpSequenceSchema,
    system:
      "You are an expert sales copywriter who creates high-converting follow-up sequences. You understand buyer psychology and craft messages that build trust and drive action. Always respond with valid structured data.",
  });

  // Log activity
  await db.insert(leadActivities).values({
    leadId,
    type: "email",
    description: `AI-generated ${channel} follow-up sequence (${result.output.messages.length} messages)`,
  });

  return result;
}

export async function generateProposal({
  userId,
  campaignId,
  leadId,
}: {
  userId: number;
  campaignId: number;
  leadId: number;
}) {
  const db = getDb();

  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);

  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.userId, userId)))
    .limit(1);

  if (!lead) throw new Error("Lead not found");

  const prompt = `You are a proposal writer. Create a professional sales proposal for this lead.

CAMPAIGN:
- Name: ${campaign?.name || "Not specified"}
- Goal: ${campaign?.goal || "Not specified"}
- Core Message: ${campaign?.coreMessage || "Not specified"}

LEAD:
- Name: ${lead.name}
- Company: ${lead.company || "Not specified"}
- Job Title: ${lead.jobTitle || "Not specified"}
- Interest: ${lead.notes || "Not specified"}

Create a complete proposal with:
1. Compelling title
2. Introduction addressing the lead
3. Problem statement
4. Solution overview
5. List of deliverables
6. Timeline
7. Pricing (use realistic placeholder numbers)
8. Next steps
9. Professional closing

Respond with structured data.`;

  const result = await runAgent({
    userId,
    campaignId,
    agentType: "sales",
    prompt,
    schema: ProposalDraftSchema,
    system:
      "You are an expert proposal writer who creates compelling, professional sales proposals. You structure proposals to address client needs and drive closing decisions. Always respond with valid structured data.",
  });

  // Log activity
  await db.insert(leadActivities).values({
    leadId,
    type: "email",
    description: `AI-generated proposal draft: ${result.output.title}`,
  });

  return result;
}

export async function generateMeetingPrompt({
  userId,
  campaignId,
  leadId,
}: {
  userId: number;
  campaignId: number;
  leadId: number;
}) {
  const db = getDb();

  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);

  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.userId, userId)))
    .limit(1);

  if (!lead) throw new Error("Lead not found");

  const prompt = `You are a meeting booking specialist. Write a meeting invitation for this lead.

CAMPAIGN:
- Name: ${campaign?.name || "Not specified"}
- Goal: ${campaign?.goal || "Not specified"}

LEAD:
- Name: ${lead.name}
- Company: ${lead.company || "Not specified"}
- Job Title: ${lead.jobTitle || "Not specified"}

Create:
1. Subject line
2. Body text (friendly but professional)
3. 3 proposed meeting times
4. Meeting duration
5. Agenda items

Respond with structured data.`;

  const result = await runAgent({
    userId,
    campaignId,
    agentType: "sales",
    prompt,
    schema: MeetingPromptSchema,
    system:
      "You are an expert at booking sales meetings. You write concise, persuasive meeting invitations that get responses. Always respond with valid structured data.",
  });

  // Log activity
  await db.insert(leadActivities).values({
    leadId,
    type: "email",
    description: `AI-generated meeting booking prompt`,
  });

  return result;
}
