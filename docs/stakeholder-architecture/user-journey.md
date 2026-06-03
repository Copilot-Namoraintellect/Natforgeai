# User Journey — NatForge AI

## Overview

This document describes the complete end-to-end user journey from first visit to autonomous campaign execution. It covers both the **assisted mode** (human reviews every step) and **autonomous mode** (AI executes with minimal intervention).

---

## 1. Registration

**Entry points:**
- Direct registration with username/email/password
- Google OAuth (one-click signup)
- Firebase Auth (phone/password)

**Flow:**
1. User visits `/login`
2. Chooses registration method
3. Account created with `role = "user"`
4. Auto-assigned **Free tier** subscription
5. Credit wallet created with 50 monthly credits
6. Redirected to onboarding

**Technical details:**
- Passwords hashed with bcrypt (12 rounds)
- JWT tokens signed with `APP_SECRET`
- Firebase tokens verified server-side with Firebase Admin SDK

---

## 2. Onboarding

**Goal**: Capture business context for personalised AI output.

**Flow:**
1. **Step 1 — Business Profile**
   - Business name, industry, location
   - Product/service description
   - Target customer description
   - Monthly budget
   - Brand tone (professional, casual, playful, etc.)
   - Preferred platforms (Instagram, Facebook, LinkedIn, etc.)

2. **Step 2 — Strategy Input**
   - Option A: Paste existing marketing strategy
   - Option B: Let AI generate strategy from business profile
   - Option C: Skip (use default framework)

3. **Step 3 — Automation Settings**
   - Approval mode: Assisted or Autonomous
   - Auto-publish preference
   - Content safety sensitivity

4. **Step 4 — Confirmation**
   - Review settings
   - Launch campaign workflow
   - Mark onboarding complete

**Outcome:** Business record created + campaign workflow initiated.

---

## 3. Business Setup

**Behind the scenes:**
- Business data stored in `businesses` table
- Preferred platforms parsed into campaign configuration
- Brand tone stored in `workflowContext` for agent reference
- Initial usage record created in `user_usage`

**User sees:**
- Mission Control dashboard with campaign progress
- Sidebar navigation unlocked
- Credit balance displayed

---

## 4. Strategy Upload / Generation

**Trigger:** Onboarding completion or manual "Generate Strategy" action.

**Strategy Agent execution:**
1. Agent receives: business profile, industry, goals, budget
2. Generates structured strategy including:
   - Brand positioning statement
   - 3–5 messaging pillars
   - Channel recommendations
   - Content themes
   - KPI targets
3. Output saved to `campaigns.strategyContext` (JSON)
4. Workflow state advances to `strategy_generated`

**User experience (Assisted mode):**
- Notification: "Strategy ready for review"
- Opens Approval Centre
- Reviews strategy document
- Approves, rejects, or edits

**User experience (Autonomous mode):**
- Strategy auto-approved
- Workflow immediately advances to next step
- User sees summary in Mission Control

---

## 5. Campaign Generation

**Trigger:** Strategy approval.

**System actions:**
1. Campaign record updated with strategy context
2. Creative Agent queued
3. Audience Agent queued (parallel or sequential based on config)

**User sees:**
- Progress indicator: "Generating creatives..."
- Agent activity log showing running agents
- Estimated completion time

---

## 6. Creative Generation

**Creative Agent execution:**
1. Receives: strategy context, brand tone, platform requirements
2. Generates 20–30 platform-specific posts:
   - Hook (attention-grabbing opening)
   - Caption (main message)
   - CTA (call-to-action)
   - Platform tag (Instagram, LinkedIn, etc.)
   - Content type (educational, promotional, engagement)
3. Each post saved to `content_posts` table
4. Workflow state: `creatives_ready`

**Image Generation (optional):**
- User can trigger image generation for selected posts
- DALL-E generates platform-appropriate visuals
- Images stored in `generated_images`

---

## 7. Audience Generation

**Audience Agent execution:**
1. Receives: business profile, product/service, target customer description
2. Generates:
   - Primary persona (demographics, psychographics, pain points)
   - Secondary personas
   - Interest targeting recommendations
   - Lookalike segment suggestions
   - Geographic focus areas
3. Output saved to `campaigns.audienceContext` (JSON)
4. Workflow state: `audience_ready`

---

## 8. Approval Centre

**Trigger:** Any agent output requiring human review (based on approval mode).

**Approval types:**
- **Launch approval**: Campaign ready to publish
- **Brand risk approval**: Content flagged by safety agent
- **Budget approval**: Spend exceeds threshold
- **High-value lead approval**: Lead score > 80 requires manual qualification

**User actions:**
- Review pending approvals in `/approvals`
- Approve, reject, or edit the payload
- Add notes for audit trail
- Bulk approve multiple items

**Technical flow:**
1. Agent creates `approval_requests` record with `status = "pending"`
2. User views request with original payload
3. User action updates `approval_requests` and triggers `onApprovalResolved()`
4. Workflow engine resumes from the approval gate

---

## 9. Publishing

**Distribution Agent execution:**
1. Creates publishing schedule (optimal times per platform)
2. Populates `publishing_queue` with scheduled posts
3. For autonomous mode: schedules BullMQ jobs for each post
4. For assisted mode: waits for launch approval

**Publishing execution:**
1. BullMQ worker processes due jobs
2. Decrypts OAuth token from `social_integrations`
3. Calls platform API (Facebook Graph, LinkedIn API, X API)
4. On success: marks `published`, updates `content_posts`
5. On failure: increments retry count, schedules retry, creates alert after max retries

**User sees:**
- Calendar view with scheduled posts
- Publishing queue status (approved, published, failed, retrying)
- Platform-specific performance (future Phase 5)

---

## 10. Engagement

**Engagement Agent execution:**
1. Monitors connected platforms for comments, mentions, DMs
2. Analyses sentiment and intent
3. Generates contextual replies
4. Flags high-intent messages as leads
5. Escalates negative sentiment for human review

**User sees:**
- Conversation inbox (future Phase 6 enhancement)
- Lead notifications from engagement
- Sentiment dashboard

---

## 11. Lead Conversion

**Lead capture:**
- Social engagement → lead record created
- Website form → lead record created (future)
- Direct message → lead record created

**Lead scoring:**
- AI scores lead 0–100 based on behaviour and profile fit
- Scores > 80 flagged as "hot leads"
- Scores < 30 auto-archived

**Sales Agent execution:**
1. Generates personalised follow-up sequence (3–5 touches)
2. Drafts meeting request with value proposition
3. Creates proposal template customised to lead's needs
4. Schedules follow-up reminders in `lead_activities`

**User actions:**
- Reviews leads in `/leads`
- Approves auto-generated follow-ups
- Manually updates lead status (new → contacted → qualified → proposal → negotiation → won/lost)

---

## 12. Optimisation

**Trigger:** Campaign has been live for 7+ days with sufficient data.

**Optimisation Agent execution (Phase 5):**
1. Analyses publishing performance (engagement rates by platform, time, content type)
2. Compares actual vs. predicted performance
3. Identifies underperforming content and channels
4. Generates recommendations:
   - Creative refresh suggestions
   - Audience segment adjustments
   - Publishing time optimisations
   - Budget reallocation
5. Creates optimisation tasks in `optimisation_logs`

**User sees:**
- Analytics dashboard with campaign performance
- Optimisation recommendations with one-click apply
- A/B test results (future)

---

## Journey Summary Table

| Stage | Agent | User Action | Time |
|-------|-------|-------------|------|
| Registration | — | Create account | 2 min |
| Onboarding | — | Describe business | 5 min |
| Strategy | Strategy Agent | Review / approve | 3 min |
| Creative | Creative Agent | Review / edit | 5 min |
| Audience | Audience Agent | Review | 2 min |
| Approval | — | Launch approval | 1 min |
| Publishing | Distribution Agent | Monitor calendar | Ongoing |
| Engagement | Engagement Agent | Respond to alerts | As needed |
| Leads | Sales Agent | Qualify hot leads | 10 min/day |
| Optimisation | Optimisation Agent | Apply recommendations | 5 min/week |

**Total active user time per campaign: ~30 minutes**  
**Total autonomous execution time: 2–4 weeks**
