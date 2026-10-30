# R8-E Strategic Opportunity & Risk Intelligence — E0 Inventory

> **Stream:** `feature/r8-e-strategic-opportunity-risk` (base `a2c084a`)
> **Date:** 2026-11-10
> **Purpose:** inventory of every upstream authority and adjacent concept R8-E
> must consume or distinguish before editing. Consumption is by frozen branch
> ref only — nothing from sibling branches is merged.

---

## 1. R8-D Strategic Reasoning (frozen `00f9adf`) — primary upstream

R8-E consumes **only** the downstream projection defined by
`docs/contracts/strategic-reasoning-to-opportunity-risk-contract.md`
(`strategic-reasoning-to-opportunity-risk/v1`, 34-key exact allowlist).

Key facts (verified at `00f9adf`):

- **Conclusion statuses (closed):** `CANDIDATE`, `SUPPORTED`,
  `REVIEW_REQUIRED`, `APPROVED_RECOMMENDATION`, `BLOCKED`, `SUPERSEDED`,
  `CONTRADICTED`, `STALE`, `INVALIDATED`. Active/voiceable =
  `SUPPORTED | APPROVED_RECOMMENDATION | REVIEW_REQUIRED` (others appear only
  status-labelled with `includeNonActive`).
- **Hypothesis types (closed, 12):** `MARKET_SHIFT`, `DEMAND_CHANGE`,
  `COMPETITIVE_PRESSURE`, `BUSINESS_CAPABILITY_GAP`, `STRATEGIC_ALIGNMENT`,
  `RESOURCE_MISMATCH`, `GROWTH_SIGNAL`, `DECLINE_SIGNAL`, `POSITIONING_SIGNAL`,
  `REGULATORY_IMPLICATION`, `TECHNOLOGY_IMPLICATION`,
  `NO_ACTIONABLE_CONCLUSION`.
- **Implication types (closed, 9 — attention verbs only):** `MONITOR`,
  `INVESTIGATE`, `VALIDATE_ASSUMPTION`, `REVIEW_POSITIONING`,
  `REVIEW_RESOURCE_PRIORITY`, `REVIEW_CHANNEL_STRATEGY`,
  `REVIEW_PRODUCT_MARKETING`, `REVIEW_MARKET_RESPONSE`, `NO_ACTION`.
- **Confidence classes (closed):** `INSUFFICIENT | LOW | MODERATE | HIGH` —
  evidence-derived, never promotable downstream (binding ceiling).
- **Strategic risk classes (closed, carried verbatim from R8-F):**
  `LOW | MEDIUM | HIGH | CRITICAL`.
- **Identities:** `rsn1:` + 64-hex (reasoning), `evb1:` bundle, `hyp1:`
  hypothesis, `srl1:` lifecycle facts. Ref patterns `mem1:` / `chg1:` /
  `xsig1:`; governance decisions `sgd1:` + 64-hex.
- **Projection disclaimers:** `causationClaimed/attributionClaimed/
  executionClaimed` always `false` with verbatim disclaimer strings — R8-E
  must carry equivalent non-execution semantics onward to R9.
- **Durable tables (provisional 0036, NOT executed):**
  `strategic_reasoning_bundles`, `strategic_reasoning_records`,
  `strategic_reasoning_lifecycle_events`. Record row carries
  `supportingEvidence`/`contradictingEvidence` as `[{ref, evidenceClass,
  role}]`, `missingEvidence` closed enum[], `validUntil`,
  `supersedesReasoningId`, `governanceDecisionId/governanceDecision/
  governanceDecisionRecord`, `policyVersion`, both fingerprints,
  `sourceVersions`, `limitations`.
- **Consumption surfaces (R8-D router):** `getHandoffProjections`
  (`{businessId, includeNonActive}`), `get`, `list`, `listLifecycle`,
  `evaluate`, `reevaluate`. The pure builder
  `buildStrategicReasoningProjection` is frozen; consumers may rebuild
  projections from durable rows but must never extend the key allowlist.
- **Binding for R8-E:** D binds R8-F through a *registration port*
  (`registerStrategicGovernanceEnginePort`, fail-closed when absent) and an
  approval read-port over `approval_requests` (approvalType
  `strategic_recommendation`) with the deterministic F5 binding-hash formula.
  R8-E mirrors both patterns (its own registries; no cross-branch imports).

## 2. R8-A Strategic Memory (`23d0f22`) — evidence lineage only

R8-A owns durable strategic memory (`mem1:` identities; fact/assumption
statements with confidence + sourceAuthority). R8-E never reads R8-A tables
directly: memory references arrive **through R8-D projections**
(`supportingEvidence[].ref`, `evidenceClass: INTERNAL_MEMORY`). R8-E preserves
them verbatim as `memoryRefs` lineage. Frozen version
`strategic-memory-to-reasoning/v1` (per-sourceAuthority map bound by D).

## 3. R8-B Business Change Intelligence (`055eece`) — evidence lineage only

`chg1:` change records (closed change types, significance, confidence,
status) arrive through R8-D projections as `INTERNAL_CHANGE`. R8-E never
resolves change rows itself; `changeRefs` are preserved lineage. Frozen
version `business-change-to-reasoning/v1`.

## 4. R8-C Market & External Signals (`b366c5e`) — evidence lineage only

`xsig1:` signals (closed signal types, trust classes, freshness, corroboration)
arrive through R8-D projections as `EXTERNAL_SIGNAL`. **External signals do
not become business facts merely because they support a candidate** (charter
principle 7): they remain `signalRefs` lineage with D-derived confidence
ceilings. Frozen version `external-signal/v1`.

## 5. R8-F Strategic Governance (`44118e3`) — mandatory governance authority

- **Decisions (closed):** `ALLOW_RECOMMENDATION | REVIEW_REQUIRED | BLOCK`.
  There is **no EXECUTE** anywhere.
- **Risk dispositions (default policy `strategic-governance-policy/v1`):**
  LOW → `ALLOW_RECOMMENDATION`, MEDIUM/HIGH → `REVIEW_REQUIRED`, CRITICAL →
  `BLOCK`. Autonomy only narrows.
- **Decision validity:** 24 h window; approval binding expires with it.
- **Approval ledger:** `approval_requests`, approvalType
  `strategic_recommendation`; context carries `strategicGovernanceBinding`
  `{governanceDecisionId, policyVersion, proposalFingerprint,
  evidenceFingerprint, approvalBindingHash, expiresAt}`. F5 binding hash =
  sha256 over `{v:1, governanceDecisionId, policyVersion, proposalFingerprint,
  evidenceFingerprint}` (canonical JSON).
- **Consumption gate:** `assertStrategicRecommendationConsumable` →
  `authorityScope: "RECOMMENDATION_ONLY"`. BLOCK is terminal; forged/expired/
  edited approvals fail closed.
- **Consumer rule:** propose material only — decision/risk/confidence/trust/
  approval fields supplied by a consumer are rejected
  (`CLIENT_AUTHORITY_FIELD_REJECTED`). R8-E obeys: it submits bounded
  proposal material (candidate identity, kind/type refs, evidence refs,
  derived integer scores) and binds the returned decision verbatim.

## 6. R5 opportunity detection — terminology boundary (must not conflate)

R5-D opportunities are **operational marketing/customer opportunities**:
pre-lead candidates from R5-B interpretations (`api/lib/opportunity/detector`),
with lifecycle NEW/…/handoff to R6, exactly-once R6 handoff envelopes. They
are tenant-scoped marketing signals, never strategic. **R8-E strategic
opportunity/risk = business-level candidates derived from governed R8-D
reasoning.** Distinct identity families (`opp…`/R5 handoff ids vs `sor1:`),
distinct tables, no shared authority. R8-E never writes R5 tables and never
reuses R5 candidate identities.

## 7. R6 lead autonomy — terminology boundary

R6 owns `lid1:` lead identities, scores, qualification, nurture/sales handoff,
conversions (`cv1:`-family). Leads are individual prospects; R8-E candidates
are business-level strategic constructs. No numeric `leads.id` or R6 identity
appears in R8-E authority; R6 rows are never read or written here.

## 8. R7 optimisation concepts — terminology boundary

R7-E emits **optimisation proposals** (`psn1:`/`ins1:` families) over campaign
portfolios with bounded reallocations governed by R7-F (`ogd1:` decisions).
R7 "opportunity" concepts are portfolio/evidence weights, not strategic
opportunities. R7-E's `getStrategyHandoff` is the R7→R8 read-only handoff
R8-D consumed; R8-E does not re-read R7 authority — R7 enters only as memory
lineage through R8-D. R8-E must not regress the R7-E handoff (regression
suite runs the R7 tests unchanged).

## 9. Strategy recommendation concepts

`strategySnapshots` / `businessDnaSnapshots` tables exist at base. R8-E is
explicitly forbidden from mutating strategy or Business DNA; candidates are
evidence, not strategy inputs. No write path to those tables exists in this
stream, and none may be built.

## 10. Scoring / prioritisation frameworks in-repo (conventions to match)

- R6-B: deterministic evidence-bound integer scores, immutable versioned
  records, honest confidence, bounded reason codes.
- R7-B: closed model set, integer basis points (100 000 total, largest
  remainder), deterministic tie-breaks.
- R7-E: integer minor units / BigInt solver, deterministic weights,
  largest-remainder rounding, stability caps — **overlap must not inflate
  importance** (same discipline for E6: relations are lineage, never score
  multipliers).
- R8-E follows: exact integer arithmetic, documented weights, deterministic
  tie-breaks, confidence caps, contradiction penalties.

## 11. Audit

Canonical `audit_events` ledger (`api/lib/audit`). Each stream adds its own
material types to `AUDIT_EVENT_TYPES` and emits exactly one event per durable
effect; convergence paths emit zero. R8-E adds `strategic_candidate_derived`
and `strategic_candidate_lifecycle`. Metadata carries opaque ids/hashes/
closed labels only — never raw evidence text or PII.

## 12. Approval

Shared `approval_requests` ledger. R8-E reads the `strategic_recommendation`
approvalType view through its governance seam (same F5 formula, same
forged/expired/cross-decision failure semantics as R8-D). R8-E never writes
approvals and can never self-approve (no resolve/approve endpoint; client
`approved`/`decision`/`riskClass`/… fields rejected at the boundary).

## 13. Schema / migration state

- Base `a2c084a`: R7 canonical `0035_r7_business_optimisation_foundation`
  artefact exists (NOT executed) + R7 tables in `db/schema.ts`. **Untouched
  by this stream.**
- Provisional R8 0036 artefacts (each stream-local, none executed, none
  converged — per programme instruction): R8-A, R8-B, R8-C, R8-D
  (`0036_r8_d_strategic_reasoning_foundation.sql`), R8-F.
- **R8-E adds:** stream-local provisional
  `0036_r8_e_strategic_opportunity_risk_foundation.sql` (3 tables:
  `strategic_opportunity_risk_candidates`,
  `strategic_opportunity_risk_relations`,
  `strategic_opportunity_risk_lifecycle_events`) + matching `db/schema.ts`
  entries. Collision on the 0036 name is expected and documented here;
  R8-X owns canonical sequencing.
- `MIGRATION_EXECUTION=False` — artefact only.

## 14. Distinction checklist (locked)

| Concept | Authority | Identity family | R8-E touches? |
|---|---|---|---|
| R5 opportunity | R5-D | R5 candidate/handoff ids | never |
| R6 lead | R6-A…F | `lid1:` / numeric leads.id | never |
| R7 optimisation proposal | R7-E/F | `psn1:`/`ins1:`/`ogd1:` | never (lineage only) |
| R8-D conclusion | R8-D | `rsn1:` | read-only via projection seam |
| R8-F decision | R8-F | `sgd1:` | bind verbatim via engine seam |
| **R8-E candidate** | **R8-E** | **`sor1:` (+ `sorl1:` facts)** | **owns** |
| R9 mission | R9 (future) | R9-owned | read-only handoff projection only |

## 15. E0 verdict

All upstream authorities located and bounded. R8-E's consumption surface is
exactly: (a) R8-D durable reasoning rows → frozen 34-key projection rebuild;
(b) R8-F engine port + approval ledger view; (c) canonical `businesses`
ownership check; (d) own `sor*` tables. No other table is read or written.
Inventory complete — proceed to E1 (contract).
