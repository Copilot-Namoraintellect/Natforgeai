# STRATEGIC REASONING CONTRACT (WBS-R8-D)

> Canonical contract for the R8-D strategic-reasoning capability.
> Branch `feature/r8-d-strategic-reasoning`; base `a2c084a1`; frozen upstream
> authorities consumed by branch ref only: R8-A Strategic Memory (`23d0f22`),
> R8-B Business Change Intelligence (`055eece`), R8-C Market & External Signal
> Intelligence (`b366c5e`), R8-F Strategic Governance (`44118e3`), R7 Business
> Optimisation V1 (`a2c084a`).
> Implementation: `api/lib/strategic-reasoning/`; router `strategicReasoning`
> (`api/strategic-reasoning-router.ts`); schema `strategic_reasoning_bundles`,
> `strategic_reasoning_records`, `strategic_reasoning_lifecycle_events`
> (provisional migration `0036_r8_d_strategic_reasoning_foundation`, NOT
> executed).

## 1. Purpose and authority boundary

R8-D synthesizes governed strategic evidence — R8-A strategic memory, R8-B
business-change evidence, R8-C external/market-signal evidence, R7
optimisation/history context carried through those authorities — into
**bounded, evidence-preserving strategic conclusions**. It answers: what does
the current evidence suggest strategically; which internal changes and which
external signals matter; which patterns reinforce or conflict; what
hypotheses and implications are supported; what confidence is justified; what
remains unknown; which conclusions require human review; what may be passed
downstream to opportunity/risk intelligence.

R8-D owns strategic-reasoning records and strategic conclusions **only**. It
does **not** own: market-signal truth (R8-C), business-change truth (R8-B),
strategic-memory truth (R8-A), governance authority (R8-F), opportunity/risk
ranking (R8-E), strategy mutation, Business DNA mutation, campaign execution,
budget execution, provider/payment/billing execution, or R9 mission planning.

Core principles enforced:

1. Reasoning preserves upstream truth boundaries — projected evidence fields
   are read-only and re-validated at consumption.
2. A strategic conclusion is **not** source truth.
3. External evidence remains **untrusted** even when strategically relevant.
4. Internal change and external signals are different evidence classes and
   are never blended into one trust level.
5. Correlation, association and causation remain distinct; every conclusion
   and projection carries verbatim disclaimers.
6. Contradictions remain visible — never silently resolved.
7. Confidence derives from evidence quality, never from model confidence.
8. Model-generated reasoning is candidate synthesis only until server-side
   validation binds every evidence reference.
9. A conclusion may recommend attention, never execution.
10. No strategic conclusion may directly mutate strategy, budget, Business
    DNA, campaign, provider or mission state — no such code path exists.

## 2. Target flow

```
R8-A memory refs + R8-B change refs + R8-C signal refs   (client supplies ids only)
↓ server-side evidence resolution (tenant/business/version/status revalidation)
↓ deterministic evidence bundle (evb1:) — same evidence set ⇒ same bundle
↓ bounded reasoning graph (SUPPORTS / CONTRADICTS / CONTEXTUALISES / LIMITS)
↓ rule-first strategic synthesis (+ optional model candidates, revalidated)
↓ support / contradiction / missing-evidence accounting
↓ strategic hypothesis + implication (closed vocabularies)
↓ confidence + uncertainty derivation (evidence-quality caps only)
↓ R8-F governance evaluation (registered engine; fail-closed when absent)
↓ governed strategic conclusion (rsn1:, immutable, exact-once)
↓ re-evaluation lifecycle (supersession / contradiction / staleness)
↓ read-only projection to R8-E opportunity/risk intelligence
```

## 3. The reasoning record (D1)

| Field | Type | Notes |
|---|---|---|
| `reasoningId` | `rsn1:<sha256>` | Deterministic; unique convergence anchor `(userId, reasoningId)` |
| `businessId` | number | Owning business, re-verified from the durable `businesses` row every call |
| `evidenceBundleId` | `evb1:<sha256>` | Exact bound evidence set (§4) |
| `memoryRefs[]` | `mem1:…[]` | R8-A identities, verbatim |
| `changeRefs[]` | `chg1:…[]` | R8-B identities, verbatim |
| `externalSignalRefs[]` | `xsig1:…[]` | R8-C identities, verbatim |
| `hypothesisId` | `hyp1:<sha256>` | Deterministic per reasoning material |
| `hypothesisType` | closed enum | §3.1 |
| `implicationType` | closed enum | §3.2 — recommendation candidates only |
| `supportingEvidence[]` | evidence ref + class + role | Exact refs with INTERNAL_MEMORY / INTERNAL_CHANGE / EXTERNAL_SIGNAL class |
| `contradictingEvidence[]` | evidence ref + class | Contradictions preserved verbatim |
| `missingEvidence[]` | closed enum | §3.3 — explicit unknowns |
| `confidenceClass` | closed enum | `INSUFFICIENT \| LOW \| MODERATE \| HIGH` — evidence-derived (§6) |
| `uncertaintyClass[]` | closed enum | §3.4 |
| `strategicRiskClass` | closed enum | `LOW \| MEDIUM \| HIGH \| CRITICAL` — carried from the bound R8-F decision (never client-supplied) |
| `status` | closed enum | `CANDIDATE \| SUPPORTED \| REVIEW_REQUIRED \| APPROVED_RECOMMENDATION \| BLOCKED \| SUPERSEDED \| CONTRADICTED \| STALE \| INVALIDATED` (§7) |
| `governanceDecisionId` | `sgd1:… \| null` | Bound R8-F decision (null only pre-governance CANDIDATE / NO_ACTION) |
| `limitations` | `string[]` (≤8) | Bounded, preserved verbatim |
| `createdAt` / `evaluatedAt` | ISO 8601 | Persistence/evaluation timestamps (verbatim text) |
| `validUntil` | ISO 8601 \| null | Conclusion validity window |
| `supersedesReasoningId` | `rsn1:… \| null` | Exact predecessor (history preserved) |
| `policyVersion` | string | Frozen R8-F policy artefact that governed this conclusion |

Plus `contractVersion` (`strategic-reasoning/v1`), `engineVersion`
(`strategic-reasoning-engine/v1`), `userId`, `evidenceFingerprint`,
`reasoningFingerprint`, and a bounded `evidenceBundle` snapshot. Rows are
**insert-only and immutable**; corrections are new reasoning records that
supersede. Exactly one `strategic_reasoning_recorded` audit event per
inserted record; replays/convergence emit zero.

### 3.1 Hypothesis types (closed)

```
MARKET_SHIFT
DEMAND_CHANGE
COMPETITIVE_PRESSURE
BUSINESS_CAPABILITY_GAP
STRATEGIC_ALIGNMENT
RESOURCE_MISMATCH
GROWTH_SIGNAL
DECLINE_SIGNAL
POSITIONING_SIGNAL
REGULATORY_IMPLICATION
TECHNOLOGY_IMPLICATION
NO_ACTIONABLE_CONCLUSION
```

### 3.2 Implication types (closed — attention verbs only)

```
MONITOR
INVESTIGATE
VALIDATE_ASSUMPTION
REVIEW_POSITIONING
REVIEW_RESOURCE_PRIORITY
REVIEW_CHANNEL_STRATEGY
REVIEW_PRODUCT_MARKETING
REVIEW_MARKET_RESPONSE
NO_ACTION
```

There are deliberately **no execution semantics**: no `EXECUTE`, `LAUNCH`,
`SPEND`, `CHANGE_STRATEGY`, `UPDATE_DNA`. Reasoning outputs recommendation
candidates only.

### 3.3 Missing-evidence classes (closed)

```
INTERNAL_PERFORMANCE_STATE   — no current internal anchor for the hypothesis
ATTRIBUTION_QUALITY          — attribution too weak to support a performance claim
CORROBORATION                — external claim lacks independent corroboration
CONFLICT_RESOLUTION          — active contradiction unresolved
FRESH_INTERNAL_STATE         — internal evidence stale/absent at evaluation time
```

### 3.4 Uncertainty classes (closed)

```
WEAK_EVIDENCE
STALE_EVIDENCE
CONFLICTING_EVIDENCE
SINGLE_EXTERNAL_SOURCE
ASSUMPTION_HEAVY
MISSING_INTERNAL_STATE
```

## 4. Evidence bundle & reasoning graph (D2)

`evidenceBundleId = "evb1:" + sha256({v:1, businessId, memoryRefs(sorted),
changeRefs(sorted), externalSignalRefs(sorted), and per-ref server-resolved
{contractVersion, sourceVersion, status/factStatus, observedAt/recordedAt}})`.
Same authoritative evidence set (ids + versions + timestamps + scope) ⇒ same
bundle. No fuzzy stitching; no client-created references — clients supply ids
only and the server resolves every row.

Rejection (fail closed): cross-business evidence; cross-tenant evidence;
stale/unsupported upstream contract versions; malformed evidence rows;
unknown references; tampered fingerprints (`EVIDENCE_FINGERPRINT_MISMATCH`).

The **reasoning graph** links evidence → hypothesis → conclusion with typed
edges `SUPPORTS | CONTRADICTS | CONTEXTUALISES | LIMITS`, derived
deterministically by the rule engine and upstream contradiction metadata.
Edges only ever point from evidence to conclusions (a DAG by construction);
between evidence items, CONTRADICTS edges mirror upstream contradiction
lineage (R8-A `contradictedByMemoryIds`, R8-B contradiction lineage, R8-C
`contradictingSignalIds`/`contradictedBySignalIds`). Bounds: ≤64 evidence
items per bundle, ≤256 edges, depth ≤3 — cycles cannot form and traversal is
finite.

## 5. Rule-first synthesis (D3)

Deterministic rule-first synthesis over normalized evidence descriptors.
Illustrative rules (the shipped rule table is code-level and versioned):

| Pattern | Hypothesis | Bound |
|---|---|---|
| Internal demand/performance decline + external category decline | `DECLINE_SIGNAL` (market-decline) | confidence capped by external trust |
| Internal decline + external category growth | `BUSINESS_CAPABILITY_GAP` (internal-gap) | positioning alternative via `POSITIONING_SIGNAL` |
| Competitor launch + stable internal performance | `COMPETITIVE_PRESSURE` | external-only ⇒ ≤ LOW, implication `MONITOR` |
| Budget underperformance + weak attribution | `NO_ACTIONABLE_CONCLUSION` | `INSUFFICIENT` + `missing: ATTRIBUTION_QUALITY` |
| Regulatory external signal (any) | `REGULATORY_IMPLICATION` | external trust caps |
| Technology external signal (any) | `TECHNOLOGY_IMPLICATION` | external trust caps |
| Objective/strategy/constraint change (internal) | `STRATEGIC_ALIGNMENT` | significance-capped |
| Budget envelope / provider capability change (internal) | `RESOURCE_MISMATCH` | significance-capped |

Arbitrary business advice is never encoded as truth: unmatched evidence ⇒
`NO_ACTIONABLE_CONCLUSION`.

**Model assistance (optional):** a registered model adapter operates over the
bounded structured evidence bundle only — no DB/tool access, strict output
schema, every referenced evidence ID revalidated against the resolved bundle
(unknown/forged refs dropped), no new source facts, no new confidence, no
hidden chain-of-thought persisted (narrative text is discarded unless it
passes validation; it is never authority). Model output can propose
hypothesis/implication candidates within the closed vocabularies; the
rule-first engine remains the authority and validates every candidate. No
model registered ⇒ rule-first path only (fully valid).

## 6. Confidence & uncertainty (D4)

Deterministic, evidence-quality-derived; model opinion can never raise it.

Ceilings (strongest applicable wins):

- No usable internal anchor and external uncorroborated ⇒ `INSUFFICIENT`.
- External-only evidence ⇒ `LOW` max (external alone never becomes business
  fact).
- Single-source / unverified external involved ⇒ `LOW` max
  (`SINGLE_EXTERNAL_SOURCE`).
- Stale/expired evidence used as context only; stale evidence cannot support
  (cases: stale memory/change/signal lower or block reasoning).
- Assumption-heavy memory (ASSUMPTION-dominant anchors) ⇒ `MODERATE` max.
- Unresolved active contradiction on the hypothesis ⇒ `MODERATE` max and
  `CONFLICTING_EVIDENCE` recorded (contradiction stays visible).
- Corroborated external (≥2 independent sources) + current internal anchor ⇒
  `HIGH` eligible.
- `HIGH` requires: current internal anchor ≥ VERIFIED-class, no unresolved
  contradiction, and external evidence (if any) ≥ CORROBORATED.

`strategicRiskClass` is never derived or lowered by R8-D: it is carried from
the bound R8-F decision verbatim.

## 7. Governance binding (D6)

R8-F is **mandatory** for governed strategic conclusions. When
`implicationType ≠ NO_ACTION` and `confidenceClass ≠ INSUFFICIENT`, the
service submits proposal material to the registered R8-F engine:

- `proposalId` (deterministic from `reasoningId`), `businessId`,
  `recommendationType` (closed F2 taxonomy, mapped deterministically from the
  implication type), bounded `summary` (template render — content, never
  authority), exact `evidenceRefs`, `claimedConfidence` (R8-D derived),
  `declaredImpact` (external reliance / high uncertainty descriptors only).

The returned decision is persisted verbatim: `governanceDecisionId`, decision,
`policyVersion`, `evidenceFingerprint`, `proposalFingerprint`. R8-F may
return `ALLOW_RECOMMENDATION | REVIEW_REQUIRED | BLOCK`:

- `ALLOW_RECOMMENDATION` ⇒ status `SUPPORTED` (voiceable recommendation).
- `REVIEW_REQUIRED` ⇒ status `REVIEW_REQUIRED`; a human approval on the
  governed ledger (`approvalType = "strategic_recommendation"`, OTP-bound per
  R8-F) bound to the exact decision/policy/proposal/evidence fingerprints
  derives `APPROVED_RECOMMENDATION` at read. **R8-D can never self-approve**;
  forged/stale/cross-proposal approvals are rejected by binding-hash
  validation.
- `BLOCK` ⇒ status `BLOCKED`; no downstream governed recommendation; the
  identity is never revoiced.

Absence of the R8-F authority fails closed (`STRATEGIC_GOVERNANCE_AUTHORITY
_UNAVAILABLE`) — no second governance engine is built. Governance may
authorize or prohibit; it never decides *which* conclusion is optimal.

## 8. Lifecycle & re-evaluation (D7)

```
CANDIDATE → SUPPORTED | REVIEW_REQUIRED | BLOCKED
any → SUPERSEDED (new reasoning record binds supersedesReasoningId)
any → CONTRADICTED (upstream contradiction now touches bound evidence)
any → STALE (validUntil passed / evidence freshness window exceeded)
any → INVALIDATED (bound evidence invalidated; governance policy change
      re-evaluation BLOCKs)
REVIEW_REQUIRED → APPROVED_RECOMMENDATION (derived: valid bound human approval
      exists on the ledger)
```

Re-evaluation triggers: strategic memory superseded/staled; business change
corrected/reverted; external signal contradicted/superseded; source trust
change; evidence staleness; governance policy version change. `reevaluate`
re-runs the pipeline from the bound evidence refs: material change ⇒ new
record superseding the old (immutable history); no change ⇒ idempotent
convergence. Lifecycle facts are append-only (`srl1:` identities, one audit
event per durable effect).

## 9. Client boundary

`z.strictObject` router inputs reject every client-supplied authority field:
`decision`, `reasonCodes`, `confidenceClass`, `uncertaintyClass`,
`strategicRiskClass`, `sourceTrustClass`, `status`, `approvalStatus`,
`approved`, `executable`, `governanceDecisionId`, `evidenceFingerprint`,
`reasoningFingerprint`, `policyVersion`, `evidenceBundle`, graph edges,
`forceAllow`, `forceApprove`, `raiseConfidence`, `lowerRisk`, `promoteTrust`,
`setTrusted`, `suppressContradiction`, … ⇒
`REASONING_CLIENT_AUTHORITY_FIELD_FORBIDDEN`. Clients supply business id,
evidence reference ids, optional scope/context flags and (for the model seam)
untrusted candidate material only.

## 10. Downstream projection (D8)

Read-only `strategic-reasoning-to-opportunity-risk/v1` projection for R8-E
(see `docs/contracts/strategic-reasoning-to-opportunity-risk-contract.md`):
reasoning id, business, hypothesis, implication, support/contradiction refs,
confidence, uncertainty, strategic risk, governance decision + approval
status, freshness, limitations, source versions — plus verbatim causation /
attribution / execution disclaimers. R8-E may rank and classify opportunities
and risks; it must never mutate R8-D authority.

## 11. Security invariants (rogue-agent containment)

A compromised strategic-reasoning agent must not be able to: fabricate
evidence (server resolves every ref; unknown ⇒ rejected); raise trust or
confidence (server-derived caps); hide contradiction (contradiction lineage
is re-read from upstream rows every evaluation); invent business facts (no
write path to any upstream table); convert association into causation
(disclaimers verbatim, `causationClaimed` always false); lower strategic risk
(risk comes only from the bound R8-F decision); self-approve (approval
derivation is read-only through binding-hash validation); alter governance
policy (policy is R8-F code-level, never mutated here); mutate strategy/DNA/
budget/campaigns (no code path); launch tools/actions or execute shell/SQL
(no tool surface; the model seam has no DB/tool access); access secrets (no
secret reads); expand permissions (no privilege paths). External source text
stays inert: it never reaches prompts except as delimited untrusted data and
never invokes tools.

## 12. Failure modes (fail closed)

Missing/stale/unknown upstream contract version; unknown/foreign/cross-
tenant/cross-business evidence reference; malformed or tampered evidence;
absent evidence authority; zero usable evidence on a voiced claim; governance
authority unavailable; expired/invalid governance decision; approval binding
mismatch; replay conflict (`REASONING_REPLAY_CONFLICT`); protected-trait
material in candidate content. Authority absence never widens autonomy.

## 13. Schema

`strategic_reasoning_bundles`, `strategic_reasoning_records`,
`strategic_reasoning_lifecycle_events`. Provisional, stream-local migration
`0036_r8_d_strategic_reasoning_foundation` — artefact only, **NOT executed**;
R7's `0035` is never modified; the R8 0036 collision is documented in
`docs/recovery/r8-d-unexecuted-migrations.md`; R8-X owns convergence.

## 14. Versioning

Reasoning contract `strategic-reasoning/v1`; engine
`strategic-reasoning-engine/v1`; downstream projection
`strategic-reasoning-to-opportunity-risk/v1`. Consumers bind these versions;
bumps invalidate prior derived identities deliberately. Upstream bound
versions: `strategic-memory-to-reasoning/v1`, `business-change-to-reasoning/v1`,
`external-signal/v1`, `strategic-governance/v1`.
