# R8-C Market & External Signal Intelligence — Inventory (C0)

> **Stream:** R8-C Market & External Signal Intelligence
> **Branch:** `feature/r8-c-market-external-signals`
> **Base:** `a2c084a1f0bca110a00e51f83632733789cec5f7` (R7-X accepted HEAD, `BUSINESS_OPTIMISATION_V1_READY`)
> **Date:** 2026-11-12
> **Status:** pre-implementation inventory — inspected before editing (mission C0)

---

## 1. What exists today (inspected)

### 1.1 Existing listening / ingestion providers

- **R5-A social listening** (`api/lib/social-listening/`): provider adapters for
  `meta`, `linkedin`, `twitter`, `tiktok`; webhook ingest
  (`webhook-ingest.ts`), polling (`polling.ts`), listening state store.
  Provider-neutral normalized **social signal** model (`signal-contract.ts`):
  one logical provider event `(provider, providerAccountId, externalEventId)`
  → one deterministic `sigv1:` identity, exact-once via
  `social_signals.ss_natural_key_uidx`. Signal types are *operational
  engagement* events: `comment`, `reply`, `mention`, `reaction`,
  `direct_message`, `repost`, `follow`, `unfollow`, `campaign_response`,
  `inbound_message`, `unknown`.
- **R5-B intent & sentiment** (`api/lib/intelligence/`): interpretations over
  R5-A canonical signals; `confidence.ts`, `input-safety.ts` (untrusted-text
  sanitization), `model-boundary.ts` (prompt-injection-resistant model path:
  delimited untrusted-data blocks, strict output schema, post-run
  re-validation).
- **R5-D opportunity detection** (`api/opportunity-router.ts`): pre-lead
  candidate evaluation over R5-B interpretations. Owns opportunity candidates,
  not external market evidence.
- **No news/web/market ingestion exists anywhere.** There is no RSS/web/news
  provider, no external-source registry, no URL/domain trust machinery, no
  corroboration engine. R8-C greenfield for market/external evidence.

### 1.2 External source metadata / identity primitives already in the repo

- **R6-E conversion-trust registry** (`api/lib/conversion/conversion-trust.ts`):
  closed, deterministic server-side mapping `sourceSystem → trustClass`; the
  client can never supply or influence a trust class. This is the house
  pattern R8-C mirrors for *source* trust (registry is code-level/server-side).
- **Canonical hashing** (`api/lib/attribution/attribution-contract.ts`):
  `canonicalJson` + `sha256Hex` pure helpers, deterministic identity without
  wall-clock/randomness.
- **Exact-once stores** (`attribution-store.ts`, `outcome-store.ts`):
  insert-first persistence, durable unique natural keys, duplicate-key
  convergence → `idempotent_replay`, conflicting replay → typed conflict
  error. House pattern R8-C reuses.
- **Ownership re-verification** (`outcome-ownership.ts`): business/conversion
  re-verified from durable rows every call; cross-tenant/cross-business fails
  closed with typed ownership errors.
- **Freshness / temporal state**: R7-A outcomes derive status from timestamps
  + append-only lifecycle facts (`business_outcome_lifecycle_events`,
  `obf1:` ids); R8-A (frozen contract) defines deterministic temporal state
  recomputed identically at read. R8-C adopts the same model.
- **Lifecycle visibility**: R7-B attribution supersession keeps history
  (`supersedesAttributionId` + immutable `atf1:` facts); R8-A contract §7
  contradiction/supersession visibility semantics.

### 1.3 URLs / domain handling

- No normalized URL/domain authority exists. `businesses.website` is a free
  text field. OAuth redirect URIs are env-configured constants. R8-C will
  define its own *safe normalized source reference* (origin-key normalization:
  lowercase host + registrable-domain-style key, credentials/tracking params
  stripped, length-bounded) — pure, deterministic, in-stream.

### 1.4 Timestamps

House convention: ISO 8601 **verbatim text** columns (`varchar(32)`), explicit
`occurredAt`/`recordedAt` pairs, injected `now` in services (test-controlled
clocks), ±5 min future-skew tolerance where backdating is bounded (R7-A/R8-A).

### 1.5 Source verification / trust / reputation concepts

- **R8-F trust taxonomy** (frozen contract §5, consumed not merged):
  `AUTHORITATIVE_INTERNAL > VERIFIED_EXTERNAL > CORROBORATED_EXTERNAL >
  SINGLE_EXTERNAL_SOURCE > UNVERIFIED > CONTRADICTED > MALFORMED`, all
  server-derived. Derivation: model-generated never source truth; active
  contradiction → CONTRADICTED; internal authoritative → AUTHORITATIVE_INTERNAL;
  external source on the **server-side registered-source registry** →
  VERIFIED_EXTERNAL; ≥ 2 independent corroborating sources →
  CORROBORATED_EXTERNAL; exactly 1 → SINGLE_EXTERNAL_SOURCE; no provenance →
  UNVERIFIED; absent/forged/cross-tenant → blocked. Confidence closed scale
  `NONE < LOW < MEDIUM < HIGH`; unverified caps at LOW, single-source caps at
  LOW, contradiction caps at NONE.
- R5-B has per-interpretation confidence; R7-B has evidence classes
  (`DIRECT_LINKAGE … INSUFFICIENT_EVIDENCE`). Neither is a *source* trust
  authority — no competing authority is created or reused for sources.

### 1.6 Prompt-injection defenses already present

- R5-B `input-safety.ts`: malformed-unicode rejection, NFC normalization,
  control/format char stripping, char caps.
- R5-B `model-boundary.ts`: untrusted data delimited under an explicit system
  contract; model output channel is a strict schema; output re-validated after
  the runner returns; model output is candidate material only.
- R8-F contract §10 (F6): containment by construction — no LLM in the
  governance decision path, deterministic rules only, injection-shaped content
  only raises risk + annotates `PROMPT_INJECTION_SUSPECTED`.
- R8-C mirrors this stance: **no model in any authority path**; external
  content is inert evidence with deterministic injection-pattern detection
  for annotation only.

### 1.7 R8-F governance authority (frozen, branch ref only)

- `feature/r8-f-strategic-governance` @ `44118e3` — strategic-intelligence
  governance: decides whether a recommendation may be voiced;
  `ALLOW_RECOMMENDATION | REVIEW_REQUIRED | BLOCK`; owns evidence/source-trust
  derivation *for recommendations*. R8-C must not mint governance decisions
  and must not create a competing trust taxonomy — it supplies source trust
  **inputs** in F's exact closed vocabulary.
- `feature/r8-a-strategic-memory` @ `23d0f22` — durable strategic context
  (memory), consumed by R8-C for *business relevance* inputs (Business DNA
  context, strategic memory subjects) via its read-only projection contract at
  integration. Not merged.

### 1.8 Audit

Canonical `audit_events` ledger (`api/lib/audit/`), domain-neutral material
taxonomy (`AUDIT_EVENT_TYPES`), immutable envelope, metadata hygiene strips
sensitive keys. One canonical event per durable effect; convergence/replay
emits zero. R8-C adds `external_signal_recorded` / `external_signal_lifecycle`
(additive; R8-X owns taxonomy convergence).

### 1.9 Schema / migration state

- Executed: through `0033_opportunity_detection_foundation` (R1–R5 era);
  `0034_r6_lead_autonomy_foundation` + `0035_r7_business_optimisation_foundation`
  exist as **canonical but unexecuted** artefacts (R6-X/R7-X convergence docs).
- Provisional R8 `0036` migrations already exist on sibling branches:
  `0036_r8_a_strategic_memory_foundation` (R8-A), `0036_r8_f_strategic_governance_foundation`
  (R8-F). **Collision documented, not converged** — R8-X owns sequencing.
  R8-C adds its own stream-local `0036_r8_c_market_external_signal_foundation`
  (artefact only, NOT executed; see `docs/recovery/r8-c-unexecuted-migrations.md`).

---

## 2. Reusable primitives (adopted)

| Primitive | Source | Use in R8-C |
|---|---|---|
| `canonicalJson` / `sha256Hex` | `api/lib/attribution/attribution-contract.ts` | deterministic source/signal identity + evidence hashes |
| Insert-first exact-once store + duplicate-key convergence | `attribution-store.ts` / `outcome-store.ts` | `external_sources` / `external_signals` / lifecycle stores |
| Ownership re-verification from durable rows | `outcome-ownership.ts` | business anchor + corroboration/contradiction ref scope checks |
| zod `strictObject` boundary + client-authority guard | all R6/R7 contracts | ingest boundary: clients supply source *material* only, never trust/relevance/confidence/status |
| Audit ledger | `api/lib/audit/` | `external_signal_recorded` / `external_signal_lifecycle` |
| Untrusted-content normalization stance | R5-B `input-safety.ts` (pattern) | inert-content normalization + injection-pattern detection (in-stream, no cross-stream import) |
| Temporal derivation recomputed at read | R7-A / R8-A contract §8 | freshness classes from timestamps vs policy thresholds |

## 3. R8-C boundary (defined)

- **R5 owns:** operational social/engagement signals (provider events on owned
  social accounts), their interpretation, engagement, opportunity candidates.
  R8-C **never** writes `social_signals`, interpretations, engagements, or
  opportunity tables, and never creates a second social-listening authority.
- **R8-C owns:** external/market evidence — competitor actions, pricing
  changes, product launches, category/market shifts, consumer demand signals,
  regulatory changes, technology developments, channel/platform changes,
  macro/business-environment changes, reputational/brand signals,
  supply/ecosystem changes — plus source identity/provenance, source-trust
  *input* classification (F vocabulary), corroboration/contradiction evidence,
  freshness, business relevance, lifecycle, immutable history, and the
  read-only downstream projection.
- **R8-C must not own:** strategic memory (R8-A), business-change authority
  (R8-B), strategic reasoning (R8-D), opportunity/risk conclusions (R8-E),
  governance policy/decisions (R8-F), execution of any kind (campaigns,
  strategy, budget, Business DNA, providers/payments/billing).

## 4. Gaps requiring new build (greenfield in R8-C)

1. External source identity + server-side registered-source registry
   (tenant-scoped, deterministic `src1:` identity, server-derived registry
   class; official-source allow-list is code-level policy).
2. Safe normalized source reference (origin-key normalization) + spoof/malform
   rejection.
3. Signal identity (`xsig1:`) bound to source + normalized event identity;
   exact-once convergence of duplicate source copies.
4. Inert-content isolation + deterministic injection-pattern annotation.
5. Corroboration engine with **source-independence** (syndicated copies of one
   source never count as independent).
6. Freshness policy (per-signal-type thresholds, code-level).
7. Deterministic business-relevance classification (rule-first; model may
   propose, server bounds; exact matched-term evidence retained).
8. Contradiction + supersession lifecycle with immutable `xsf1:` facts.
9. Read-only `external-signal/v1` downstream projection for R8-D/E.
