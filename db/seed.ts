import { getDb } from "../api/queries/connection";
import { templates } from "./schema";
import { eq } from "drizzle-orm";

const defaultTemplates = [
  {
    name: "Master Campaign Strategy",
    category: "strategy" as const,
    description: "Convert any marketing strategy into a full execution-ready campaign",
    prompt: `You are a senior marketing strategist.

Take the following marketing strategy and convert it into a complete, execution-ready campaign.

OUTPUT MUST INCLUDE:
1. Target audience (detailed personas)
2. Core messaging (value propositions + hooks)
3. 30-day content calendar (daily posts)
4. 10 high-converting ad concepts
5. Platform-specific strategy (Instagram, TikTok, LinkedIn, Facebook)
6. Lead generation funnel (from post → conversion)
7. Suggested offers and pricing hooks
8. CTA strategy per platform

Business: {{business}}
Goal: {{goal}}
Target market: {{targetMarket}}
Tone: {{tone}}

Return in a structured format ready for execution.`,
    variables: [{ name: "business", label: "Business Name", required: true }, { name: "goal", label: "Campaign Goal", required: true }, { name: "targetMarket", label: "Target Market", required: true }, { name: "tone", label: "Tone", required: true }],
    isDefault: true,
  },
  {
    name: "Social Media Posts",
    category: "content" as const,
    description: "Generate 10 high-converting social media posts",
    prompt: `Create 10 high-converting social media posts for {{business}}.

Requirements:
- Platform: {{platform}}
- Audience: {{audience}}
- Tone: {{tone}}
- Include hooks, captions, and CTAs
- Include emojis where relevant
- Focus on driving action (not just engagement)

Output format:
Post 1:
Hook:
Caption:
CTA:`,
    variables: [{ name: "business", label: "Business Name", required: true }, { name: "platform", label: "Platform", required: true }, { name: "audience", label: "Target Audience", required: true }, { name: "tone", label: "Tone", required: true }],
    isDefault: true,
  },
  {
    name: "Ad Copy Generator",
    category: "ads" as const,
    description: "Create 5 high-converting paid ad copies",
    prompt: `Create 5 high-converting paid ad copies for {{business}}.

Goal: {{goal}}

Include:
- Scroll-stopping headline
- Pain point
- Solution
- CTA

Keep it short, punchy, and conversion-focused.`,
    variables: [{ name: "business", label: "Business Name", required: true }, { name: "goal", label: "Goal", required: true }],
    isDefault: true,
  },
  {
    name: "Canva Design Prompt",
    category: "design" as const,
    description: "Generate Canva design specifications for social media",
    prompt: `Create a modern, premium social media design for:

Business: {{business}}
Offer: {{offer}}
Target audience: {{audience}}

Style:
- Clean, bold typography
- High contrast
- Professional retail look
- Include price highlight and CTA

Format:
- Instagram post
- Also adaptable to story and poster

Text to include:
{{text}}`,
    variables: [{ name: "business", label: "Business Name", required: true }, { name: "offer", label: "Offer/Promotion", required: true }, { name: "audience", label: "Target Audience", required: true }, { name: "text", label: "Text to Include", required: true }],
    isDefault: true,
  },
  {
    name: "Video Script Generator",
    category: "video" as const,
    description: "Create short-form marketing video scripts (15-30 seconds)",
    prompt: `Create a short-form marketing video script (15-30 seconds):

Business: {{business}}
Goal: {{goal}}

Structure:
1. Hook (first 3 seconds – attention grabbing)
2. Problem
3. Solution (your product/service)
4. Offer
5. CTA

Style:
- Fast-paced
- Social media optimized (TikTok/Reels)
- Subtitles included

Tone:
- Engaging, modern, high-energy`,
    variables: [{ name: "business", label: "Business Name", required: true }, { name: "goal", label: "Goal", required: true }],
    isDefault: true,
  },
  {
    name: "Meta Ads Targeting",
    category: "targeting" as const,
    description: "Define high-performing target audiences for Meta Ads",
    prompt: `Define a high-performing target audience for:

Business: {{business}}
Location: {{location}}

Include:
- Interests
- Behaviors
- Demographics
- Lookalike suggestions

Goal: {{goal}}

Also suggest exclusions to improve ad performance.`,
    variables: [{ name: "business", label: "Business Name", required: true }, { name: "location", label: "Location", required: true }, { name: "goal", label: "Goal", required: true }],
    isDefault: true,
  },
  {
    name: "B2B Lead Targeting",
    category: "targeting" as const,
    description: "Define ideal customer profiles for B2B lead generation",
    prompt: `Define ideal customer profile for:

Business: {{business}}

Target: {{target}}

Include:
- Job titles to target
- Company size
- Industry filters
- Pain points

Output format ready for Apollo search filters.`,
    variables: [{ name: "business", label: "Business Name", required: true }, { name: "target", label: "Target Segment", required: true }],
    isDefault: true,
  },
  {
    name: "Posting Schedule",
    category: "scheduling" as const,
    description: "Organize content into an optimal posting schedule",
    prompt: `Organize the following content into a posting schedule:

Platform: {{platform}}
Frequency: {{frequency}}

Include:
- Best posting times
- Content mix (educational / promotional / engagement)
- Caption + hashtags

Return as a weekly schedule.`,
    variables: [{ name: "platform", label: "Platform", required: true }, { name: "frequency", label: "Frequency", required: true }],
    isDefault: true,
  },
  {
    name: "Chatbot Auto-Reply",
    category: "chatbot" as const,
    description: "Create chatbot auto-reply conversation flows",
    prompt: `You are a sales assistant for {{business}}.

When a customer messages:
- Be friendly and helpful
- Qualify their need
- Guide them to purchase

Flow:
1. Greet
2. Ask what they need
3. Recommend solution
4. Provide price
5. Push to action (visit store / WhatsApp / payment)

Keep responses short and natural.`,
    variables: [{ name: "business", label: "Business Name", required: true }],
    isDefault: true,
  },
  {
    name: "Lead Closing Script",
    category: "chatbot" as const,
    description: "High-converting lead closing conversation scripts",
    prompt: `Act as a high-converting sales agent.

Convert the following lead into a customer:

Customer message: {{message}}

Respond:
- Confidently
- Address objections
- Emphasize value
- Close with a clear next step`,
    variables: [{ name: "message", label: "Customer Message", required: true }],
    isDefault: true,
  },
  {
    name: "CRM Follow-up Sequence",
    category: "crm" as const,
    description: "Create multi-step follow-up email sequences",
    prompt: `Create a 5-step follow-up sequence for leads who did not convert.

Business: {{business}}

Include:
- Day 1, Day 2, Day 4, Day 7, Day 14
- Mix of urgency, value, and reminders
- Friendly, not spammy

Goal: Convert leads into paying customers.`,
    variables: [{ name: "business", label: "Business Name", required: true }],
    isDefault: true,
  },
  {
    name: "Automation Workflow",
    category: "automation" as const,
    description: "Design Zapier/Make automation workflows",
    prompt: `Design an automation workflow for {{business}}.

Trigger: {{trigger}}

Actions:
- Send WhatsApp message
- Add to CRM
- Notify sales team

Keep it simple, scalable, and efficient.`,
    variables: [{ name: "business", label: "Business Name", required: true }, { name: "trigger", label: "Trigger", required: true }],
    isDefault: true,
  },
  {
    name: "Daily Power Prompt",
    category: "strategy" as const,
    description: "Get daily AI-powered marketing action plans",
    prompt: `Act as my AI marketing manager for {{business}}.

Based on today's goals: {{goals}}

Tell me:
1. What to post today
2. Who to target
3. What message to use
4. How to convert leads

Be direct, practical, and execution-focused.`,
    variables: [{ name: "business", label: "Business Name", required: true }, { name: "goals", label: "Today's Goals", required: true }],
    isDefault: true,
  },
];

async function seed() {
  const db = getDb();
  console.log("Seeding default templates...");

  for (const template of defaultTemplates) {
    const existing = await db
      .select()
      .from(templates)
      .where(eq(templates.name, template.name));

    if (existing.length === 0) {
      await db.insert(templates).values({
        userId: null,
        name: template.name,
        category: template.category,
        description: template.description,
        prompt: template.prompt,
        variables: template.variables as any,
        isDefault: template.isDefault,
      });
      console.log(`Created template: ${template.name}`);
    }
  }

  console.log("Seed complete!");
}

seed().catch(console.error);
