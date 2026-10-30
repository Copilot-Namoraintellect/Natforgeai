# NatForge AI — Complete Feature Documentation

> **Last updated:** 2026-11-10 (R8-A: §26 Strategic Memory; R8-B: §27 Business Change Intelligence; R8-D §28 Strategic Reasoning; R8-E §29 Strategic Opportunity & Risk Intelligence)
> **Stack:** React 19 + Vite + TypeScript + tRPC + Hono + Drizzle ORM + MySQL + Tailwind CSS + shadcn/ui + Firebase Auth

---

## Table of Contents

1. [Authentication & User Management](#1-authentication--user-management)
2. [Campaigns](#2-campaigns)
3. [Leads / CRM](#3-leads--crm)
4. [Content Studio](#4-content-studio)
5. [Content Calendar](#5-content-calendar)
6. [Automations](#6-automations)
7. [Analytics](#7-analytics)
8. [Templates / Prompt Library](#8-templates--prompt-library)
9. [Image Generation](#9-image-generation)
10. [Subscription & Pricing](#10-subscription--pricing)
11. [Admin Panel](#11-admin-panel)
12. [Banking & Payments](#12-banking--payments)
13. [Settings](#13-settings)
14. [Freemium Limits](#14-freemium-limits)
15. [Database Schema Overview](#15-database-schema-overview)
16. [API Architecture](#16-api-architecture)
17. [Marketing Action Policy (WBS-R5-E)](#17-marketing-action-policy-wbs-r5-e)
18. [Lead Identity (WBS-R6-A)](#18-lead-identity-wbs-r6-a)
19. [Lead Qualification (WBS-R6-C)](#19-lead-qualification-wbs-r6-c)
20. [Lead Autonomy Integration (WBS-R6-X)](#20-lead-autonomy-integration-wbs-r6-x)
21. [Conversion Outcome Intelligence (WBS-R7-A)](#21-conversion-outcome-intelligence-wbs-r7-a)
22. [Attribution Intelligence (WBS-R7-B)](#22-attribution-intelligence-wbs-r7-b)
23. [Optimisation Governance (WBS-R7-F)](#23-optimisation-governance-wbs-r7-f)
24. [Budget & Portfolio Optimisation (WBS-R7-E)](#24-budget--portfolio-optimisation-wbs-r7-e)
25. [Business Optimisation Integration (WBS-R7-X)](#25-business-optimisation-integration-wbs-r7-x)
26. [Strategic Memory (WBS-R8-A)](#26-strategic-memory-wbs-r8-a)
27. [Business Change Intelligence (WBS-R8-B)](#27-business-change-intelligence-wbs-r8-b)
28. [Strategic Reasoning (WBS-R8-D)](#28-strategic-reasoning-wbs-r8-d)
29. [Strategic Opportunity & Risk Intelligence (WBS-R8-E)](#29-strategic-opportunity--risk-intelligence-wbs-r8-e)

---

## 1. Authentication & User Management

### Supported Auth Methods

| Method | Frontend | Backend Verification | Identity Field |
|--------|----------|---------------------|----------------|
| **Local** (username/password) | HTML form | `bcrypt.compare()` | `users.username` / `users.email` |
| **Google OAuth** | Firebase Auth popup | Firebase Admin `verifyIdToken()` | `users.firebaseUid` |

### Local Registration

1. Go to `/login` → **Register** tab.
2. Fill: Name, Username (min 3 chars), Email, Password (min 6 chars), Confirm Password.
3. Click **"Create Account"**.
4. Backend hashes password with `bcrypt` (12 rounds), inserts user, auto-assigns **Free tier** subscription, creates `user_usage` tracking row.
5. Returns JWT token (30-day expiry, HS256) → stored in `localStorage.auth_token`.
6. Redirected to `/dashboard`.

### Local Login

1. Go to `/login` → **Login** tab.
2. Enter username/email and password.
3. Backend finds user, verifies `bcrypt` hash, updates `lastSignInAt`.
4. Returns JWT token → stored in `localStorage`.
5. Redirected to `/dashboard`.

### Google Sign-In (Firebase)

1. Click **"Google Account"** button.
2. `signInWithPopup(auth, googleProvider)` opens Google consent screen.
3. Firebase returns a `User` object.
4. Frontend extracts ID token via `result.user.getIdToken()`.
5. Sends token to backend `auth.firebaseAuth` mutation.
6. Backend uses **Firebase Admin SDK** to cryptographically verify the token.
7. Finds or creates user by `firebaseUid`. If email already exists, links accounts.
8. Auto-assigns Free tier + usage tracking.
9. If `firebaseUid === env.ownerUnionId`, role is promoted to `admin`.
10. Returns JWT token.

### Token System

- **Algorithm:** HS256 (HMAC with SHA-256)
- **Secret:** `APP_SECRET + "_local"` from `.env`
- **Library:** `jose`
- **Expiry:** 30 days
- **Storage:** `localStorage.auth_token`
- **Header:** Every tRPC request sends `Authorization: Bearer <token>`

### Roles

| Role | Access |
|------|--------|
| `user` | Standard app access (campaigns, leads, content, etc.) |
| `admin` | All user features + Admin Panel (`/admin`) + Banking (`/banking`) |

Role is checked by `adminQuery` middleware (`ctx.user.role === "admin"`).

### Super Admin Account

A super admin was created with:
- **Email:** `superadministratorai@natforgeai.com`
- **Username:** `superadmin`
- **Role:** `admin`

**Scripts:**
```bash
# Create superadmin (if doesn't exist)
npm run create:superadmin

# Reset superadmin password
npm run reset:superadmin
```

---

## 2. Campaigns

### What It Does
Plan, launch, and track marketing campaigns. Each campaign holds strategy, target audience, platforms, budget, and AI-generated content plans.

### Database Fields
`name`, `goal`, `status` (draft/active/paused/completed), `targetAudience`, `coreMessage`, `platforms`, `budget`, `strategy`, `personas` (JSON), `contentCalendar` (JSON), `adConcepts` (JSON), `funnelStages` (JSON), `offers` (JSON), `ctaStrategy`, `aiGenerated`

### Step-by-Step

1. Go to **Campaigns** (`/campaigns`).
2. Click **"New Campaign"** (disabled if at campaign limit).
3. Fill the form:
   - **Campaign Name** *(required)*
   - **Goal** *(required)* — e.g., "Increase walk-ins by 30%"
   - Target Audience, Platforms, Budget ($), Core Message
4. Click **"Create Campaign"**.
5. View campaigns in the grid. Each card shows status badge, name, goal, platforms, budget.
6. Click the **Eye icon** to view full details (strategy, personas as JSON, etc.).
7. Toggle **Activate / Pause** to change status.
8. When a campaign is marked **completed**, it counts as a **successful result** (subject to result limits).
9. Click the **Trash icon** to delete.

---

## 3. Leads / CRM

### What It Does
Track leads through a sales pipeline from first contact to close. Log activities (calls, emails, meetings).

### Status Pipeline
```
new → contacted → qualified → proposal → negotiation → won
                                            ↓
                                          lost
```

### Database Fields
`name`, `email`, `phone`, `company`, `jobTitle`, `source`, `status`, `score` (0-100), `notes`, `lastContact`, `nextFollowUp`, `customFields` (JSON), `campaignId`

### Lead Activities
| Type | Description |
|------|-------------|
| `note` | General note |
| `call` | Phone call log |
| `email` | Email sent/received |
| `meeting` | Meeting notes |
| `task` | Task/reminder |
| `status_change` | Automatic status change log |

### Step-by-Step

1. Go to **Leads** (`/leads`).
2. Filter by status tabs: All, New, Contacted, Qualified, Proposal, Won.
3. Search by name, company, or email.
4. **Add a Lead:**
   - Click **"Add Lead"**.
   - Fill: Name *(required)*, Email, Phone, Company, Job Title, Source, Score (0-100), Notes.
   - Click **"Add Lead"**.
5. **Edit a Lead:**
   - Hover over a card → click **Pencil icon**.
   - Update fields, especially **Status** dropdown.
   - When status changes to **`won`** and the lead has a `campaignId`, it counts as a **successful result**.
   - Click **"Update Lead"**.
6. **Delete a Lead:** Hover → click **Trash icon**.
7. **Activities:** Use `lead.activities` (query) and `lead.addActivity` (mutation) via API to log interactions.

---

## 4. Content Studio

### What It Does
Generate marketing content with AI (OpenAI GPT-4o-mini) or create it manually. Supports social posts, ad copy, emails, scripts, blogs, and stories.

### AI Generation Inputs
- Business name
- Content Type (social_post / ad_copy / email)
- Platform (Instagram, TikTok, LinkedIn, Facebook, Email, Blog)
- Tone (friendly, premium, bold, professional, casual, urgent)
- Target Audience
- Goal (optional)

### AI Output Formats
| Type | Output |
|------|--------|
| **Social Post** | 3 posts with Hook, Caption, CTA, Hashtags |
| **Ad Copy** | 3 ad copies with Headline, Pain Point, Solution, CTA |
| **Email** | Professional email with Subject, Opening Hook, Body, CTA, Sign-off |

### Step-by-Step

1. Go to **Content Studio** (`/content`).
2. **AI Generate:**
   - Click **"AI Generate"**.
   - Fill: Business, Content Type, Platform, Tone, Target Audience, Goal.
   - Click **"Generate Content"**.
   - Review generated text.
   - Click **"Save to Library"** to store it.
3. **Add Content Manually:**
   - Click **"Add Content"**.
   - Fill: Title *(required)*, Type, Platform, Hook, Caption/Body, CTA, Notes.
   - Click **"Save Content"**.
4. **Browse Content:**
   - Filter by tabs: All, Social, Ads, Email, Script, Blog.
   - Search by title.
   - Each card shows type badge, AI badge, title, hook, caption, CTA.
5. **Actions:**
   - **Copy** — copies hook + caption + CTA + body to clipboard.
   - **Delete** — removes the content post.

---

## 5. Content Calendar

### What It Does
Schedule and manage content publishing across platforms. Visual month-view calendar with color-coded content types.

### Content Types & Colors
| Type | Color |
|------|-------|
| educational | Blue |
| promotional | Amber |
| engagement | Emerald |
| awareness | Purple |
| conversion | Red |

### Step-by-Step

1. Go to **Calendar** (`/calendar`).
2. View the month calendar. Today is highlighted.
3. Each day shows colored dots for scheduled posts.
4. **Schedule a Post:**
   - Click any date on the calendar.
   - Fill: Title *(required)*, Platform (Instagram, TikTok, LinkedIn, Facebook, Twitter), Content Type, Time, Notes.
   - Click **"Schedule"**.
5. **View Upcoming Posts:**
   - Below the calendar, see a list of upcoming posts with color-coded dots, title, platform, time.
6. **Delete a Schedule:** Click the **Trash icon** in the upcoming list.

---

## 6. Automations

### What It Does
Define automated workflows that trigger actions based on events. Currently stores definitions and toggles state; execution engine is external.

### Triggers
| Trigger | Description |
|---------|-------------|
| `new_lead` | Fires when a new lead is captured |
| `new_message` | Fires on new inbound message |
| `new_purchase` | Fires on purchase/order |
| `form_submit` | Fires on form submission |
| `schedule` | Time-based trigger |
| `manual` | Triggered by user action |

### Actions
`send_email`, `send_whatsapp`, `add_to_crm`, `notify_team`, `create_task`

### Step-by-Step

1. Go to **Automations** (`/automations`).
2. Click **"New Workflow"**.
3. Fill:
   - **Name** *(required)*
   - Description
   - **Trigger** (dropdown of 6)
   - **Action 1** & **Action 2** (dropdown of 5)
4. Click **"Create Workflow"**.
5. Workflow starts in **Paused** state.
6. Click **Play/Pause** icon to activate.
7. View run count and last run time.

---

## 7. Analytics

### What It Does
Track marketing performance metrics and visualize data. Dashboard shows campaign stats, lead pipeline, content distribution, and conversion rates.

### Supported Metrics
| Metric | Description |
|--------|-------------|
| `impressions` | Content/ad views |
| `clicks` | Link/ad clicks |
| `conversions` | Goal completions |
| `leads` | Lead captures |
| `revenue` | Sales/income |
| `engagement` | Likes, shares, comments |
| `followers` | Audience growth |
| `reach` | Unique users reached |

### Step-by-Step

1. Go to **Analytics** (`/analytics`).
2. View top stats: Total Campaigns, Total Leads, Content Pieces, Conversion Rate.
3. Scroll to see:
   - **Campaign Status Breakdown** — progress bars for draft/active/paused/completed
   - **Lead Pipeline** — distribution of lead statuses
   - **Content Distribution** — donut chart by content type
4. **Record a Metric (API):**
   ```ts
   trpc.analytics.record.mutate({
     metricType: "conversions",
     value: 15,
     date: "2026-05-29",
     platform: "instagram",
     campaignId: 5,
   })
   ```
5. **Query Metrics (API):**
   ```ts
   trpc.analytics.metrics.useQuery({
     campaignId: 5,
     metricType: "clicks",
     startDate: "2026-05-01",
     endDate: "2026-05-29",
   })
   ```

---

## 8. Templates / Prompt Library

### What It Does
Pre-built marketing prompts organized by category. Variables use `{{variableName}}` syntax. Templates can be copied and customized.

### Categories
`strategy`, `content`, `ads`, `design`, `video`, `targeting`, `scheduling`, `chatbot`, `crm`, `automation`

### Step-by-Step

1. Go to **Prompt Library** (`/templates`).
2. Use category tabs to filter (e.g., click **ads**).
3. Search by name or description.
4. Click a card to expand and view the full prompt.
5. See variable tags (auto-detected from `{{}}` placeholders).
6. Click **"Copy Prompt"** to copy raw text.
7. Paste into your AI tool, replacing variables with real values.

---

## 9. Image Generation

### What It Does
Job tracker for AI-generated images. Stores prompts, aspect ratios, styles, and tracks generation status (pending → completed/failed).

### Step-by-Step (API)

1. **Create a job:**
   ```ts
   trpc.image.create.mutate({
     prompt: "A futuristic neon city skyline for a tech ad",
     aspectRatio: "16:9",
     style: "cyberpunk",
     campaignId: 5,
   })
   ```
   → Returns `{ id, success: true }` with status `pending`.

2. **Worker processes job** (external AI model) and updates:
   ```ts
   trpc.image.update.mutate({
     id: <jobId>,
     url: "https://cdn.example.com/image.png",
     status: "completed",
   })
   ```

3. **List images:**
   ```ts
   trpc.image.list.useQuery({ campaignId: 5, status: "completed" })
   ```

4. **Delete:** `trpc.image.delete.mutate({ id })`

---

## 10. Subscription & Pricing

### Tiers

| Tier | Price | Campaigns | Leads | Content | Automations | Results | AI Gen | Analytics |
|------|-------|-----------|-------|---------|-------------|---------|--------|-----------|
| **Free** | $0 | 2 | 20 | 10 | 0 | 5 | ❌ | ❌ |
| **Startup** | $20/mo | 10 | 500 | 100 | 5 | 5 | ✅ | ✅ |
| **Growth** | $49/mo | 50 | 2,000 | 500 | 20 | 5 | ✅ | ✅ |
| **Enterprise** | $99/mo | 999 | 99,999 | 9,999 | 999 | 5 | ✅ | ✅ |

### Step-by-Step

1. Go to **Pricing** (`/pricing`).
2. Log in if not authenticated.
3. Click **"Get Started"** (Free) or **"Subscribe"** (paid).
4. Current plan shows a **"Current"** badge.
5. **Most Popular** badge on Startup tier.
6. Subscribe calls `subscription.subscribe({ tierId })`.
7. Backend cancels old subscription, creates new one with 1-month period.

### Checking Usage

```ts
const { data } = trpc.subscription.myUsage.useQuery();
// data.tier.maxCampaigns, data.tier.maxResults
// data.usage.campaignsCreated, data.usage.successfulResults
```

---

## 11. Admin Panel

### Access
Navigate to `/admin`. Requires `role === "admin"`. Non-admins are redirected to `/dashboard`.

### Dashboard Stats
- Total Users, Campaigns, Leads, Content, Businesses
- Total Revenue (from completed payments)
- Active Subscriptions

### Revenue Chart
- Horizontal bar chart of last 12 months of completed payments

### Users Tab
- List all users with search (name/email/username) and role filter
- **Make Admin** / **Demote** buttons toggle user roles
- Admin can create users and delete users (via API)

### Payments Tab
- List all payments with status filter
- **Record Payment** button opens dialog:
  - User ID, Amount (USD), Payment Method, Reference, Description
  - Creates a `completed` payment immediately

### Subscriptions Tab
- List all subscriptions enriched with user and tier data
- Subscriptions by Tier chart

### Admin API Endpoints

| Endpoint | Action | Input |
|----------|--------|-------|
| `admin.stats` | Get dashboard stats | — |
| `admin.users` | List all users | `{ search?, role? }` |
| `admin.updateUserRole` | Toggle user role | `{ userId, role: "user" \| "admin" }` |
| `admin.payments` | List payments | `{ status? }` |
| `admin.updatePaymentStatus` | Update payment status | `{ paymentId, status }` |
| `admin.subscriptions` | List subscriptions | — |
| `admin.subscriptionsByTier` | Aggregated by tier | — |
| `admin.recordPayment` | Record manual payment | `{ userId, amount, currency?, description?, paymentMethod, paymentReference?, subscriptionId? }` |
| `admin.deleteUser` | **Delete user + all data** | `{ userId }` |
| `admin.createUser` | **Create user directly** | `{ name, username, email, password, role? }` |

---

## 12. Banking & Payments

### What It Does
Admin manages payment receiving methods: Bank Transfer, Stripe, PayPal, Crypto.

### Data Model
`accountName`, `bankName`, `accountNumber`, `accountType`, `branchCode`, `swiftCode`, `iban`, `routingNumber`, `stripeAccountId`, `paypalEmail`, `cryptoWalletAddress`, `cryptoNetwork`, `isDefault`, `isActive`

### Step-by-Step

1. Go to **Banking** (`/banking`). Requires admin role.
2. View summary cards: Bank Accounts, Stripe, PayPal, Crypto counts.
3. View the **Default Payment Method** prominently displayed.
4. Choose tab: Bank Transfer, Stripe, PayPal, Crypto.
5. Fill the form for the selected method.
6. Click **"Save Payment Method"**.
7. Star a method to set it as **default**.
8. Delete non-default methods with the **Trash icon**.

---

## 13. Settings

### Profile Tab
- Read-only display of current user info
- Avatar initial, name, email, role badge, member since
- **No password change UI** currently (use API or admin)

### Businesses Tab
- List all businesses
- **Add Business:** name, description, industry, location, target audience, tone, website
- **Edit Business:** same fields, pre-populated
- **Delete Business:** trash icon

### Preferences Tab
- Notifications (Coming Soon)
- Platform Integrations: Instagram, LinkedIn, Facebook
  - Shows connection status and configured-state from environment variables.
  - Connect button opens the provider OAuth authorization URL in a new tab.
  - Disconnect removes the stored integration row for the authenticated user.
  - Tokens are never exposed in the UI.

---

## 14. Freemium Limits

### How Limits Work

| Limit | Free Default | Enforcement Point |
|-------|--------------|-------------------|
| **Campaigns** | 2 | `campaign.create` — blocked if exceeded |
| **Results** | 5 | `campaign.update` (→ completed) and `lead.update` (→ won with campaignId) |

### What Counts as a "Successful Result"
1. A campaign marked as **`completed`**
2. A lead marked as **`won`** that is linked to a campaign (`campaignId IS NOT NULL`)

### UI Behavior
- **Usage banner** appears on Campaigns page showing campaigns + results progress bars
- **"New Campaign"** button is disabled when campaign limit reached
- Dialog shows **upgrade CTA** linking to `/pricing`
- Dashboard shows usage widget card

### API Usage Check
```ts
const check = await checkLimit(userId, "campaign");
// check.allowed, check.current, check.limit, check.reason
```

---

## 15. Database Schema Overview

### Core Tables

| Table | Purpose |
|-------|---------|
| `users` | All users (local, Google, Firebase) with role enum |
| `subscription_tiers` | 4 tiers with limits and feature flags |
| `subscriptions` | User subscription records with status |
| `payments` | Payment history (manual, Stripe, PayPal, crypto) |
| `user_usage` | Tracks `campaignsCreated` and `successfulResults` per user |
| `businesses` | Business profiles per user |
| `campaigns` | Marketing campaigns with strategy JSON fields |
| `leads` | CRM leads with pipeline status |
| `lead_activities` | Activity log for leads |
| `content_posts` | Generated/manual content pieces |
| `schedules` | Content calendar entries |
| `automations` | Workflow definitions (trigger + actions JSON) |
| `analytics` | Metrics records (impressions, clicks, conversions, etc.) |
| `templates` | Prompt templates by category |
| `generated_images` | Image generation job tracker |
| `banking_details` | Admin payment receiving methods |

### Key Relationships
- `campaigns.userId` → `users.id`
- `leads.campaignId` → `campaigns.id`
- `content_posts.campaignId` → `campaigns.id`
- `schedules.campaignId` → `campaigns.id`
- `analytics.campaignId` → `campaigns.id`
- `subscriptions.userId` → `users.id`
- `subscriptions.tierId` → `subscription_tiers.id`
- `payments.userId` → `users.id`
- `user_usage.userId` → `users.id` (unique)

---

## 16. API Architecture

### Request Flow

```
Browser → Vite Dev Server → Hono (api/boot.ts) → tRPC fetchRequestHandler
                                    ↓
                           createContext (extracts Bearer token)
                                    ↓
                           Middleware (requireAuth / requireRole)
                                    ↓
                           Router Procedure (business logic)
                                    ↓
                           Drizzle ORM → MySQL
```

### Middleware Types

| Type | Auth Required | Role Required | Use Case |
|------|--------------|---------------|----------|
| `publicQuery` | No | No | Ping, health checks, login/register |
| `authedQuery` | Yes | No | All user features |
| `adminQuery` | Yes | `admin` | Admin panel, banking |

### Routers

| Router | File | Description |
|--------|------|-------------|
| `auth` | `api/local-auth-router.ts` | Local auth, Google OAuth, Firebase auth, me |
| `campaign` | `api/campaign-router.ts` | CRUD + limit enforcement |
| `lead` | `api/lead-router.ts` | CRUD + activities + result tracking |
| `content` | `api/content-router.ts` | CRUD for content posts |
| `schedule` | `api/schedule-router.ts` | Calendar scheduling CRUD |
| `automation` | `api/automation-router.ts` | Workflow definitions CRUD |
| `analytics` | `api/analytics-router.ts` | Metrics recording and querying |
| `template` | `api/template-router.ts` | Template library CRUD |
| `image` | `api/image-router.ts` | Image generation job tracker |
| `subscription` | `api/subscription-router.ts` | Tiers, subscribe, cancel, usage |
| `admin` | `api/admin-router.ts` | Stats, users, payments, subscriptions, user management |
| `banking` | `api/banking-router.ts` | Payment method CRUD |
| `business` | `api/business-router.ts` | Business profile CRUD |
| `learning` | `api/learning-router.ts` | Phase 1 Learning engine: governed, idempotent campaign-learning evaluation (`evaluate`, `records`, `record`) |
| `listening` | `api/lib/social-listening/listening-router.ts` | WBS-R5-A social listening: tenant-scoped listening status (`getOverview`), canonical signal read view (`listSignals`), operator overview (`adminGetOverview`) |
| `policy` | `api/policy-router.ts` | WBS-R5-E governed policy layer: marketing-action evaluation, versioned business policies, durable auditable decisions (`evaluateActionRequest`, `getDecision`, `explainDecision`, `listDecisions`, `getPolicy`, `adoptDefaultPolicy`, `setPolicy`, `adminListDecisions`) |
| `opportunity` | `api/opportunity-router.ts` | R5-D opportunity detection: rule-first, evidence-backed pre-lead candidate evaluation from R5-B interpretations; aggregation, confidence, lifecycle, expiry, exactly-once R6 handoff (`evaluate`, `attachEngagementEvidence`, `list`, `get`, `suppress`, `unsuppress`, `escalate`, `sweepExpiry` admin, `handoffToR6`, `listHandoffs`). Never creates leads/CRM rows. Contract: `docs/contracts/opportunity-candidate-contract.md` |
| `leadIdentity` | `api/lead-identity-router.ts` | R6-A lead identity authority: deterministic, tenant-bound lead identities from R5 handoff envelopes; exact-once consumption (`consumeOpportunityHandoff` — server loads the durable envelope by `opportunityId` reference only), governed hashed enrichment (`submitIdentityEvidence` with deterministic merge/conflict), suppression/archival, downstream-safe projections (`get`, `list`). No scoring/qualification/contact/conversion. Contracts: `docs/contracts/lead-identity-contract.md`, `docs/contracts/lead-identity-to-scoring-qualification-contract.md` |
| `scoring` | `api/scoring-router.ts` | R6-B lead scoring: deterministic, evidence-bound lead scores from R5 opportunity evidence + lead identity seam (`scoreLead`, `get`, `listHistory`). Immutable versioned records, honest confidence, bounded reason codes, exact-once. Score is evidence, never qualification. Contracts: `docs/contracts/lead-scoring-contract.md`, `docs/contracts/lead-scoring-to-qualification-contract.md` |
| `conversion` | `api/conversion-router.ts` | R6-E conversion tracking: durable conversion/outcome records bound to tenant+business with provenance lineage (references only, never causation), deterministic server-minted conversion identity, exact-once natural key, reversal lifecycle events. Contracts: `docs/contracts/conversion-event-contract.md`, `docs/contracts/conversion-to-attribution-contract.md` |
| `qualification` | `api/qualification-router.ts` | R6-C governed lead qualification: deterministic evidence-based decisions (QUALIFIED/NOT_QUALIFIED/REVIEW_REQUIRED/INSUFFICIENT_EVIDENCE/BLOCKED), exact-once immutable persistence, governed manual review, safe D handoff projection (`evaluate`, `get`, `listHistory`, `listReviews`, `resolveReview`, `getHandoffProjection`, `getPolicy`). Never performs outreach/CRM/conversion. Contracts: `docs/contracts/lead-qualification-contract.md`, `docs/contracts/lead-qualification-to-nurture-handoff-contract.md` |
| `leadGovernance` | `api/lead-governance-router.ts` | R6-F lead governance/operations (WBS-R6 Stream F): admin-scoped read-only lead-operations projection reads (`getLeadOperations`, `listLeadOperationalStates`, `getLeadGovernanceSummary`), governed privacy transitions (`setPrivacyState`) and narrow governed recovery (`retryOperation`, retention sweep only). No force-merge/score/qualify/convert paths. Contract: `docs/contracts/lead-governance-operations-contract.md` |
| `nurture` | `api/nurture-router.ts` | WBS-R6-D nurture/sales-handoff autonomy: governed nurture/handoff decisions over frozen A/C/E/F contracts; exact-once handoff identity, lifecycle, `sales_handoff` approvals, fake/test-only transport seam, conversion stop conditions, F-consumable operations view (`status`, `evaluate`, `getDecision`, `getHandoff`, `dispatchHandoff`, `reconcileHandoff`, `dispatchNurtureTouch`, `getLeadView`). Contract: `docs/contracts/lead-nurture-sales-handoff-contract.md` |
| `attribution` | `api/attribution-router.ts` | WBS-R7-B attribution intelligence: deterministic attribution over frozen R7-A outcome projections; eligible journey reconstruction (score-mediated lead chain, scope/window/dedup rules), closed model set (`FIRST_TOUCH`, `LAST_TOUCH`, `LINEAR`, `POSITION_BASED`, `TIME_DECAY`) in exact integer basis points, evidence/confidence classification, immutable results + supersession, R7-C learning projection (`evaluate`, `synchronize`, `get`, `list`). Contracts: `docs/contracts/attribution-intelligence-contract.md`, `docs/contracts/attribution-to-business-learning-contract.md` |
| `optimisationGovernance` | `api/optimisation-governance-router.ts` | R7-F optimisation governance authority: deterministic proposal → governance evaluation (`ALLOW`/`REVIEW_REQUIRED`/`BLOCK`) over closed action taxonomy, versioned code-level policy, financial guardrails (no autonomous total-spend increase, locked/reserved funds immutable, provider allow-list), experiment constraints (concurrency/budget/dimensions/protected traits), portfolio concentration/shift/oscillation limits, approval-bound execution gate, read-only operations projection, audit-only narrow recovery (`evaluate`, `get`, `listDecisions`, `getOperationsProjection`, `revalidate`, `recordRecovery`, `getPolicy`). Never executes optimisation, billing, or provider actions. Contract: `docs/contracts/business-optimisation-governance-contract.md` |
| `outcome` | `api/outcome-router.ts` | WBS-R7-A conversion outcome intelligence: durable business-outcome truth from governed R6-E conversions — deterministic `out1:` identity, exact-once, closed outcome types/statuses/evidence-authority classes, immutable lifecycle facts, monetary value read-only (`record`, `verify`, `get`, `list`, `r7Projections`, `listLifecycle`). Contracts: `docs/contracts/conversion-outcome-intelligence-contract.md`, `docs/contracts/conversion-outcome-to-attribution-learning-contract.md` |
| `businessLearning` | `api/business-learning-router.ts` | WBS-R7-C business learning engine: deterministic context-scoped learning derived from R7-A outcomes + R7-B attribution via frozen projections; evidence bundles, contradiction/novelty handling, honest confidence, immutable records + lifecycle (`derive`, `get`, `list`, `listLifecycle`). Contracts: `docs/contracts/business-learning-contract.md`, `docs/contracts/business-learning-to-experiment-optimisation-contract.md` |
| `experimentation` | `api/experimentation-router.ts` | WBS-R7-D experimentation engine: governed experiment designs over R7-C learning, deterministic assignment, R7-A/R7-B-sourced evidence binding, immutable results scoped to design assumptions (`createDesign`, `getDesign`, `activate`, `assign`, `bindEvidence`, `calculateResult`, `getResult`, lifecycle reads). Contract: `docs/contracts/experimentation-contract.md` |
| `budgetPortfolio` | `api/budget-portfolio-router.ts` | WBS-R7-E budget & portfolio optimisation: portfolio snapshots, evidence model, bounded reallocation solver under stability constraints, R7-F-governed proposals and read-only authorised instructions; never raises total approved budget, never moves locked/reserved funds, no billing (`snapshotPortfolio`, `generateProposal`, `getInstruction`, `listProposals`, `getStrategyHandoff`). Contract: `docs/contracts/budget-portfolio-optimisation-contract.md` |
| `strategicMemory` | `api/strategic-memory-router.ts` | WBS-R8-A strategic memory: durable, versioned fact/assumption memory derived from R7 authorities, Business DNA and strategy snapshots via the frozen seam, plus governed operator attestation; supersession/contradiction/expiry with immutable history; read-only current-state projection for R8-B/C/D/E; no execution authority of any kind (`record`, `ingestR7`, `get`, `list`, `r8Projections`, `listLifecycle`, `sweepExpiry`). Contract: `docs/contracts/strategic-memory-contract.md` |
| `businessChange` | `api/business-change-router.ts` | R8-B business change intelligence: deterministic detection/classification of meaningful internal changes by comparing R8-A current strategic memory (previous state, read-only) against newly observed governed evidence (R7 budget/learning/governance, Business DNA, strategy snapshots) or bounded operator attestation; `chg1:` identity, immutable evidenceHash cores, closed domains/types, confidence-capped significance, confirmation/contradiction/supersession lifecycle, read-only downstream projection for R8-D/E (`evaluate`, `attest`, `correct`, `get`, `list`, `r8Projections`, `listLifecycle`, `sweepExpiry`). Never mutates memory/DNA/strategy/budget/operations. Contracts: `docs/contracts/business-change-intelligence-contract.md`, `docs/contracts/business-change-to-strategic-reasoning-contract.md` |
| `marketSignal` | `api/market-signal-router.ts` | WBS-R8-C market & external signal intelligence: safe ingest/normalization/corroboration/classification of external strategic evidence — deterministic source/signal identity, server-side source registry + spoof rejection, inert-content injection detection, R8-F-vocabulary trust, independent-only corroboration, per-type freshness, bounded business relevance, visible contradiction/supersession lifecycle, read-only `external-signal/v1` projection for R8-D/E (`ingest`, `get`, `list`, `listLifecycle`, `r8Projections`, `listSources`). Contracts: `docs/contracts/market-external-signal-contract.md`, `docs/contracts/external-signal-to-strategic-reasoning-contract.md` |
| `strategicReasoning` | `api/strategic-reasoning-router.ts` | WBS-R8-D strategic reasoning: deterministic evidence-bundle + rule-first synthesis over R8-A/B/C evidence, confidence/uncertainty caps, mandatory R8-F governance binding, immutable conclusion lifecycle + re-evaluation, read-only R8-E handoff projection (`evaluate`, `get`, `list`, `listLifecycle`, `reevaluate`, `getHandoffProjections`). Never owns upstream truth, never executes. Contract: `docs/contracts/strategic-reasoning-contract.md` |

### Context

Every authenticated request has `ctx.user` attached (full `User` row from DB). The token is verified via `jose` library, then the user is looked up by `userId` from the token payload.

---

## 17. Marketing Action Policy (WBS-R5-E)

The governed policy layer that decides what NatForgeAI may do autonomously in
response to marketing/social intelligence. Owns decision policy only — not
social ingestion (R5-A), interpretation (R5-B), engagement execution (R5-C),
opportunity detection (R5-D) or publishing.

**Required principle:** no autonomous marketing action may execute unless a
server-side policy decision explicitly authorizes it.

- Core modules: `api/lib/policy/` (`action-request`, `policy-model`,
  `risk-classification`, `decision-engine`, `cost-governance`,
  `marketing-action-approval`, `policy-store`, `policy-decision-store`,
  `policy-authority-resolver`, `policy-audit`, `policy-types`).
- Action types (closed): `observe_only`, `classify`, `reply_publicly`,
  `reply_privately`, `react`, `escalate_to_human`,
  `create_opportunity_candidate`, `schedule_follow_up`, `nurture_candidate`,
  `suppress_action`.
- Decisions (closed): `ALLOW_AUTONOMOUS`, `REQUIRE_APPROVAL`, `DENY`,
  `ESCALATE`, `NO_ACTION`. Risk tiers `low < medium < high < critical` can
  only reduce autonomy.
- Fail closed on: missing policy, unknown action, ownership mismatch,
  unverified provider binding/capability, budget/quota/rate limits, stale
  policy version, expired bindings. Clients can never supply risk,
  decision, approval or billing identity.
- One action request + one policy version → one durable, immutable,
  audited decision (`policy_decisions`); retries/concurrency converge.
  Approvals bind the exact decision + policy version + context
  (`approval_requests.approvalType = "marketing_action"`); human rejection
  permanently blocks the action identity.
- Denied/suppressed/escalated actions are non-billable; billable actions
  carry one stable deterministic billing identity, settled later by the R4
  billing authority (policy never charges).
- Handoff contract: `docs/contracts/marketing-action-policy-contract.md`.
  Schema: `business_policies` + `policy_decisions` tables (migration
  `0029_sad_donald_blake.sql`, artefact only — see
  `docs/recovery/r5-e-unexecuted-migrations.md`).

---

## 19. Lead Qualification (WBS-R6-C)

The governed qualification layer that decides whether a lead may progress to
downstream nurture/sales handoff. Owns qualification only — not identity
resolution (R6-A), scoring (R6-B), outreach/nurture execution (R6-D), CRM
lifecycle (`api/lead-router.ts`), conversion (R6-E), or privacy governance
(R6-F).

**Required principle:** *score is evidence, not qualification.* No
qualification may be inferred from score alone, and no autonomous
qualification occurs unless identity is valid and current, score evidence is
valid and current where required, required business-fit evidence exists,
qualification rules authorize the outcome, privacy/suppression allows
evaluation, and governance does not block progression.

- Core modules: `api/lib/qualification/` (`qualification-contract`,
  `qualification-policy`, `qualification-engine`, `qualification-evidence`,
  `qualification-identity-seam`, `qualification-scoring-seam`,
  `qualification-governance-seam`, `qualification-review`,
  `qualification-handoff`, `qualification-store`, `qualification-service`,
  `qualification-bridge`).
- Decisions (closed): `QUALIFIED`, `NOT_QUALIFIED`, `REVIEW_REQUIRED`,
  `INSUFFICIENT_EVIDENCE`, `BLOCKED`. Reason codes closed (20, ≤ 8 per
  record). There are no sales states — pipeline lifecycle remains with CRM
  and R6-D.
- Deterministic, rule-first: no model in the decision path; every decision is
  reproducible from governed evidence + rules, immutable, and audited —
  exactly one `lead_qualification_evaluated` event per inserted decision and
  one `lead_qualification_review_resolved` per governed review resolution;
  convergence paths emit zero events.
- Exact-once: unique `(userId, qualificationId)` convergence anchor;
  retries/concurrency converge by re-read (`idempotent_replay`); rows are
  insert-only — corrections are new decisions. One governed review per
  REVIEW_REQUIRED decision, bound to the exact decision via
  `decisionBindingHash`, optimistic-CAS resolved at most once; replay drift
  fails closed (`QUALIFICATION_REPLAY_CONFLICT`).
- Cross-binding discipline: R6-B's score surface keys on the legacy numeric
  `leads.id` with `lead-identity-seam/v1:<hash>`; C binds score↔identity by
  tenant + business scope, never by leadId/version equality.
- Fail closed on: missing/unknown policy version, unknown identity/score
  versions, tampered hashes, stale inputs, unavailable authority bridge
  (`QUALIFICATION_AUTHORITY_UNAVAILABLE`), replay conflicts, and privacy
  suppression/retention (`BLOCKED`).
- Manual review requires **independent human authentication**: resolution
  needs a single-use, review-bound out-of-band challenge (email OTP,
  purpose `review_authorization`) — a verified tenant session alone can
  never resolve (runtime agents hold the tenant JWT; the code exists only
  in the reviewer's mailbox). Gateway: `qualification-review-authority.ts`
  over the governed OTP primitive; schema: `pendingChallengeToken` /
  `challengeExpiresAt` on `lead_qualification_reviews`.
- Privacy is read only through the authoritative chain: R6-A identity
  (exact tenant/business scope) → validated R6-B score → score-authoritative
  numeric `leads.id` → R6-F `lead_privacy_states`. No numeric-id inference,
  no cached state; unestablished chains fail closed.
- Router: `qualification` (`api/qualification-router.ts`) — authed-only
  (`evaluate`, `get`, `listHistory`, `listReviews`, `requestReviewResolution`,
  `resolveReview`, `getHandoffProjection`, `getPolicy`). Clients reference
  ids only; `z.strictObject` rejects every client-supplied authority field
  (decision, reason codes, confidence, review outcome, policy content,
  identity, challenge proof).
- Handoff contract: `docs/contracts/lead-qualification-contract.md` and
  `docs/contracts/lead-qualification-to-nurture-handoff-contract.md`. R6-D
  consumes the exact `getHandoffProjection` key set; the `mayProgress`
  derivation is R6-C authority, never recomputed downstream.
- Non-billable: deterministic rules only — no billing, no outreach, no CRM
  mutation, no conversion side effects.
- Schema: `lead_qualifications` + `lead_qualification_reviews` (provisional
  migration `0034_lead_qualification_autonomy` — artefacts only, NOT
  executed; see `docs/recovery/r6-c-unexecuted-migrations.md`; R6-X owns
  canonical sequencing). The bridge (`qualification-bridge.ts`) mirrors the
  frozen upstream R6-A/B/F column sets (`lead_identities`,
  `lead_identity_provenance`, `lead_score_snapshots`, `lead_privacy_states`)
  behind guarded information-schema checks, replaced by canonical
  `@db/schema` imports at R6-X convergence.

## Useful Commands

```bash
# Development
npm run dev

# Build
npm run build

# Type check
npm run check

# Database
npm run db:push        # Push schema changes
npm run db:migrate     # Run migrations
npm run db:generate    # Generate migration files

# Admin scripts
npm run create:superadmin    # Create superadmin user
npm run reset:superadmin     # Reset superadmin password
```

## Environment Variables (`.env`)

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | MySQL connection string |
| `APP_SECRET` | JWT signing secret |
| `FIREBASE_SERVICE_ACCOUNT` | Path to serviceAccountKey.json |
| `VITE_FIREBASE_API_KEY` | Firebase client API key |
| `VITE_FIREBASE_AUTH_DOMAIN` | Firebase auth domain |
| `VITE_FIREBASE_PROJECT_ID` | Firebase project ID |
| `VITE_FIREBASE_STORAGE_BUCKET` | Firebase storage |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | Firebase messaging |
| `VITE_FIREBASE_APP_ID` | Firebase app ID |
| `OWNER_UNION_ID` | Firebase UID that gets auto-promoted to admin |
| `META_APP_ID` | Meta OAuth app ID (Facebook + Instagram) |
| `META_APP_SECRET` | Meta OAuth app secret |
| `META_REDIRECT_URI` | Meta OAuth callback URI (default `https://natforgeai.com/api/oauth/callback`) |
| `META_OAUTH_SCOPES` | Comma-separated Meta OAuth scopes (default `public_profile,email,pages_show_list,pages_manage_posts`) |
| `LINKEDIN_CLIENT_ID` | LinkedIn OAuth client ID |
| `LINKEDIN_CLIENT_SECRET` | LinkedIn OAuth client secret |
| `LINKEDIN_REDIRECT_URI` | LinkedIn OAuth callback URI (default `https://natforgeai.com/api/oauth/linkedin/callback`) |
| `ENABLE_PREMIUM_VIDEO` | Enable premium video generation features (`false` by default) |
| `ENABLE_BASIC_DRAFT_VIDEO` | Enable basic draft video generation features (`false` by default) |

---

## 18. Lead Identity (WBS-R6-A)

The authoritative lead-identity layer: converts R5 opportunity handoff
envelopes into durable, tenant-safe lead identities. Owns **lead identity
only** — no scoring (R6-B), qualification (R6-C), nurture (R6-D), conversion
(R6-E), or governance override (R6-F).

- Core modules: `api/lib/lead-identity/` (`lead-identity-contract`,
  `lead-identity-keys`, `lead-identity-derivation`, `lead-identity-store`,
  `lead-identity-service`); router `api/lead-identity-router.ts` (`leadIdentity`).
- Identity: deterministic, server-minted `leadId = "lid1:" + sha256(coordinates)`
  over `{ userId, businessId, actorKey | threadKey }`; the R5 `actorKey` hash
  is stored verbatim — **raw actor references / raw PII never persist**.
- Exact-once R5 handoff consumption via unique `(userId, handoffId)`
  provenance; replay returns the existing identity; concurrent intake
  converges; tampered/stale/forged/cross-tenant handoffs fail closed.
- Controlled enrichment only through `submitIdentityEvidence`
  (email/phone/customer references are normalized + hashed server-side).
  Deterministic merge requires an authoritative linking key shared within one
  tenant + business scope; conflicts become `conflicting` (sticky, R6-F
  resolves) — never a silent merge. No merge-anything endpoint exists.
- Identity status is identity-lifecycle only (`active`, `anonymous`,
  `partially_identified`, `resolved`, `conflicting`, `suppressed`, `merged`,
  `archived`) — no sales/qualified/converted states.
- Schema: `lead_identities`, `lead_identity_provenance`, `lead_identity_merges`
  (provisional migration `0034_lead_identity_foundation`, artefact only — see
  `docs/recovery/r6-a-unexecuted-migrations.md`).
- Contracts: `docs/contracts/lead-identity-contract.md` (canonical),
  `docs/contracts/lead-identity-to-scoring-qualification-contract.md`
  (downstream handoff). Acceptance: `api/lib/lead-identity/r6-a-acceptance.test.ts`.

---

## 20. Lead Autonomy Integration (WBS-R6-X)

The integrated Lead Autonomy system (streams R6-A/B/C/D/E/F merged on
`integration/r6-lead-autonomy`; verdict `LEAD_AUTONOMY_V1_READY`). Connected
lifecycle: R5 opportunity handoff → canonical `lid1` identity → evidence
scoring → governed qualification (independent OTP human review) → privacy
check → bounded nurture / governed sales handoff → exact-once conversion →
conversion stop → operations projection.

- **Canonical migration:** one `0034_r6_lead_autonomy_foundation` (13 R6
  tables + D's accepted `approval_requests` enum extension). Journal/snapshot
  chain verified; NOT executed (`docs/recovery/r6-migration-convergence.md`).
- **Cross-stream binding:** the lid1 ↔ numeric `leads.id` mapping is
  score-mediated, validated at R6-C/R6-D; C's bridge reads canonical
  `@db/schema` tables (no mirrors); D's production ports
  (`api/lib/nurture/nurture-ports.ts`) wire C's projection service, A/F/E
  reads and the approval ledger behind D's frozen validators. D binds C's
  exact engine-version constant (closed allow-list).
- **Review authority:** real OTP primitive (bcrypt-hashed, single-use,
  mailbox-only code); tenant JWT alone cannot resolve; D `sales_handoff`
  approvals are a distinct, correctly-scoped authority.
- **Provider truth:** WhatsApp/SMS/CRM UNSUPPORTED; Email
  REQUIRES_CONFIGURATION; only the fake/test-only transport dispatches
  (tests only).
- **Harness:** `api/r6-x-harness.test.ts` (30 connected scenarios + X4
  identity matrix), `api/r6-x-review-acceptance.test.ts` (X5),
  `api/r6-x-security-acceptance.test.ts` (X8). Acceptance:
  `docs/recovery/r6-lead-autonomy-v1-acceptance-report.md`. R7 handoff:
  `docs/contracts/lead-autonomy-to-business-optimisation-contract.md`.
- **Deferred:** real-MySQL concurrency execution is promoted to R10 /
  pre-production acceptance (schema anchors structurally verified;
  deterministic concurrency green).

---

## 21. Conversion Outcome Intelligence (WBS-R7-A)

The authoritative business-outcome layer: interprets and persists the business
outcome produced by a governed R6-E conversion — what outcome occurred, what
value was realised, what evidence supports it, and whether that value is
final, provisional, reversed, refunded, renewed or otherwise changed. R6-E
proves a conversion occurred; R7-A answers what it was worth. Branch
`feature/r7-a-conversion-outcome-intelligence`, base `8030e97a`.

- Core modules: `api/lib/outcome/` (`outcome-contract`, `outcome-evidence`,
  `outcome-classification`, `outcome-value`, `outcome-identity`,
  `outcome-lifecycle`, `outcome-store`, `outcome-ownership`,
  `outcome-service`, `outcome-projection`); router `api/outcome-router.ts`
  (tRPC `outcome`: `record`, `verify`, `get`, `list`, `r7Projections`,
  `listLifecycle`).
- Identity: deterministic `outcomeId = "out1:" + sha256({tenantUserId,
  businessId, conversionId, evidenceSource, evidenceIdentity})`; exact-once
  per `(userId, conversionId, evidenceSource, evidenceIdentity)`;
  `evidenceHash` binds the immutable core (drift fails closed).
- Closed vocabularies: 12 outcome types (reversal types carry negative
  amounts + `reversesOutcomeId`; `RENEWAL` may carry `renewsOutcomeId`;
  supersession via `supersedesOutcomeId`), 6 statuses (`OBSERVED`,
  `PROVISIONAL`, `VERIFIED`, `REVERSED`, `CANCELLED`, `SUPERSEDED`), 2 value
  types (`MONETARY` integer minor units + closed 20-code currency /
  `NON_MONETARY` quantity + closed metric unit — never a fabricated
  currency), 8 evidence sources → 7 server-derived authority classes
  (VERIFIED_* lands VERIFIED; `user_attestation` PROVISIONAL; unverified
  OBSERVED — never client-selectable).
- Classification is deterministic/rule-first from the canonical conversion
  type + optional closed proposal (subscription/renewal accept UPGRADE/
  DOWNGRADE; ambiguous offline outcomes narrow by proposal; `unknown`
  conversions fail closed). No model is outcome authority; model/client
  output is untrusted data. R6-E conversion amounts are revalidated before
  use as business value (equality cross-check; conflicts fail closed).
- Lifecycle: append-only `business_outcome_lifecycle_events` (`obf1:` facts;
  verification/reversal/refund/cancellation/renewal/supersession) + CAS
  `version` transitions. Full reversal flips the target terminal; partial
  reversal leaves it VERIFIED with the fact recorded; current state is
  derived, history is never edited.
- Security: session `userId` anchors everything; business/conversion/lead/
  lineage ownership re-verified from durable rows every call; client
  authority smuggling fails closed (`OUTCOME_CLIENT_AUTHORITY_FIELD_FORBIDDEN`);
  no billing/payment/CRM/lead writes; projections carry verbatim causation +
  attribution disclaimers (`attributionClaimed: false`).
- Downstream: frozen 27-key `conversion-outcome/v1` projection for R7-B
  attribution / R7-C learning — read-only, no causal fields, net-value
  derivation explicitly downstream-owned. Contracts:
  `docs/contracts/conversion-outcome-intelligence-contract.md`,
  `docs/contracts/conversion-outcome-to-attribution-learning-contract.md`.
- Schema: `business_outcomes` + `business_outcome_lifecycle_events`;
  provisional migration `0035_r7_a_conversion_outcome_foundation` (artefact
  only, NOT executed; `docs/recovery/r7-a-unexecuted-migrations.md`; R7-X
  owns canonical R7 sequencing). Audit: additive `business_outcome_recorded`
  / `business_outcome_lifecycle` (one per durable effect; convergence emits
  zero).
- Acceptance: `api/outcome-acceptance.test.ts` (33 connected adversarial
  cases over the real R6-E + R7-A routers). Report:
  `docs/recovery/r7-a-conversion-outcome-acceptance-report.md`.

---

## 22. Attribution Intelligence (WBS-R7-B)

The authoritative attribution layer: which prior marketing/customer-journey
events are legitimately associated with a canonical R7-A business outcome,
what contribution evidence exists, and how deterministic models allocate
credit. Owns **attribution evidence and attribution results only** — not
outcome truth (R7-A), causal proof, experimentation (R7-D), budget
optimisation (R7-E), or business learning (R7-C).

**Required principle:** *association is not causation.* Attribution
distinguishes observed association, eligible contribution, allocated credit,
and causal evidence. Credit is never causal proof; no client or runtime agent
can mark causation proven, supply weights, or fabricate touchpoints.

- Core modules: `api/lib/attribution/` (`attribution-contract`,
  `attribution-identity`, `attribution-policy`, `attribution-window`,
  `attribution-journey`, `attribution-journey-store`, `attribution-models`,
  `attribution-credit`, `attribution-evidence`, `attribution-outcome-seam`,
  `attribution-store`, `attribution-service`, `attribution-projection`);
  router `api/attribution-router.ts` (`attribution`).
- Outcomes are consumed **only** through the frozen R7-A
  `conversion-outcome/v1` projection (R7-A integrated at R7-X on
  `integration/r7-business-optimisation`; the seam validates the exact
  28-key allowlist + verbatim disclaimers and reads behind a guarded
  information-schema check — X3 owns the canonical outcome→attribution
  binding proof against the integrated authority).
- Journey reconstruction is deterministic and lead-safe: tenant-predicated
  reads, null-or-equal business scope, score-mediated numeric→`lid1` chain
  (`lead_score_snapshots` → `lead_qualifications`), closed touchpoint types
  (`CAMPAIGN`, `PUBLICATION`, `ENGAGEMENT`, `OPPORTUNITY`, `NURTURE_TOUCH`,
  `SALES_HANDOFF`), window/dedup/timestamp exclusion rules with closed reason
  codes. No fuzzy matching, no cross-lead/cross-business stitching, no
  inferred events.
- Closed model set, versioned, deterministic, integer-only:
  `FIRST_TOUCH`, `LAST_TOUCH`, `LINEAR`, `POSITION_BASED`, `TIME_DECAY`
  (7-day half-life, day-granular dyadic weights). Total credit is exactly
  100000 basis points (largest-remainder, deterministic tie-breaks); outcome
  monetary value is read-only reference.
- Evidence classes (closed): `DIRECT_LINKAGE`, `STRONG_ASSOCIATION`,
  `WEAK_ASSOCIATION`, `INSUFFICIENT_EVIDENCE`; confidence
  `HIGH/MEDIUM/LOW/NONE` is a deterministic mapping from evidence quality —
  never model opinion, never causal proof.
- Exact-once: unique `attributionId` +
  `(userId, outcomeId, modelType, modelVersion, windowStart, windowEnd,
  journeyHash)`; retries/concurrency converge (`idempotent_replay`);
  conflicting replay fails closed. Results are immutable; new evidence /
  model-policy change / outcome reversal mints supersession-linked history
  (`supersedesAttributionId` + immutable `attribution_lifecycle_events`
  facts); reversed outcomes retire active credit via a zero-credit successor.
- Privacy gate: R6-F `SUPPRESSED/RESTRICTED/RETENTION_EXPIRED` hard-stops
  evaluation. No upstream (R4/R5/R6/R7-A) table is ever written.
- Schema: `attribution_results`, `attribution_lifecycle_events`
  (stream-local provisional migration `0035_r7_b_attribution_foundation`,
  artefact only — NOT executed; R7-X owns canonical sequencing/collision with
  R7-A's provisional `0035`; see `docs/recovery/r7-b-unexecuted-migrations.md`).
- Contracts: `docs/contracts/attribution-intelligence-contract.md` (canonical),
  `docs/contracts/attribution-to-business-learning-contract.md` (R7-C
  handoff). Acceptance: `api/attribution-acceptance.test.ts` (49 connected
  cases). Inventory: `docs/recovery/r7-b-attribution-inventory.md`.
---

## 23. Optimisation Governance (WBS-R7-F)

The governance authority that constrains business optimisation. The other R7
components (A/B truth + attribution, C learning, D experimentation, E budget
reallocation) are integrated at R7-X and each must pass through this
governance gate before any material effect; governance owns decision policy
only and never learns, experiments, reallocates, bills, or executes itself.
R7-F decides **whether** an optimisation action may proceed —
never **which** action is optimal. Governance may authorize or prohibit; it
must not secretly become the optimisation engine.

- **Owns:** optimisation policy vocabulary (code-level, versioned, immutable —
  no runtime mutation endpoint); closed action taxonomy (unknown actions
  BLOCK); financial authority boundaries (no autonomous total-budget increase
  under the default policy; locked/reserved funds immutable; provider
  allow-list; stale budget state blocks); approval thresholds; risk ceilings;
  experiment governance constraints (concurrency, per-experiment budget,
  prohibited dimensions, duration bounds, protected traits); portfolio
  concentration/shift/oscillation limits; immutable decision receipts
  (`ogd1:`); blocker taxonomy; audit-only narrow recovery; read-only
  operations projection.
- **Decisions (closed):** `ALLOW`, `REVIEW_REQUIRED`, `BLOCK`. Authority only
  ever narrows. Reason codes closed (≤8 per record). Risk tiers
  `low < medium < high < critical`; model/agent output is proposal material
  only — client-supplied `approved`/`override`/`riskClass`/`decision` fields
  are rejected at the boundary.
- **Financial invariant:** an autonomous agent must not increase total
  authorized business spend merely because its algorithm recommends doing
  so. Monetary values are integer minor units; the R4 billing authority
  remains the only settling authority — governance never charges.
- **Approvals:** reuse the `approval_requests` ledger
  (`approvalType = "optimisation_action"`, provisional enum extension in
  unexecuted 0035); the only execution gate is
  `assertOptimisationActionExecutable`, which downstream streams MUST call
  (and revalidate) immediately before any material state change.
- **Core modules:** `api/lib/optimisation-governance/` (`-contract`,
  `-action-taxonomy`, `-policy`, `-financial-governance`,
  `-experiment-governance`, `-portfolio-governance`, `-decision-engine`,
  `-approval`, `-governance-store`, `-governance-service`,
  `-governance-bridge`, `-blocker-taxonomy`, `-operations-projection`);
  router `api/optimisation-governance-router.ts`. Contracts:
  `docs/contracts/business-optimisation-governance-contract.md`; inventory:
  `docs/recovery/r7-f-optimisation-governance-inventory.md`; migration:
  provisional `0035_r7_f_optimisation_governance` (NOT executed,
  `docs/recovery/r7-f-unexecuted-migrations.md`; R7-X owns convergence).
- **Non-billable, non-executing:** no billing, no payments, no providers, no
  CRM, no optimisation algorithm. Audit via the canonical `audit_events`
  ledger (`optimisation_governance_decision`,
  `optimisation_governance_recovery`).
---

## 24. Budget & Portfolio Optimisation (WBS-R7-E)

The governed optimisation layer that converts evidence (R7-A outcomes,
R7-B attribution, R7-C learning), the current campaign portfolio and the
approved budget envelope into **bounded, explainable optimisation
proposals**. Owns optimisation proposal generation and bounded portfolio
allocation only — governance authorizes (R7-F), R4 settles. **Optimisation
proposes; governance authorizes.**

- Core modules: `api/lib/budget-portfolio/` (`budget-portfolio-contract`,
  `portfolio-snapshot`, `evidence-model`, `allocation-solver`,
  `stability-controls`, `governance-seam`, `budget-portfolio-store`,
  `budget-portfolio-service`, `budget-portfolio-bridge`); router
  `api/budget-portfolio-router.ts` (tRPC namespace `budgetPortfolio`).
- Portfolio snapshot (E2): deterministic `psn1:` identity over server-assembled
  authoritative state (campaigns × 100 minor units, committed/reserved,
  locked/disabled keys, supported providers). Client may never supply totals,
  allocations or funds. Stale snapshots fail closed before material action.
- Evidence model (E3): deterministic integer weights — VERIFIED > PROVISIONAL
  outcomes, attribution confidence/evidence class, learning confidence;
  contradicted learning blocks its subject; stale evidence excluded; single
  events capped at 40% of total mass. No model assigns financial weight.
  Provisional-class (MODERATE) evidence shifts ≤ 10% of portfolio per cycle.
- Bounded solver (E4): integer minor units (BigInt internals), Σ proposed ≤
  approved total, pure reallocations conserve money exactly (Σ delta = 0,
  largest-remainder deterministic rounding); concentration ceiling (50%),
  per-cycle shift cap (20% / $500), minimum-allocation floor, locked /
  reserved / disabled / unsupported allocations preserved exactly.
- Stability (E5): cooldown (24h/key), hysteresis band, repeated-reversal hold —
  noisy signals produce `NO_CHANGE`, never thrash.
- Governance binding (E6): every material proposal is evaluated through the
  frozen R7-F seam (`evaluateProposal`), the decision is persisted verbatim
  and re-validated (shape + evaluation fingerprint + proposal fingerprint)
  before authorisation; `assertActionExecutable` is the only execution gate.
  `BLOCK` never executes; `REVIEW_REQUIRED` needs a human approval on the
  ledger; forged/expired/edited approvals and modified proposals fail closed.
  Production wiring (R7-X X5): the canonical port
  (`createCanonicalGovernancePort`) binds the integrated R7-F engine — real
  governed evaluation with the tenant-anchored bridge provider, approval
  reads from the shared ledger, and F's own execution gate; governance
  table absent ⇒ fail-closed (`governance-seam.ts`).
- Execution boundary (E7): emits read-only authorised optimisation
  instructions (`ins1:`) only — no billing/payment/provider/campaign/strategy
  execution anywhere in the stream.
- Downstream (E8): `budgetPortfolio.getStrategyHandoff` exposes the frozen
  23-key read-only projection for R8 strategic intelligence
  (`docs/contracts/business-optimisation-to-strategy-contract.md`,
  `docs/contracts/business-optimisation-to-strategic-intelligence-contract.md`).
- Contracts: `docs/contracts/budget-portfolio-optimisation-contract.md`
  (canonical) + the strategy handoff contract. Inventory:
  `docs/recovery/r7-e-budget-portfolio-inventory.md`. Acceptance:
  `docs/recovery/r7-e-budget-portfolio-optimisation-acceptance-report.md`.
- Schema: `budget_portfolio_snapshots`, `budget_portfolio_proposals`,
  `budget_portfolio_allocation_instructions` — canonical migration
  `0035_r7_business_optimisation_foundation` (R7-X converged; artefact only,
  **NOT executed**; see `docs/recovery/r7-migration-convergence.md`).
- Money: integer minor units everywhere; no floating-point money.

---

## 25. Business Optimisation Integration (WBS-R7-X)

The integrated Business Optimisation system (streams R7-A/B/C/D/E/F merged on
`integration/r7-business-optimisation`; connected lifecycle: R6 conversion →
R7-A outcome truth → R7-B attribution → R7-C learning → R7-D governed
experiment → result → revised learning → R7-E bounded proposal → R7-F
governance/approval → authorised instruction → R8 read-only handoff).

- **Canonical migration:** one `0035_r7_business_optimisation_foundation` (15
  R7 tables + F's accepted `approval_requests.optimisation_action` enum
  extension). Journal/snapshot chain verified; NOT executed
  (`docs/recovery/r7-migration-convergence.md`).
- **Canonical bindings (no duplicate authorities):** B consumes A through
  A's store + integrity assertion + projection builder (X3); C consumes A/B
  the same way with B-lineage reads (X4); D consumes C's experiment
  projection, A/B stores and F's governed evaluation in-process (X5/X6); E's
  evidence provider resolves A/B/C store surfaces and its governance port
  binds F's engine (X5/X7). R7-B's canonical campaign touchpoint identity is
  `campaign:<id>` — C and E parse it prefix-tolerantly.
- **Governance:** R7-F remains the single governance authority; D/E call F's
  evaluate + execution gate; REVIEW_REQUIRED paths need bound human
  approvals; fail-closed when governance is unavailable.
- **Harnesses:** `api/r7-x-harness.test.ts` (40 connected scenarios),
  `api/r7-x-security-acceptance.test.ts` (21 adversarial cases), plus X3–X7
  binding suites. Acceptance:
  `docs/recovery/r7-business-optimisation-v1-acceptance-report.md`.
- **R8 handoff:**
  `docs/contracts/business-optimisation-to-strategic-intelligence-contract.md`
  (read-only strategic evidence; R8 never mutates R7 authority).

---

---

## 26. Strategic Memory (WBS-R8-A)

The authoritative strategic-memory layer: turns durable upstream authorities
(R7-A outcomes, R7-B attribution, R7-C learning, R7-D experiment results,
R7-E proposals/instructions, R7-F governance decisions) plus stable business
context (Business DNA, goals/objectives, strategy history, historical
decisions) into a **versioned strategic memory** — durable context over time,
never rewritten, never silently refreshed. Owns strategic-memory records and
strategic-memory lifecycle only.

**Required principle:** *strategic memory is durable context, not autonomous
strategy.* Facts and assumptions stay distinct; history is immutable;
contradictions stay visible; stale/expired facts never silently remain active;
model-generated summaries are never source authority; no memory record may
authorize spend, experiments, campaigns or strategy changes.

- Core modules: `api/lib/strategic-memory/` (`strategic-memory-contract`,
  `strategic-memory-identity`, `strategic-memory-temporal`,
  `strategic-memory-store`, `strategic-memory-upstream-seam`,
  `strategic-memory-service`, `strategic-memory-projection`); router
  `api/strategic-memory-router.ts` (tRPC namespace `strategicMemory`).
- Identity: deterministic `memoryId = "mem1:" + sha256({tenantUserId,
  businessId, sourceAuthority, sourceIdentity, memoryType, contextScope})`;
  exact-once via durable unique anchors; conflicting replay fails closed;
  immutable-core `evidenceHash`; append-only `smf1:` lifecycle facts with
  CAS-guarded `factStatus` (`CURRENT | STALE | SUPERSEDED | CONTRADICTED |
  EXPIRED | INVALIDATED`).
- Memory types (closed): `BUSINESS_FACT`, `BUSINESS_ASSUMPTION`,
  `STRATEGIC_OBJECTIVE`, `STRATEGIC_DECISION`, `OUTCOME_PATTERN`,
  `LEARNING_PATTERN`, `EXPERIMENT_RESULT`, `OPTIMISATION_DECISION`,
  `CONSTRAINT`. FACT derives only from governed ingestion (R7 authorities,
  Business DNA, strategy snapshots); the operator path (`record`) attests
  ASSUMPTION / objective / decision / constraint only — never FACT.
- R7 ingestion (`ingestR7`) loads every authority field through the frozen
  seam (`strategic-memory-upstream-seam.ts`) — never client-supplied material;
  upstream supersession chains and invalidations (outcome reversal,
  attribution supersession, contradicted learning) re-evaluate dependent
  memory with insert-first lifecycle facts. Attribution stays *association*
  (verbatim disclaimers); experiment results keep design-assumption
  limitations; optimisation memory keeps its governance bound.
- Fail closed on: unknown source, cross-tenant/cross-business evidence,
  stale source contract versions, tampered fingerprints, client-authority
  smuggling (`STRATEGIC_MEMORY_CLIENT_AUTHORITY_FIELD_FORBIDDEN`),
  protected-trait material, assumption without basis/limitations/expiry.
- Downstream: frozen 30-key `strategic-memory-to-reasoning/v1` read-only
  projection for R8-B/C/D/E (`r8Projections` returns only CURRENT memory as
  active). Contracts: `docs/contracts/strategic-memory-contract.md` (canonical),
  `docs/contracts/strategic-memory-to-reasoning-contract.md` (downstream).
- Non-billable, non-executing: no billing, payments, providers, CRM,
  campaigns, experiments, strategy or R7-table writes anywhere in the stream.
- Schema: `strategic_memory_records` + `strategic_memory_lifecycle_events`;
  converged at R8-X into the canonical migration
  `0036_r8_strategic_intelligence_foundation` (artefact only, NOT executed —
  coverage proof `docs/recovery/r8-x-migration-convergence.md`; the stream-local
  `0036_r8_a` provisional was retired after COMPLETE coverage). Audit: additive
  `strategic_memory_recorded` / `strategic_memory_lifecycle` (one per durable
  effect; convergence emits zero).
- Acceptance: `api/strategic-memory-acceptance.test.ts` (36 connected
  adversarial cases over REAL upstream routers/stores + the REAL memory
  router). Report: `docs/recovery/r8-a-strategic-memory-acceptance-report.md`.
## 27. Business Change Intelligence (WBS-R8-B)

The authoritative internal-business-change detection layer: R8-A knows the
durable strategic state; R8-B detects and classifies meaningful internal
changes to that state. Owns change detection and change evidence only — not
external market signals (R8-C), strategic reasoning (R8-D), opportunity/risk
conclusions (R8-E), strategy mutation, Business DNA mutation, budget changes,
campaign execution, governance approval (R8-F), or provider/payment/billing
execution.

**Required principle:** change detection compares authoritative states; it
does not invent change. No change may be inferred solely from model narrative;
no LLM is final change authority.

- Core modules: `api/lib/business-change/` (`-contract`, `-identity`,
  `-detection`, `-significance`, `-temporal`, `-store`,
  `-upstream-seam`, `-memory-seam`, `-projection`, `-service`); router
  `businessChange` (`api/business-change-router.ts`) — `evaluate`, `attest`,
  `correct`, `get`, `list`, `r8Projections`, `listLifecycle`, `sweepExpiry`.
- Flow: R8-A current memory (previous state, read-only via the memory seam
  behind a guarded information-schema check) + newly observed governed
  evidence (R7 budget snapshot / learning / governance, Business DNA snapshot,
  strategy snapshot — all server-loaded) or bounded operator attestation →
  canonical-normalised state comparison → rule-first detection (closed
  directional change types over closed domains: BUSINESS_OBJECTIVE,
  PRODUCT_SERVICE, AUDIENCE, BUDGET, CAPABILITY, PORTFOLIO_PERFORMANCE,
  STRATEGIC_CONSTRAINT, RISK_POSTURE) → confidence-capped significance
  (LOW/MODERATE/HIGH/CRITICAL; PROVISIONAL/OBSERVED evidence can never rank
  HIGH/CRITICAL; only AUTHORITATIVE snapshots can mint CRITICAL) → immutable
  `chg1:` change event (`business_change_events`, evidenceHash-bound core,
  insert-only) → append-only `bcl1:` lifecycle facts (`business_change_lifecycle_events`:
  confirmation via independent-source corroboration only, contradiction via
  exact state-pair revert, supersession via corrections, invalidation, expiry)
  → read-only `business-change-to-reasoning/v1` projection for R8-D/E
  (28-key allowlist, verbatim causation disclaimer, labelled reference-only
  memory candidate, advisory governance eligibility hint).
- Identity/exact-once: `changeId = "chg1:" + sha256(tenant + business +
  subject + changeType + previousStateFingerprint + currentStateFingerprint)`;
  durable unique anchors; replays converge (`idempotent_replay`); the same
  compared states from a different source mint exactly one confirmation fact
  (`corroborating_replay`); conflicting same-source replay fails closed
  (`CHANGE_IDENTITY_CONFLICT`).
- Fail closed on: missing previous/current state, wrong business,
  unsupported/stale source versions, cross-tenant/cross-business sources,
  tampered state fingerprints/evidence hashes, protected-trait material,
  client-supplied authority fields (changeId/status/significance/confidence/
  refs/fingerprints), direct CONFIRMED marking (no boundary path).
- Security: session `userId` anchors everything; ownership re-verified per
  call; prompt-injected text is inert bounded content; a runtime agent can
  never fabricate state, raise significance, suppress contradiction, confirm
  its own evidence, mutate strategic memory/DNA/strategy/budget, execute
  shell/SQL/tools, access secrets, or change its own permissions.
- Non-billable, non-executing: no billing, payments, providers, CRM, campaigns,
  experiments, approvals, or any R7/R8-A table write. Audit via the canonical
  `audit_events` ledger (`business_change_detected`, `business_change_lifecycle`).
- Schema: `business_change_events` + `business_change_lifecycle_events`
  (converged at R8-X into the canonical migration
  `0036_r8_strategic_intelligence_foundation`, artefact only — NOT executed;
  `bce_user_value_fp_idx` reconciled into `db/schema.ts` at convergence;
  `docs/recovery/r8-x-migration-convergence.md`). R7's `0035` untouched.
- Contracts: `docs/contracts/business-change-intelligence-contract.md`
  (canonical), `docs/contracts/business-change-to-strategic-reasoning-contract.md`
  (R8-D/E handoff). Inventory: `docs/recovery/r8-b-business-change-inventory.md`.
  Acceptance: `docs/recovery/r8-b-business-change-acceptance-report.md`.
- Upstream (frozen, consumed by branch ref only, NOT merged): R8-A
  `feature/r8-a-strategic-memory` @ `23d0f22`; R8-F
  `feature/r8-f-strategic-governance` @ `44118e3` (by contract reference for
  the advisory eligibility hint; R8-F remains the recommendation authority).
---

## 28. Strategic Reasoning (WBS-R8-D)

The authoritative strategic-reasoning layer: synthesizes frozen upstream
authorities (R8-A strategic memory `23d0f22`, R8-B business change `055eece`,
R8-C external signals `b366c5e`, R8-F strategic governance `44118e3`) into
bounded, evidence-preserving strategic conclusions. Owns reasoning-session
identity, evidence bundles (`evb1:`), the bounded reasoning graph,
hypotheses, implication classification, support/contradiction accounting,
confidence/uncertainty classification, conclusion lifecycle and governance
binding — never upstream truth, governance authority, opportunity/risk
ranking, strategy mutation or execution.

- **Core modules:** `api/lib/strategic-reasoning/` (`-contract`,
  `-identity`, `-evidence-seam`, `-graph`, `-synthesis`,
  `-governance-seam`, `-store`, `-projection`, `-service`); router
  `api/strategic-reasoning-router.ts` (`strategicReasoning`).
- **Evidence:** clients supply `mem1:`/`chg1:`/`xsig1:` reference ids only;
  every row is server-resolved READ-ONLY behind guarded information-schema
  checks and re-validated (tenant/business scope, frozen contract versions,
  identity patterns, hashes). Cross-tenant/cross-business/unknown/stale-
  version/malformed all fail closed. Same evidence set ⇒ same `evb1:` bundle.
- **Synthesis:** deterministic rule-first engine; model candidates (optional,
  untrusted) may only select among rule-produced hypotheses — never invent
  evidence, raise confidence, suppress contradiction or mint causation.
  Confidence derives from evidence-quality caps (external-only ⇒ LOW,
  single-source ⇒ LOW, assumption-memory ⇒ MODERATE cap, contradiction ⇒
  MODERATE cap, corroborated + verified internal ⇒ HIGH eligible).
- **Governance:** R8-F is mandatory for voiced recommendations; the engine
  binds through a registration port (no second engine; absence fails closed).
  Decisions persist verbatim; REVIEW_REQUIRED approvals are derived read-only
  through F5 binding-hash validation — self-approval is impossible.
- **Lifecycle:** insert-only conclusions (`rsn1:`); re-evaluation mints
  superseding records and records contradiction/staleness as append-only
  `srl1:` facts; history is never edited.
- **Downstream:** `strategic-reasoning-to-opportunity-risk/v1` frozen 34-key
  read-only projection for R8-E (verbatim causation/attribution/execution
  disclaimers). Contracts:
  `docs/contracts/strategic-reasoning-contract.md`,
  `docs/contracts/strategic-reasoning-to-opportunity-risk-contract.md`.
- **Acceptance:** `api/strategic-reasoning-acceptance.test.ts` (42 connected
  cases), `api/strategic-reasoning-security.test.ts` (13 rogue-agent cases).
  Report: `docs/recovery/r8-d-strategic-reasoning-acceptance-report.md`.
- **Schema:** `strategic_reasoning_bundles`, `strategic_reasoning_records`,
  `strategic_reasoning_lifecycle_events` — converged at R8-X into the canonical
  migration `0036_r8_strategic_intelligence_foundation` (artefact only, NOT
  executed; `docs/recovery/r8-x-migration-convergence.md`).
---

## 29. Strategic Opportunity & Risk Intelligence (WBS-R8-E)

The strategic opportunity/risk authority: transforms governed R8-D
conclusions into bounded, evidence-preserving OPPORTUNITY/RISK candidates for
downstream R9 mission-control consideration. Owns candidate identity
(`sor1:`), kind/type classification, deterministic integer impact/urgency/
time-horizon/confidence/priority classification (weak confidence caps
priority; high impact + weak confidence ⇒ review/monitor), support/
contradiction accounting, deduplication + overlap/portfolio interaction
(relations are lineage, never score inputs), lifecycle (`sorl1:` facts,
CAS-versioned status), R8-F governance binding, and the read-only R9 handoff
projection (`strategic-intelligence-to-mission-control/v1`, 37-key exact
allowlist; candidate ≠ mission; recommendation ≠ execution authorization).

- Core modules: `api/lib/strategic-opportunity-risk/` (`-contract`,
  `-identity`, `-reasoning-seam`, `-governance-seam`, `-classification`,
  `-overlap`, `-store`, `-service`, `-projection`); router
  `api/strategic-opportunity-risk-router.ts` (tRPC `strategicOpportunityRisk`):
  `derive`, `get`, `list`, `listRelations`, `listLifecycle`, `reevaluate`,
  `getMissionControlHandoff`.
- **Consumption (frozen upstreams, branch ref only — never merged):** R8-D via
  the `strategic-reasoning-to-opportunity-risk/v1` 34-key projection
  (registration port + raw-SQL durable-row rebuild behind a guarded
  information-schema check; absence fails closed). R8-F mandatory: proposals
  only — decisions `ALLOW_RECOMMENDATION/REVIEW_REQUIRED/BLOCK` bound verbatim;
  approvals read from the shared `strategic_recommendation` ledger with the F5
  binding-hash check; `assertCandidateConsumable` is the only eligibility gate
  (`RECOMMENDATION_ONLY`). R8-A/B/C evidence arrives as lineage refs
  (`mem1:`/`chg1:`/`xsig1:`) through R8-D only.
- **Never owns/never does:** R8-D/A/B/C/F authority, mission planning, strategy
  or Business DNA mutation, budget/campaign/experiment execution,
  provider/payment/billing. No `EXECUTE` semantics anywhere.
- Contracts: `docs/contracts/strategic-opportunity-risk-contract.md` (canonical),
  `docs/contracts/strategic-intelligence-to-mission-control-contract.md`
  (R9 handoff). Inventory/acceptance:
  `docs/recovery/r8-e-strategic-opportunity-risk-inventory.md`,
  `docs/recovery/r8-e-strategic-opportunity-risk-acceptance-report.md`.
- Schema: `strategic_opportunity_risk_candidates/relations/lifecycle_events` —
  converged at R8-X into the canonical migration
  `0036_r8_strategic_intelligence_foundation` (artefact only, NOT executed;
  `docs/recovery/r8-x-migration-convergence.md`).
- Audit: additive `strategic_candidate_derived` / `strategic_candidate_lifecycle`
  (one per durable effect; convergence emits zero).
- Acceptance: `api/strategic-opportunity-risk-acceptance.test.ts` (46 connected
  cases) + `api/strategic-opportunity-risk-security.test.ts` (11 adversarial
  cases).
