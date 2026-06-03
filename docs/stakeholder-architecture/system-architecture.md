# System Architecture — NatForge AI

## Full Architecture Overview

NatForge AI is a modern full-stack application built with a React frontend, Hono/tRPC backend, MySQL database, Redis cache, and BullMQ job queues. The system is designed for deployment on Windows IIS servers with Cloud SQL MySQL.

```
┌─────────────────────────────────────────────────────────────────────┐
│                           CLIENT LAYER                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌───────────┐ │
│  │   Browser   │  │   Mobile    │  │  Webhook    │  │   OAuth   │ │
│  │   (React)   │  │  (Future)   │  │  Listeners  │  │ Callbacks │ │
│  └──────┬──────┘  └─────────────┘  └──────┬──────┘  └─────┬─────┘ │
└─────────┼──────────────────────────────────┼───────────────┼───────┘
          │ HTTPS / WebSocket                │ POST          │ GET
┌─────────┼──────────────────────────────────┼───────────────┼───────┐
│         ▼                                  ▼               ▼       │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                     BACKEND LAYER (Hono)                       │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐ │ │
│  │  │  tRPC Router │  │  OAuth       │  │  Webhook Handlers    │ │ │
│  │  │  (REST/RPC)  │  │  Callback    │  │  (Meta, Twilio, etc) │ │ │
│  │  └──────┬───────┘  └──────────────┘  └──────────────────────┘ │ │
│  │         │                                                      │ │
│  │  ┌──────┴──────────────────────────────────────────────────┐   │ │
│  │  │              AI AGENT LAYER                              │   │ │
│  │  │  Strategy → Creative → Audience → Distribution          │   │ │
│  │  │  Engagement → Sales → Optimisation (Phase 5)            │   │ │
│  │  └────────────────────────────────────────────────────────┘   │ │
│  │                                                               │ │
│  │  ┌─────────────────────────────────────────────────────────┐  │ │
│  │  │              WORKFLOW ENGINE                             │  │ │
│  │  │  State machine · Triggers · Approval gates · Safety     │  │ │
│  │  └─────────────────────────────────────────────────────────┘  │ │
│  └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
          │                              │                    │
          ▼                              ▼                    ▼
┌─────────────────┐        ┌─────────────────────┐   ┌──────────────┐
│   Cloud SQL     │        │       Redis         │   │   OpenAI     │
│   MySQL 8.4     │        │  (Cache / Sessions) │   │   API        │
│                 │        │                     │   │              │
│  Users          │        │  OAuth state        │   │  GPT-4o      │
│  Campaigns      │        │  Rate limit windows │   │  DALL-E      │
│  Content        │        │  BullMQ queues      │   │  (Future)    │
│  Leads          │        │                     │   │              │
│  Billing        │        │                     │   │              │
│  System Alerts  │        │                     │   │              │
└─────────────────┘        └─────────────────────┘   └──────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     PUBLISHING WORKER (BullMQ)                       │
│                                                                      │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────────┐ │
│  │  Job Queue  │───▶│   Worker    │───▶│  Social Platform APIs   │ │
│  │  (BullMQ)   │    │  (worker.js)│    │  (Meta, LinkedIn, X)   │ │
│  └─────────────┘    └─────────────┘    └─────────────────────────┘ │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Frontend Layer

**Technology**: React 19, Vite 7, Tailwind CSS, shadcn/ui, React Router

The frontend is a single-page application (SPA) that communicates with the backend exclusively via tRPC over HTTP. It is built into static assets and served by the Hono backend in production.

**Key responsibilities:**
- User interface for campaign creation, content editing, and lead management
- Approval Centre for human-in-the-loop review
- Admin dashboard for user management, billing, and system health
- Real-time feedback via toast notifications and loading states

**Pages:**
- Home, Login, Pricing, Onboarding
- Mission Control (dashboard), Campaigns, Content Studio, Calendar
- Leads, Integrations, Settings, Approval Centre
- Admin, System Health, Alerts, Credits, Agent Activity

---

## Backend / API Layer

**Technology**: Hono (Node.js), tRPC v11, Zod validation

The backend is a monolithic Hono application that mounts tRPC routers for type-safe API communication.

**Routers:**
| Router | Purpose |
|--------|---------|
| `auth` | Registration, login, JWT, Firebase auth |
| `campaign` | CRUD for campaigns, workflow state |
| `content` | Content posts, templates, generated images |
| `lead` | Lead management, scoring, activities |
| `agent` | Trigger agent runs, view run history |
| `integration` | OAuth connections, platform testing |
| `publishing` | Publishing queue, scheduling, approvals |
| `approval` | Approval requests, edit-and-approve |
| `billing` | Wallet, transactions, usage, admin profitability |
| `health` | System health, queue stats, alerts |
| `admin` | User management, payments, subscriptions |
| `analytics` | Campaign performance metrics |

**Middleware:**
- `publicQuery` — no auth required
- `authedQuery` — valid JWT required
- `adminQuery` — admin role required
- `aiActionQuery` — auth + rate limiting + credit check
- `publishActionQuery` — auth + publishing rate limiting

---

## AI Agent Layer

**Technology**: `@ai-sdk/openai` (GPT-4o-mini), `ai` SDK `generateObject`

Each agent is a TypeScript module that:
1. Accepts structured inputs (business context, campaign data, user prompts)
2. Calls `generateObject` with a Zod schema for structured output
3. Deducts credits before execution
4. Records usage in `ai_usage` table
5. Updates workflow state on completion

**Agent runner** (`api/lib/agents/runner.ts`) provides:
- Pre-flight billing check
- Cost control enforcement (daily/monthly limits)
- Run state tracking (`agent_runs` table)
- Error handling and alert creation on provider failure

---

## Workflow Engine

**Technology**: Drizzle ORM + MySQL + tRPC mutations

The workflow engine is a 15-state state machine that drives campaign lifecycle:

1. User creates a campaign → state = `business_onboarding`
2. Strategy Agent completes → state = `strategy_generated`
3. User approves strategy → state = `strategy_approved`
4. Creative Agent completes → state = `creatives_ready`
5. Audience Agent completes → state = `audience_ready`
6. Distribution Agent completes → state = `schedule_generated`
7. Launch approval (if required) → state = `campaign_live`
8. Publishing begins → state = `engagement_active`
9. Leads convert → state = `leads_converting`
10. Optimisation begins (Phase 5) → state = `optimisation_active`
11. Campaign completes → state = `completed`

State transitions are triggered by agent completion, approval resolution, or manual user action.

---

## Database Layer

**Technology**: Cloud SQL MySQL 8.4, Drizzle ORM, mysql2 driver

The database uses **soft relations** (no foreign key constraints) for PlanetScale compatibility. All relationships are enforced in application code.

**Key tables:**
- `users` — authentication, roles, onboarding state
- `campaigns` — campaign data, workflow state, AI-generated flag
- `businesses` — business profiles, industry, goals
- `content_posts` — AI-generated social media content
- `publishing_queue` — scheduled posts with retry logic
- `social_integrations` — OAuth tokens (encrypted)
- `leads` — CRM leads with scoring
- `agent_runs` — execution history for every agent
- `credit_wallets` / `credit_transactions` — billing ledger
- `ai_usage` — per-action cost tracking
- `system_alerts` — production monitoring alerts
- `subscriptions` / `subscription_tiers` / `payments` — subscription management

---

## Redis / BullMQ Layer

**Technology**: Redis (Upstash or self-hosted), BullMQ, ioredis

**Redis responsibilities:**
- OAuth state storage (15-minute TTL)
- Rate limit sliding windows (per-IP, per-user)
- Session caching (future)

**BullMQ responsibilities:**
- Publishing job queue with delayed scheduling
- Retry logic with exponential backoff
- Job completion/failure tracking
- Queue depth monitoring

**Fallback:** If Redis is not configured, the dev cron runner (`startPublishingRunner`) polls the database every 60 seconds.

---

## Publishing Worker

**Technology**: BullMQ Worker, standalone `worker.ts` entry point

The publishing worker is a separate Node.js process that:
1. Connects to the BullMQ queue via Redis
2. Processes publishing jobs (dequeue → publish to platform API → mark complete)
3. Handles failures with retry logic
4. Deducts credits on first attempt only

**Production:** `node dist/worker.js`  
**Development:** Cron runner in `boot.ts` checks every 60 seconds

---

## External Integrations

| Platform | Integration Type | Status |
|----------|-----------------|--------|
| **OpenAI** | API (GPT-4o-mini) | ✅ Live |
| **Meta (Facebook/Instagram)** | OAuth + Graph API | ✅ Live |
| **LinkedIn** | OAuth + API | ✅ Live |
| **X (Twitter)** | OAuth + API | ✅ Live |
| **TikTok** | OAuth stub | 🔄 Planned |
| **WhatsApp** | Meta Business API | ✅ Live |
| **Email** | SMTP / SendGrid | ✅ Live |
| **Firebase** | Authentication | ✅ Live |
| **Stripe** | Payments (future) | 🔄 Planned |

---

## Cloud SQL Database

**Configuration:**
- **Engine**: MySQL 8.4 (Google Cloud SQL)
- **Instance type**: db-n1-standard-2 or higher recommended
- **Storage**: SSD, auto-expand
- **Backups**: Automated daily backups with point-in-time recovery
- **SSL**: Required for all connections
- **Connection**: Via Cloud SQL Proxy or private IP

**Migrations:**
- Managed via Drizzle Kit (`npm run db:migrate`)
- Manual Cloud SQL Studio patch available for environments without CLI access
- All migrations are idempotent (safe to rerun)

---

## IIS / Windows Hosting Context

NatForge is deployed on **Windows IIS** servers with the following configuration:

- **OS**: Windows Server 2022
- **Web Server**: IIS 10 with URL Rewrite module
- **Node.js**: v20+ (managed via IISNode or Windows Service)
- **Process Manager**: `dist/boot.js` runs as a Windows Service or via IISNode
- **Worker**: `dist/worker.js` runs as a separate Windows Service
- **Static Assets**: Vite-built SPA served from `dist/public/`
- **SSL**: Terminated at IIS; internal traffic over HTTP to Node.js

**Build output:**
- `dist/boot.js` — Main web server (13.9 MB bundled)
- `dist/worker.js` — Publishing worker (6.1 MB bundled)
- `dist/public/` — Frontend SPA assets
