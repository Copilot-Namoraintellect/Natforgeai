# Product Roadmap — NatForge AI

## Completed Phases

### Phase 1: Autonomous Core
- User registration and authentication (local, Google OAuth, Firebase)
- Business profile creation
- Campaign creation and management
- Basic workflow state machine
- Agent runner foundation

### Phase 2: Creative and Publishing
- Creative Agent (copywriting for social posts)
- Content Studio (post editor, media upload)
- Publishing queue with scheduling
- Calendar view
- Templates system

### Phase 3: Audience and CRM Automation
- Audience Agent (customer profiling)
- Lead management and scoring
- Lead activity tracking
- Sales Agent (follow-up sequences)
- Engagement Agent foundation

### Phase 4: Social Integration Foundation
- OAuth connections for Facebook, Instagram, LinkedIn, X, TikTok
- Platform publishing adapters
- Webhook foundation for inbound messages
- Integration testing and account management

### Phase 4.5/4.7: Infrastructure Readiness
- Redis integration for caching and OAuth state
- BullMQ for reliable job queuing
- Rate limiting (per-IP, per-user tier)
- Database index audit (50+ indexes)
- System health monitoring endpoints
- Production cost controls

### Phase 4.6: Billing Engine
- Credit wallet system
- Per-model AI usage tracking
- Subscription tier credit allocation
- Atomic credit deduction with race-condition protection
- Admin profitability dashboard

### Phase 4.8: Production Readiness
- Zero TypeScript errors
- Automated monthly credit renewal
- Publishing failure alerting
- System alert management
- Extended production monitoring
- Stakeholder architecture documentation

---

## Next Phases

### Phase 5: Optimisation Agent
**Goal**: Close the feedback loop between campaign performance and strategy refinement.

- Analyse publishing performance (engagement rates, click-through, conversions)
- Recommend creative refreshes and A/B tests
- Suggest audience segment adjustments
- Auto-pause underperforming campaigns
- Budget reallocation recommendations
- **ETA**: 6–8 weeks

### Phase 6: Social Listening
**Goal**: Monitor brand mentions, competitor activity, and trending topics.

- Ingest social platform webhooks (comments, mentions, DMs)
- Sentiment analysis on inbound messages
- Competitor mention tracking
- Trending topic detection per industry
- Auto-generate reactive content
- **ETA**: 8–10 weeks

### Phase 7: Prospect Discovery
**Goal**: Find and engage cold prospects autonomously.

- Social prospecting (LinkedIn, X) based on ideal customer profile
- Automated connection requests with personalised messages
- Prospect enrichment from public data
- Cold outreach sequence management
- **ETA**: 10–12 weeks

### Phase 8: Revenue Attribution
**Goal**: Connect marketing activity to revenue outcomes.

- UTM tracking across all published content
- Lead-to-customer conversion tracking
- Channel ROI analysis
- Customer acquisition cost (CAC) by campaign
- Lifetime value (LTV) forecasting
- **ETA**: 12–14 weeks

### Phase 9: Autonomous Sales Agent
**Goal**: Handle complete sales conversations from first contact to meeting booking.

- Natural language sales conversations via WhatsApp, DM, Email
- Objection handling with product knowledge base
- Meeting scheduling integration (Calendly, Google Calendar)
- Proposal generation with pricing logic
- Contract drafting (basic)
- **ETA**: 14–18 weeks

---

## Future Vision (2026+)

- **Multi-language campaigns**: Generate and publish in 20+ languages
- **Video generation**: Auto-generate short-form video content
- **Paid ads automation**: Meta Ads, Google Ads, TikTok Ads creation and optimisation
- **SEO agent**: Keyword research, blog generation, backlink outreach
- **Agent marketplace**: Third-party specialised agents (e.g., real estate, hospitality, SaaS)
- **Enterprise features**: SSO, audit logs, role-based access, compliance certifications
