# MARKET & EXTERNAL SIGNAL CONTRACT (WBS-R8-C)

> **Stream:** R8-C Market & External Signal Intelligence
> **Branch:** `feature/r8-c-market-external-signals`
> **Status:** canonical R8-C contract — downstream (R8-D/E, and R8-X
> integration) consumes, never redefines
> **Contract version:** `market-external-signal/v1`
> **Upstream (frozen, consumed not merged):** R7 Business Optimisation V1
> (`a2c084a1…`); R8-A Strategic Memory (`23d0f22…`, business-context inputs via
> its read-only projection contract at integration); R8-F Strategic Governance
> (`44118e3…`, trust vocabulary §4 below — consumed, never redefined).
> **Implementation:** `api/lib/market-signals/`; router `marketSignal`
> (`api/market-signal-router.ts`); schema `external_sources`,
> `external_signals`, `external_signal_lifecycle_events` (stream-local
> provisional migration `0036_r8_c_market_external_signal_foundation`, artefact
> only — NOT executed; R8-X owns convergence).

---

## 1. Purpose and authority boundary

R8-C safely ingests, normalizes, corroborates and classifies **external
evidence relevant to strategic reasoning**. It answers: what external event or
signal was observed; where it came from; how trustworthy the source is;
whether the evidence is corroborated; whether it is current; whether it is
strategically relevant to this business; whether it is merely a signal or a
verified external fact; whether contradictory external evidence exists; and
whether the signal can safely enter strategic reasoning.

**External content is untrusted data. A signal is evidence, never authority.**
No signal may authorize spend, campaigns, experiments, strategy changes,
Business DNA changes, or any execution, and no signal is ever causal or
attribution proof.

R8-C owns: external source identity; signal identity; source provenance;
normalized signal type; signal evidence; source-trust **input**
classification (R8-F vocabulary); corroboration evidence; contradiction
evidence; freshness; business relevance; lifecycle; immutable signal history;
the current external-signal projection.

R8-C does **not** own: R8-A strategic memory; R8-B business-change authority;
R8-D strategic reasoning; R8-E opportunity/risk conclusions; R8-F governance
policy/decisions; external execution; strategy mutation; budget mutation;
Business DNA mutation; provider/payment/billing authority. It creates **no
competing authority** for R5 social listening (operational social/engagement
signals remain R5-A's), R8-A memory, or R8-F governance.

**Boundary vs R5:** R5-A owns operational social/engagement signals from
connected social accounts (`sigv1:` family). R8-C owns strategic
external/market evidence (`xsig1:` family). R8-C never writes R5 tables; R5
signals never enter the R8-C trust/corroboration machinery.

## 2. Core principles (binding)

1. External content is untrusted data — inert evidence, never instructions.
2. Source trust is server-derived, never source-declared or client-supplied.
3. Model summaries do not create external facts (model output is candidate
   material only and never enters any identity, hash, trust, or status field).
4. Single-source claims remain bounded (confidence ceiling `LOW`).
5. Corroboration relies on genuinely independent evidence; syndicated copies
   of one source never count as independent corroboration.
6. Contradictions remain visible — misinformation history is never deleted.
7. Prompt injection remains inert content (detection annotates; nothing
   executes).
8. External signals never directly mutate strategy, budget, Business DNA or
   campaigns — no execution path exists in this stream.
9. Stale signals cannot silently remain current (deterministic temporal
   classes; the current projection excludes non-current evidence).
10. Signal relevance is separate from signal truth (relevance never raises
    confidence or trust).

## 3. Record shape and closed vocabularies

`contractVersion = "market-external-signal/v1"` on every record and
projection.

| Field | Type | Rule |
|---|---|---|
| `signalId` | `xsig1:` + sha256-64 | Server-minted only (§5). |
| `userId` / `businessId` | bigint | Session tenant + server-verified business ownership. |
| `signalType` | closed enum (§3.1) | Client-proposed + server-validated. |
| `subjectType` | closed enum (§3.2) | Client-proposed + server-normalized. |
| `subjectRef` | bounded string ≤191 | Opaque external subject reference (competitor name, ticker, regulation id, …), verbatim, safe pattern. |
| `claimAspect` | bounded string ≤64 | The aspect of the subject the claim addresses (e.g. `price_change`, `launch`, `entry`, `policy_change`), safe pattern; participates in the claim family. |
| `sourceId` | `src1:` + sha256-64 | Server-minted source identity (§5). |
| `sourceType` | closed enum (§3.3) | Client-proposed + server-validated. |
| `sourceUriRef` | bounded string ≤191 | Safe normalized source reference — scheme + host + path only; credentials, query and fragment stripped server-side (§5.4). |
| `eventKey` | bounded string ≤191 | Normalized publication/event identity within the source (article path, filing id, …); safe pattern. |
| `sourceRegistryClass` | closed enum (§3.4) | Server-derived only — the source's standing in the server-side registry. |
| `sourceTrustClass` | closed enum (§3.5) | Server-derived only, exact R8-F vocabulary (§4). |
| `sourceIndependenceKey` | bounded string ≤191 | Server-derived publisher/origin key used for corroboration independence (§6). |
| `claimText` | bounded text ≤2048 | Inert untrusted content, normalized (§7). Never authority. |
| `claimKey` | sha256-64 | Deterministic claim fingerprint (§5.3). |
| `claimFamilyKey` | sha256-64 | Deterministic claim-family fingerprint (§5.3). |
| `evidenceHash` | sha256-64 | Immutable-core hash (§5.5); drift = tampering. |
| `observedAt` | ISO 8601 ≤32 | When the event was observed by the reporter. |
| `publishedAt` | ISO 8601 ≤32 \| null | When the source published it, where known. |
| `ingestedAt` | ISO 8601 ≤32 | Server acceptance time. |
| `freshnessClass` | closed enum (§3.6) | Server-derived from timestamps vs policy (§8); recomputed identically at read. |
| `corroborationStatus` | closed enum (§3.7) | Server-derived (§6). |
| `corroboratingSignalIds` | `xsig1:…[]` ≤16 | Independent corroborating signals (same `claimKey`), verbatim ids. |
| `contradictingSignalIds` | `xsig1:…[]` ≤16 | Signals this record contradicts (validated scope + family), verbatim ids. |
| `relevanceClass` | closed enum (§3.8) | Server-derived; model may propose, server bounds (§9). |
| `relevanceEvidence` | JSON closed shape | Exact matched-term evidence (§9); preserved verbatim into every projection. |
| `confidenceClass` | closed enum (§3.9) | Server-derived deterministic mapping (§10); never client-supplied. |
| `signalStatus` | closed enum (§3.10) | Denormalized current lifecycle status; CAS-guarded transitions only. |
| `contentIsolation` | `"INERT_EVIDENCE"` | Constant — external content is inert evidence. |
| `injectionSuspected` | boolean | Server-derived annotation (§7); never authority, never suppresses storage. |
| `limitations` | `string[]` ≤8 × ≤191 | Preserved verbatim into every projection. |
| `modelAssistance` | JSON \| null | Bounded candidate-extraction metadata; excluded from every identity and hash; never authority. |
| `supersedesSignalId` | `xsig1:…` \| null | Exact predecessor binding (§11). |
| `version` | int | Optimistic-CAS guard for lifecycle transitions. |
| `createdAt` | timestamp | DB default. |

### 3.1 Signal types (closed)

```
COMPETITOR_ACTION        MARKET_DEMAND           PRICING_CHANGE
PRODUCT_LAUNCH           REGULATORY_CHANGE       TECHNOLOGY_CHANGE
CHANNEL_PLATFORM_CHANGE  MACRO_ENVIRONMENT       REPUTATION_SIGNAL
ECOSYSTEM_CHANGE
```

### 3.2 Subject types (closed)

```
COMPETITOR  MARKET_CATEGORY  PRODUCT  SERVICE  REGULATION  TECHNOLOGY
CHANNEL  PLATFORM  BRAND  CONSUMER_SEGMENT  SUPPLIER  PARTNER
MACRO_INDICATOR  BUSINESS_SELF  UNKNOWN
```

### 3.3 Source types (closed)

```
OFFICIAL_GOVERNMENT   OFFICIAL_REGULATOR   OFFICIAL_COMPANY   NEWS_WIRE
NEWS_MEDIA            INDUSTRY_ANALYST     SOCIAL_PLATFORM    AGGREGATOR
UNKNOWN_SOURCE
```

### 3.4 Source registry classes (closed, server-derived)

| Class | Meaning |
|---|---|
| `OFFICIAL` | Source origin is on the code-level official-source allow-list (government/regulator/official-company domains; policy is code-level, immutable, no runtime mutation endpoint). |
| `VERIFIED` | Source is tenant-registered and has passed the deterministic registry verification (origin shape valid, not a look-alike/spoof of an official origin, server-resolved). |
| `UNVERIFIED` | Default: unregistered or failed verification. |

The registry is a **server-side** table (`external_sources`); rows are minted
by the deterministic identity (§5.2) at first ingest. A source can never mark
itself trusted — `sourceRegistryClass` is never client-supplied.

### 3.5 Source trust classes (closed, server-derived)

Exact R8-F §5 vocabulary (consumed, not redefined):

```
VERIFIED_EXTERNAL   CORROBORATED_EXTERNAL   SINGLE_EXTERNAL_SOURCE
UNVERIFIED          CONTRADICTED            MALFORMED
```

(`AUTHORITATIVE_INTERNAL` exists in R8-F for internal evidence and never
applies to external signals.) Derivation precedence in §4.

### 3.6 Freshness classes (closed, server-derived)

```
CURRENT   AGING   STALE   EXPIRED
```

Deterministic from `publishedAt ?? observedAt` against the per-signal-type
threshold table (§8, code-level policy). Recomputed identically at read;
never stored as authority (the stored column is a denormalized projection of
the timestamps + policy version, like R8-A's status).

### 3.7 Corroboration statuses (closed, server-derived)

```
UNCORROBORATED   CORROBORATED   MIXED   CONTRADICTED
```

| Status | Meaning |
|---|---|
| `UNCORROBORATED` | No independent corroborating signal; no contradiction. |
| `CORROBORATED` | ≥1 independent corroborating signal (same `claimKey`, §6); no contradiction. |
| `MIXED` | ≥1 independent corroborating **and** ≥1 contradicting signal — the conflict stays visible. |
| `CONTRADICTED` | ≥1 contradicting signal and no independent corroboration. |

### 3.8 Relevance classes (closed, server-derived)

```
DIRECT   RELATED   WEAK   IRRELEVANT
```

Relevance is whether the signal bears on **this business** (§9). It is
separate from truth: an IRRELEVANT signal can still be verified external
truth; a DIRECT signal can still be unverified rumour.

### 3.9 Confidence classes (closed, server-derived)

```
NONE   LOW   MEDIUM   HIGH
```

Aligned with R7-B/R8-F. Server-derived only by the deterministic mapping in
§10; monotonic downward under re-evaluation; no path promotes confidence.

### 3.10 Signal lifecycle statuses (closed)

```
OBSERVED   CORROBORATED   CONTRADICTED   SUPERSEDED   STALE   INVALIDATED
```

Deterministic state (§11). Status is a denormalized, CAS-guarded projection
of the append-only lifecycle facts; it is never client-writable.

## 4. Source trust derivation (R8-F semantics, C4)

Server-derived only, deterministic precedence (first match wins):

1. **Integrity failure** (record hash drift, or malformed source metadata at
   ingest) → `MALFORMED`. Malformed source metadata is rejected at the
   boundary (§7.2) and never persists.
2. **Active unresolved contradiction** (this signal is contradicted and has
   no independent corroboration) → `CONTRADICTED`.
3. **Source on the server-side registry with class `OFFICIAL` or `VERIFIED`**
   → `VERIFIED_EXTERNAL`.
4. **≥ 2 independent corroborating sources** (distinct
   `sourceIndependenceKey`, §6) for the same `claimKey` →
   `CORROBORATED_EXTERNAL`.
5. **Exactly 1 source** (the signal itself, source not registry-verified) →
   `SINGLE_EXTERNAL_SOURCE`.
6. **No usable provenance** → `UNVERIFIED`.

Rules enforced (mirroring R8-F §5): an unverified external source can never
silently become a strategic fact; single-source claims carry bounded
confidence; contradictions remain visible and cap confidence at `NONE`; stale
evidence cannot justify current strategic evidence (§8); model-generated
content is never source evidence; **a source can never mark itself trusted**.

## 5. Identity and provenance (C2)

### 5.1 Source URI normalization and origin keys

The client supplies `sourceUriRef` (and optionally an `originHint`). The
server **normalizes** deterministically: parse as absolute http(s) URI;
lowercase scheme + host; strip userinfo, query and fragment; strip default
ports; strip trailing slash; strip common tracking path segments is *not*
performed (path is evidence); length-cap each part; the result is the stored
`sourceUriRef`. The **origin key** is `host` (registrable-style, lowercase,
without leading `www.`). Failure to parse, non-http(s) scheme, credentials
present, or non-printable/oversized parts → `MARKET_SIGNAL_SOURCE_MALFORMED`
(rejected, never persisted).

Spoof rejection: an origin that case-insensitively matches an official
allow-list origin or its look-alike (homoglyph-insensitive normalized form:
punycode-decoded, confusable-stripped) **without** being the real registered
origin is rejected (`MARKET_SIGNAL_SOURCE_SPOOFED`). Official matching is
exact-after-normalization only — no fuzzy "near miss" promotion, ever.

### 5.2 Source identity

```
sourceKey = sha256(canonicalJson({ v:1, tenantUserId, originKey }))
sourceId  = "src1:" + sourceKey
```

One origin per tenant ⇒ one durable source row. `sourceType` is the
client-proposed, server-validated classification of the source's *kind*;
`sourceRegistryClass` is derived: `OFFICIAL` iff originKey ∈ code-level
official allow-list (per `sourceType` family — a government source type
claims a government origin; type/origin inconsistency demotes to `UNVERIFIED`
rather than promoting), else `VERIFIED` iff the origin passes deterministic
verification (valid registrable shape, not a look-alike of an official
origin, no credential residue), else `UNVERIFIED`. **No client-controlled
trust**: the client can never supply `sourceRegistryClass`, `sourceTrustClass`,
or any `verified/trusted` field.

### 5.3 Signal identity and claim fingerprints

```
signalKey      = sha256(canonicalJson({ v:1, tenantUserId, businessId, sourceId, eventKey }))
signalId       = "xsig1:" + signalKey
claimFamilyKey = sha256(canonicalJson({ v:1, signalType, subjectType, subjectRef(norm), claimAspect(norm) }))
claimKey       = sha256(canonicalJson({ v:1, claimFamilyKey, claimText(norm) }))
```

- Same business + source + event ⇒ same signal identity. Retries/concurrent
  ingests converge on one durable row (`duplicateClassification:
  "none" | "idempotent_replay"`).
- Re-ingest of the same natural identity `(userId, sourceId, eventKey)` with a
  different `evidenceHash` is conflicting replay and fails closed
  (`MARKET_SIGNAL_REPLAY_CONFLICT`).
- Duplicate ingestion from equivalent source copies is avoided *where identity
  is deterministic*: same origin + same `eventKey` ⇒ same signal row (an
  aggregator copy of the same event under the same origin key converges as a
  replay; a copy under a *different* origin is a different source — it may
  corroborate only if genuinely independent, §6).

### 5.4 Safe normalized source reference

Stored `sourceUriRef` is the normalized URI (§5.1), never the raw input. Raw
URIs with embedded credentials, non-http(s) schemes, or IP-literal hosts in
official type families are rejected. The projection carries the normalized
reference only.

### 5.5 Immutable core

```
evidenceHash = sha256(canonicalJson({ v:1, userId, businessId, signalType,
  subjectType, subjectRef, claimAspect, sourceId, eventKey, sourceUriRef,
  sourceType, claimText, observedAt, publishedAt, freshnessPolicyVersion,
  contradictsSignalIds (verbatim, order-normalized), supersedesSignalId }))
```

`ingestedAt`, `modelAssistance`, derived classes and lineage-derived id lists
are deliberately excluded (derived state may be recomputed; the immutable
core may not drift). Drift between a retained row and a recomputed hash is
tampering and fails closed on every read
(`MARKET_SIGNAL_EVIDENCE_CONFLICT`).

## 6. Corroboration and contradiction (C4/C7)

**Corroboration** is computed server-side over same-tenant + same-business
signals sharing the same `claimKey`:

- Candidate corroborators: same `claimKey`, `signalStatus` not in
  `{INVALIDATED, SUPERSEDED}`, freshness not `EXPIRED`.
- **Independence**: two sources are independent iff their
  `sourceIndependenceKey` differs. The independence key is the server-derived
  publisher/origin key (`originKey` of the source; for `AGGREGATOR` sources it
  remains the aggregator's own origin — an aggregator copy never inherits the
  upstream publisher's independence). Syndicated copies of one source share
  one independence key and **never** count as independent corroboration.
- `corroboratingSignalIds` = candidate corroborators from independent sources
  (≤16, newest first). `corroborationStatus` and the trust class (§4) are
  derived from the independent count.

**Contradiction** is declared by the newer signal (`contradictsSignalIds` at
ingest), server-validated: every referenced signal must exist in the same
tenant + business and share the same `claimFamilyKey` with a **different**
`claimKey` (a materially different claim about the same subject aspect) —
else `MARKET_SIGNAL_LINEAGE_SCOPE_CONFLICT`. Validation binds
`contradictingSignalIds` on the new row and CAS-transitions referenced rows:
status `CONTRADICTED` (when not independently corroborated) or `MIXED`
handling via `corroborationStatus` on both rows; one immutable lifecycle fact
(`xsf1:`) per affected row. Contradicted evidence **remains visible** —
history is never deleted.

## 7. Content isolation and prompt-injection defense (C3)

### 7.1 Inert evidence

External content (`claimText`, `subjectRef`, `limitations`) is untrusted
data. It is stored verbatim-normalized (NFC, control/format characters
stripped, ≤2048 chars), tagged `contentIsolation: "INERT_EVIDENCE"`, and is
never: executed, used as instructions, passed to a model as anything but
delimited untrusted data, or allowed to influence trust, relevance, status,
or confidence beyond the deterministic detectors in this contract.

### 7.2 Malformed content/source rejection

Malformed unicode (lone surrogates), non-printable residue after
normalization, oversized content, and malformed source metadata (§5.1) fail
closed at the boundary: `MARKET_SIGNAL_SOURCE_MALFORMED` /
`MARKET_SIGNAL_INPUT_INVALID` — no row, no audit claim of a signal.

### 7.3 Injection detection (annotation only)

A deterministic detector scans normalized content for injection shapes:
imperatives directed at the system (`ignore (all )?(previous|prior|above)
instructions`, `you are now`, `new persona`, `system:`, `developer:`),
tool/execution requests (`call`, `invoke`, `execute`, `run`, `tool_use`,
function-call JSON), secret requests (`api key`, `password`, `token`, `send
(…)` exfil shapes), SQL/shell markers (`; DROP TABLE`, `rm -rf`, `#!/`,
`SELECT … FROM`), and privilege/policy phrases (`reveal your (system )?
prompt`, `bypass`, `jailbreak`). A hit sets `injectionSuspected: true` and
appends a bounded limitation (`EXTERNAL_CONTENT_INJECTION_SUSPECTED`). The
content remains inert; detection only annotates and (downstream) may raise
governance risk — it never blocks truthful storage of the observed event and
never grants anything authority.

### 7.4 Model assistance (candidate only)

If an extractor/research model assisted normalization, bounded metadata
(`extractorVersion ≤48`, `proposedRelevanceClass`, `summary ≤512`) may be
recorded in `modelAssistance`. Strict schema; unknown fields rejected at the
boundary; **excluded from every identity and hash**; never source authority
(§10); a model can never raise source trust, mint corroboration, or mark
content verified.

## 8. Freshness and temporal lifecycle (C5)

Code-level policy table (hours from `publishedAt ?? observedAt`, deterministic,
no runtime mutation):

| Signal type | CURRENT ≤ | AGING ≤ | STALE ≤ | else |
|---|---|---|---|---|
| PRICING_CHANGE | 72h | 168h | 720h | EXPIRED |
| REPUTATION_SIGNAL | 72h | 336h | 1440h | EXPIRED |
| COMPETITOR_ACTION | 168h | 720h | 2160h | EXPIRED |
| PRODUCT_LAUNCH | 336h | 1440h | 4320h | EXPIRED |
| MARKET_DEMAND | 336h | 1440h | 4320h | EXPIRED |
| CHANNEL_PLATFORM_CHANGE | 336h | 2160h | 8760h | EXPIRED |
| REGULATORY_CHANGE | 720h | 4320h | 17520h | EXPIRED |
| TECHNOLOGY_CHANGE | 720h | 4320h | 17520h | EXPIRED |
| MACRO_ENVIRONMENT | 720h | 4320h | 17520h | EXPIRED |
| ECOSYSTEM_CHANGE | 720h | 4320h | 17520h | EXPIRED |

`freshnessClass` is derived identically at read from timestamps + policy
version; `EXPIRED` signals are excluded from the current projection (§12).
New signals may supersede prior signals (§11) but history is preserved —
staleness is a fact about time, never a rewrite. Stale evidence cannot
silently remain current: the projection recomputes and labels.

## 9. Business relevance classification (C6)

Deterministic, rule-first. Server assembles a bounded business term set from
the verified business row (name tokens, industry, product/service terms,
target audience/market terms) plus — at integration — R8-A memory subjects;
v1 uses the business row only. The signal's `subjectRef`, `claimAspect` and
normalized `claimText` are matched against the term set (exact token +
bounded stem overlap). The deterministic score maps to a ceiling:

| Score | Ceiling |
|---|---|
| ≥ 0.50 | DIRECT |
| ≥ 0.25 | RELATED |
| ≥ 0.10 | WEAK |
| < 0.10 | IRRELEVANT |

A model may *propose* a relevance class in `modelAssistance`; the server
accepts at most `min(proposal, ceiling)` — the model can never raise
relevance above deterministic support, and no external source may declare
itself relevant (all source-declared relevance fields are rejected at the
boundary). `relevanceEvidence` records the exact matched terms verbatim
(`{ matchedTerms: string[] ≤24, businessTermCount, signalTermCount, score }`)
— directly relevant signals retain exact evidence. IRRELEVANT signals are
stored but never appear in the current projection (§12): irrelevant evidence
does not become strategic evidence.

## 10. Confidence derivation (server-derived only)

`derivedConfidence = min(trustCeiling, freshnessCeiling)` where:

| Input | Ceiling |
|---|---|
| `sourceTrustClass = VERIFIED_EXTERNAL` | HIGH |
| `sourceTrustClass = CORROBORATED_EXTERNAL` | MEDIUM |
| `sourceTrustClass = SINGLE_EXTERNAL_SOURCE` | LOW |
| `sourceTrustClass = UNVERIFIED` | LOW |
| `sourceTrustClass = CONTRADICTED` | NONE |
| `sourceTrustClass = MALFORMED` | NONE |
| freshness `CURRENT` / `AGING` | no further cap |
| freshness `STALE` | LOW |
| freshness `EXPIRED` | NONE |

Model output is never an input to confidence; a model-generated summary can
never become a source fact (F §5: `MODEL_GENERATED` → never source truth).

## 11. Lifecycle: contradiction, supersession, invalidation (C7)

Append-only `external_signal_lifecycle_events` (`xsf1:` facts):

| Fact | Effect |
|---|---|
| `CORROBORATION` | Independent corroboration linked (statuses refreshed on both rows). |
| `CONTRADICTION` | Referenced rows CAS-transition `CONTRADICTED` (or `MIXED` when independently corroborated); contradiction stays visible both ways. |
| `SUPERSESSION` | Newer signal binds `supersedesSignalId`; predecessor CAS-transitions `SUPERSEDED`; history preserved. |
| `STALENESS` | Materialized stale transition (computed freshness; projection recomputes regardless). |
| `INVALIDATION` | Evidence integrity/authority failure (hash drift, upstream invalidation); row CAS-transitions `INVALIDATED`. |

Precedence (deterministic, recomputed identically at read): INVALIDATED >
SUPERSEDED > CONTRADICTED > STALE(freshness) > CORROBORATED >
OBSERVED. Current projection (§12) returns only active evidence. Newer
evidence supersedes but never rewrites old evidence.

## 12. Current external-signal projection (downstream, C8)

`marketSignal.r8Projections` exposes the read-only
`external-signal/v1` projection (exact field allowlist in
`docs/contracts/external-signal-to-strategic-reasoning-contract.md`). The
**current projection** contains exactly signals with `signalStatus ∈
{OBSERVED, CORROBORATED}`, freshness ∈ `{CURRENT, AGING}`, and `relevanceClass
≠ IRRELEVANT` — labelled with freshness and corroboration. Non-current,
non-active, superseded, contradicted, stale, expired, invalidated and
irrelevant records remain queryable via `get`/`list`/`listLifecycle` (status
labelled — never silently active) and appear in projections only when
explicitly requested. Downstream (R8-D/E) must revalidate against R8-F before
creating governed recommendations and may never mutate signal authority.

## 13. Client boundary

`z.strictObject` router inputs reject every client-supplied authority field:
`signalId`, `sourceId`, `sourceRegistryClass`, `sourceTrustClass`,
`confidenceClass`, `freshnessClass`, `corroborationStatus`, `corroboratingSignalIds`,
`contradictingSignalIds`, `relevanceClass`, `relevanceEvidence`, `signalStatus`,
`evidenceHash`, `claimKey`, `claimFamilyKey`, `sourceIndependenceKey`,
`contentIsolation`, `injectionSuspected`, `userId`, `id`, `version`, and any
`verified*/trusted*/force*/promote*/override*` field. Clients supply signal
material and reference ids only. Any such field →
`MARKET_SIGNAL_CLIENT_AUTHORITY_FIELD_FORBIDDEN`.

## 14. Security invariants (rogue-agent containment)

- Session `userId` anchors everything; business and every corroboration /
  contradiction / supersession reference is re-verified from durable rows on
  every call. Cross-tenant reads return nothing; cross-business associations
  fail closed (`MARKET_SIGNAL_CROSS_BUSINESS_ASSOCIATION`).
- No external content can alter system/developer instructions, invoke tools,
  execute commands, request secrets, modify policy, mark itself trusted,
  alter business identity, or cause downstream execution — this stream
  exposes no execution surface and no LLM-in-the-authority-path.
- A compromised extraction/research agent cannot: fabricate provenance
  (identity binds normalized coordinates), raise trust (server-derived),
  invent corroboration (independence-key enforced), hide contradiction
  (append-only visible history), mark stale current (deterministic freshness),
  fabricate relevance authority (deterministic ceiling), mutate strategy /
  memory / budget / campaigns / providers (no such code path), access secrets,
  or alter its own permissions.
- Non-execution invariant: no R8-C code path writes campaigns, budgets,
  Business DNA, experiments, approvals, payments, providers, CRM, R5 social
  tables, or R8-A memory tables. There is no execution authority here.

## 15. Audit

Canonical `audit_events` ledger only: one `external_signal_recorded` event
per inserted signal row and one `external_signal_lifecycle` event per
inserted lifecycle fact; convergence/replay paths emit zero. Metadata carries
ids / closed labels / classes / hashes only — never claim text, source
content, or model reasoning.

## 16. Failure modes (fail closed)

`MARKET_SIGNAL_INPUT_INVALID`; `MARKET_SIGNAL_CLIENT_AUTHORITY_FIELD_FORBIDDEN`;
`MARKET_SIGNAL_SOURCE_MALFORMED`; `MARKET_SIGNAL_SOURCE_SPOOFED`;
`MARKET_SIGNAL_OWNERSHIP_MISMATCH` (cross-tenant);
`MARKET_SIGNAL_CROSS_BUSINESS_ASSOCIATION`;
`MARKET_SIGNAL_REPLAY_CONFLICT`; `MARKET_SIGNAL_EVIDENCE_CONFLICT`;
`MARKET_SIGNAL_LINEAGE_SCOPE_CONFLICT`; `MARKET_SIGNAL_PROJECTION_VERSION_UNSUPPORTED`.
Absence of authority never widens autonomy.

## 17. Schema and migration

Tables `external_sources`, `external_signals`,
`external_signal_lifecycle_events` (stream-local provisional migration
`0036_r8_c_market_external_signal_foundation`, artefact only — **NOT
executed**; `docs/recovery/r8-c-unexecuted-migrations.md`; R8-X owns
convergence/collision with R8-A/R8-F provisional `0036`s). R7's `0035`
migration is untouched.
