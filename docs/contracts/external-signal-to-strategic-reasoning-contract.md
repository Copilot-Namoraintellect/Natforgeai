# EXTERNAL SIGNAL → STRATEGIC REASONING / OPPORTUNITY-RISK CONTRACT (R8-C → R8-D/E)

> **Producer:** R8-C Market & External Signal Intelligence
> (`feature/r8-c-market-external-signals`)
> **Consumers:** R8-D strategic reasoning, R8-E opportunity/risk intelligence
> (and any later strategic consumer)
> **Status:** canonical downstream contract — consumers read, never redefine
> or mutate
> **Projection version:** `external-signal/v1`
> **Source of truth:** `docs/contracts/market-external-signal-contract.md`
> (R8-C canonical) + `api/lib/market-signals/market-signal-projection.ts`
> (`EXTERNAL_SIGNAL_PROJECTION_FIELD_KEYS` — asserted exact in acceptance)
> **Upstream (frozen, consumed not merged):** R8-A Strategic Memory
> (`23d0f22…`, business-context inputs at integration); R8-F Strategic
> Governance (`44118e3…` — consumers must revalidate against R8-F before
> creating governed recommendations).

---

## 1. Purpose and boundaries

R8-C owns external-signal evidence and source/provenance normalization. This
contract is the **only** surface through which downstream R8 streams consume
external signals. Downstream may read and must never mutate: no R8-D/E call
may write `external_sources`, `external_signals`,
`external_signal_lifecycle_events`, or any upstream authority table, and no
consumer may mint signal identities, source trust classes, confidence
classes, freshness classes, corroboration statuses, relevance classes or
lifecycle resolutions.

**An external signal is observed evidence, never authority.** No projected
field authorizes spend, campaigns, strategy changes, Business DNA changes, or
any execution, and no projected field is causal or attribution proof.

## 2. Consuming surface

Consumers read **only** through the tenant-scoped tRPC procedures on the
`marketSignal` router:

| Procedure | Read model |
|---|---|
| `marketSignal.r8Projections` | Current-state projection list (exactly the active strategic evidence; `includeNonActive: true` exposes labelled non-active history) |
| `marketSignal.get` | One signal + lifecycle + projection (contradiction visibility both ways) |
| `marketSignal.list` | Filtered rows + projections (status labelled) |
| `marketSignal.listLifecycle` | Immutable `xsf1:` history of one signal |
| `marketSignal.listSources` | Server-side source registry view (trust standing is derived) |

The pure projection builder `buildExternalSignalProjection`
(`api/lib/market-signals/market-signal-projection.ts`) is the frozen builder;
consumers at integration time may rebuild projections from durable rows but
must never extend the key allowlist. `validateExternalSignalProjection` is
the seam validator: exact key allowlist + frozen version + verbatim
disclaimers + `causationClaimed === false && attributionClaimed === false`.

## 3. Projection field allowlist (exact, 34 keys)

| Key | Type | Semantics |
|---|---|---|
| `contractVersion` | `"external-signal/v1"` | Frozen projection version |
| `signalId` | `xsig1:…` | Opaque canonical identity — reference verbatim, never parse or reconstruct |
| `businessId` | `number` | Owning business (server-verified) |
| `signalType` | closed enum | `COMPETITOR_ACTION \| MARKET_DEMAND \| PRICING_CHANGE \| PRODUCT_LAUNCH \| REGULATORY_CHANGE \| TECHNOLOGY_CHANGE \| CHANNEL_PLATFORM_CHANGE \| MACRO_ENVIRONMENT \| REPUTATION_SIGNAL \| ECOSYSTEM_CHANGE` |
| `subjectType` | closed enum | `COMPETITOR \| MARKET_CATEGORY \| PRODUCT \| SERVICE \| REGULATION \| TECHNOLOGY \| CHANNEL \| PLATFORM \| BRAND \| CONSUMER_SEGMENT \| SUPPLIER \| PARTNER \| MACRO_INDICATOR \| BUSINESS_SELF \| UNKNOWN` |
| `subjectRef` | `string` | Opaque external subject reference, verbatim |
| `claimAspect` | `string` | The subject aspect the claim addresses |
| `sourceId` | `src1:…` | Server-minted source identity |
| `sourceType` | closed enum | `OFFICIAL_GOVERNMENT \| OFFICIAL_REGULATOR \| OFFICIAL_COMPANY \| NEWS_WIRE \| NEWS_MEDIA \| INDUSTRY_ANALYST \| SOCIAL_PLATFORM \| AGGREGATOR \| UNKNOWN_SOURCE` |
| `sourceUriRef` | `string` | Safe normalized source reference (scheme+host+path; no credentials/query/fragment) |
| `sourceRegistryClass` | closed enum | `OFFICIAL \| VERIFIED \| UNVERIFIED` (server-derived) |
| `sourceTrustClass` | closed enum | `VERIFIED_EXTERNAL \| CORROBORATED_EXTERNAL \| SINGLE_EXTERNAL_SOURCE \| UNVERIFIED \| CONTRADICTED \| MALFORMED` (server-derived, exact R8-F vocabulary) |
| `confidenceClass` | closed enum | `NONE \| LOW \| MEDIUM \| HIGH` (server-derived; never promotable downstream) |
| `freshnessClass` | closed enum | `CURRENT \| AGING \| STALE \| EXPIRED` (recomputed identically at read) |
| `freshnessPolicyVersion` | `string` | Frozen freshness policy artefact |
| `corroborationStatus` | closed enum | `UNCORROBORATED \| CORROBORATED \| MIXED \| CONTRADICTED` |
| `corroboratingSignalIds` | `xsig1:…[]` | Independent corroborating signals (≤16) |
| `contradictingSignalIds` | `xsig1:…[]` | Signals this record contradicts |
| `contradictedBySignalIds` | `xsig1:…[]` | Successors that contradict this record — contradiction stays visible |
| `relevanceClass` | closed enum | `DIRECT \| RELATED \| WEAK \| IRRELEVANT` (server-derived; relevance ≠ truth) |
| `relevanceEvidence` | closed shape | `{ matchedTerms[], businessTermCount, signalTermCount, score }` — exact matched-term evidence |
| `signalStatus` | closed enum | `OBSERVED \| CORROBORATED \| CONTRADICTED \| SUPERSEDED \| STALE \| INVALIDATED` |
| `observedAt` | ISO 8601 | When the event was observed |
| `publishedAt` | ISO 8601 \| null | When the source published it, where known |
| `ingestedAt` | ISO 8601 | Server acceptance time |
| `supersedesSignalId` | `xsig1:… \| null` | Exact predecessor (history preserved) |
| `supersededBySignalId` | `xsig1:… \| null` | Successor (null when current) |
| `contentIsolation` | `"INERT_EVIDENCE"` | External content is inert evidence — constant |
| `injectionSuspected` | `boolean` | Deterministic injection-pattern annotation (never authority) |
| `limitations` | `string[]` (≤8) | Preserved verbatim — including the injection-suspension annotation |
| `modelAssistance` | object \| null | Bounded candidate-extraction metadata; never authority |
| `causationClaimed` | `false` | Always false |
| `causationDisclaimer` | `string` | Verbatim disclaimer (§4) |
| `attributionClaimed` | `false` | Always false |
| `attributionDisclaimer` | `string` | Verbatim disclaimer (§4) |

Deliberately absent (downstream must derive or own): strategic
recommendations, opportunity/risk conclusions, causal lift, ROI forecasts,
strategy mutation authority, budget authority, execution flags, model
reasoning, raw source content (`claimText` is never projected — evidence
stays in the authority row; consumers receive provenance, not content).

## 4. Causation and attribution disclaimers (verbatim on every projection)

```
causationClaimed: false
causationDisclaimer: "An external signal is observed evidence, not causal
  proof. This projection does not assert that any market event, source claim
  or marketing activity caused any business outcome."
attributionClaimed: false
attributionDisclaimer: "External-signal association is not attribution.
  Credit allocation and channel weights remain R7-B derivations on their own
  authority."
```

**Association ≠ corroboration ≠ truth ≠ causal evidence.** A CORROBORATED
signal has independent sources agreeing on a claim — that is still not causal
proof. A DIRECT relevance signal bears on the business — that says nothing
about whether the claim is true.

## 5. Current-state semantics downstream must honour

- `r8Projections` returns **exactly the active strategic evidence**:
  `signalStatus ∈ {OBSERVED, CORROBORATED}`, `freshnessClass ∈ {CURRENT,
  AGING}`, `relevanceClass ≠ IRRELEVANT`. Non-active records (SUPERSEDED,
  CONTRADICTED, STALE, INVALIDATED, EXPIRED, IRRELEVANT) appear only with
  `includeNonActive: true`, always status-labelled — never silently active.
- A SUPERSEDED record's successor is bound by `supersededBySignalId`; both
  remain queryable forever.
- A CONTRADICTED record and its contradicting successor remain visible via
  `contradictingSignalIds` / `contradictedBySignalIds`; downstream must
  surface the conflict, never pick a winner silently.
- Trust ceilings are binding downstream: SINGLE_EXTERNAL_SOURCE and UNVERIFIED
  cap at LOW confidence; CONTRADICTED/MALFORMED cap at NONE; STALE caps at
  LOW; EXPIRED caps at NONE. Consumers must not re-derive stronger trust.
- `injectionSuspected: true` annotations must be passed to R8-F as risk
  material (they raise strategic risk; they never suppress the evidence).

## 6. Tenant, scope and freshness discipline

- Every read is tenant-scoped (`userId`-predicated) and business-scoped; the
  session anchors all reads. Cross-tenant/cross-business evidence never
  resolves.
- Re-validate at consumption time: `contractVersion`, `signalId` pattern
  (`xsig1:` + 64 hex), `sourceTrustClass` against the R8-F closed vocabulary,
  `signalStatus`, `freshnessClass` windows, and `freshnessPolicyVersion`.
- Relevance bounds generalisation: a WEAK/RELATED signal scoped to one
  subject must not be generalised to the whole business without new evidence.

## 7. Mandatory R8-F revalidation (governance gate)

Before any governed recommendation or opportunity/risk response is created
from external-signal evidence, consumers **must** route the proposal through
`strategicGovernance.evaluate` (R8-F) and revalidate immediately before any
material effect (`strategicGovernance.revalidate`). R8-C evidence classes are
inputs to that evaluation — never a substitute for it. Absence of the R8-F
authority fails closed (no strategic claim is voiced on guessed evidence).

## 8. Mutability and audit

- All projected fields are read-only. Corrections or derived state live in
  consumer-owned tables keyed by `signalId` references (no FKs, house
  convention).
- The canonical `audit_events` ledger records every durable R8-C effect
  (`external_signal_recorded`, `external_signal_lifecycle`); consumers must
  not duplicate or shadow that authority.

## 9. Security invariants

1. Consumers must consume only through the tenant-scoped procedures and
   revalidate tenant scope on every query.
2. Consumers must not present a signal as verified fact beyond its
   `sourceTrustClass`/`confidenceClass` (e.g. a single-source claim is never
   "verified market truth").
3. Consumers must not promote confidence, resolve contradictions, or mark
   signals current — no such path exists and none may be built.
4. Consumers must not mutate projected fields or durable rows (§8).
5. A model-generated summary is never source authority; consumers may
   summarize signals but the records themselves never change.
6. External content (never projected) stays inert downstream: it must not
   become instructions, invoke tools, or reach prompts except as delimited
   untrusted data under an explicit system contract.

---

**R8-D/E: consume external signals through this contract. Signals inform;
they never decide.**
