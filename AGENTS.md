# NatForge AI — Complete Feature Documentation

> **Last updated:** 2026-10-30 (R6-X integration: §18 Lead Identity WBS-R6-A; §19 Lead Qualification WBS-R6-C)
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
