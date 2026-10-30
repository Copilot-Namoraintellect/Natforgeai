# R8-X Provisional Seam Convergence (X4)

> Verdict: every provisional seam was inspected and classified. Exactly one
> class of seam required BIND (the governance engine registration ports); all
> others remain correct architectural adapters (KEEP). No seam was found that
> needed REMOVE, and no integrated direct binding creates authority beyond the
> frozen stream contracts.

Legend — classification:
- **KEEP** = remains a correct architectural adapter (guarded, read-only,
  fail-closed, no authority creation).
- **BIND** = provisional branch-development binding replaced with integrated
  repository authority.
- **REMOVE** = duplicate/obsolete seam after integration.

---

## Seam inventory

### 1. R8-A upstream seam (R7 authorities + Business DNA + strategy snapshots)

- seam=strategic-memory-upstream-seam.ts
- owner=R8-A
- classification=KEEP
- reason=Imports the integrated R7 repository authorities directly
  (`outcome/outcome-projection`, `attribution-store` +
  `attribution-projection`, `business-learning-store`, `experimentation-store`
  + `experimentation-projection`, `budget-portfolio-service`,
  `optimisation-governance-store`) and reads `businessDnaSnapshots`,
  `experimentationResults`-adjacent tables and `strategySnapshots` through the
  canonical `@db/schema` drizzle objects. No information-schema guard is
  needed because all upstream tables are canonical programme schema. This is
  the integrated authority, not a provisional binding.
- security_effect=Read-only; re-verifies tenant/business ownership on every
  upstream row; frozen per-source contract versions enforced.
- authority_effect=None — A derives memory only from governed upstream
  material; the seam can never mint FACT from client text.
- tests=api/strategic-memory-acceptance.test.ts (36 cases, incl. cross-tenant /
  cross-business / tamper failures).

### 2. B → A memory seam

- seam=business-change/business-change-memory-seam.ts
- owner=R8-B
- classification=KEEP
- reason=Raw-SQL read of `strategic_memory_records` behind an
  information-schema existence guard; when the table is absent it degrades to
  "no previous state" and the caller fails closed
  (`CHANGE_PREVIOUS_STATE_MISSING`). Post-integration the guard is permanently
  satisfiable but retained as a fail-closed safety net (same convention as the
  R6-C bridge and R7-B outcome seam at their X-integrations). Reads only
  immutable comparison columns; never writes; no path to create or promote
  memory.
- security_effect=Tenant-predicated (`userId`/`businessId` in the WHERE
  clause); CURRENT-only; expired validity windows excluded deterministically.
- authority_effect=None — B cannot fabricate A state; absent A ⇒ B evaluation
  fails closed.
- tests=api/business-change-acceptance.test.ts (39 cases).

### 3. B upstream seam (R7 budget/learning/governance + DNA + strategy evidence)

- seam=business-change/business-change-upstream-seam.ts
- owner=R8-B
- classification=KEEP
- reason=Server-side assembly of newly observed governed evidence from
  integrated R7 authorities and canonical snapshot tables; frozen source
  versions; deterministic state fingerprints.
- security_effect=Read-only, tenant/business scoped.
- authority_effect=None — detection compares authoritative states; it cannot
  invent change.
- tests=api/business-change-acceptance.test.ts.

### 4. C → (frozen F trust vocabulary)

- seam=market-signals/market-signal-contract.ts `EXTERNAL_MARKET_FROZEN_TRUST_VOCABULARY`
- owner=R8-C
- classification=KEEP
- reason=No runtime seam: C re-derives trust with the R8-F trust vocabulary by
  frozen contract copy (external classes only — `AUTHORITATIVE_INTERNAL` is
  deliberately absent and can never be minted from external content). Verified
  byte-identical to F's `STRATEGIC_EVIDENCE_TRUST_CLASSES` minus the internal
  class (see X3 vocabulary cross-check; D's evidence seam re-validates the
  same set).
- security_effect=Source registry class is server-derived only; a source can
  never mark itself trusted; spoof origins rejected.
- authority_effect=None — trust ceilings only narrow.
- tests=api/market-signal-acceptance.test.ts (36 cases).

### 5. D → A/B/C evidence seam

- seam=strategic-reasoning/strategic-reasoning-evidence-seam.ts
- owner=R8-D
- classification=KEEP
- reason=Reads A/B/C canonical tables via raw SQL behind information-schema
  guards; re-validates every row at consumption: tenant + business scope,
  identity patterns (`mem1:`/`chg1:`/`xsig1:`), frozen source versions
  (`STRATEGIC_REASONING_BOUND_VERSIONS`), closed vocabularies (verified
  identical to producer contracts in X3), freshness classes. Content is never
  loaded into the reasoning graph — evidence views carry ids/classes/hashes
  only.
- security_effect=Cross-tenant/cross-business/stale-version/tampered rows fail
  closed at the seam.
- authority_effect=None — D cannot turn association into causation (verbatim
  causation/attribution disclaimers enforced downstream of the seam).
- tests=api/strategic-reasoning-acceptance.test.ts (42),
  api/strategic-reasoning-security.test.ts (13).

### 6. D → F governance seam (engine port + approval read port)

- seam=strategic-reasoning/strategic-reasoning-governance-seam.ts
- owner=R8-D (consumes R8-F)
- classification=BOUND (engine) + KEEP (approval read port)
- reason=Stream development registered only test doubles on
  `registerStrategicGovernanceEnginePort`; unregistered state fails closed
  (`STRATEGIC_GOVERNANCE_AUTHORITY_UNAVAILABLE`). X4 BIND: the canonical
  in-process R8-F engine is now bound exactly once at server boot by
  `api/lib/strategic-governance/strategic-governance-engine-binding.ts`
  (`bindCanonicalStrategicGovernanceEngine()`, wired in `api/boot.ts`),
  forwarding proposal material to `evaluateStrategicGovernanceForProposal`
  with the tenant-anchored bridge provider and transactional store executor.
  The returned decision is re-validated field-by-field at this seam boundary.
  The approval read port (raw SQL over the shared `approval_requests` ledger,
  `approvalType='strategic_recommendation'`) is a read-only binding-hash
  validator — KEEP.
- security_effect=Fail-closed before and after binding; forged/expired/edited
  approvals rejected via `deriveApprovalBindingHash`; the binding grants D no
  authority F did not already hold.
- authority_effect=F remains the only governance authority; D can neither
  decide nor approve.
- tests=api/strategic-reasoning-acceptance.test.ts,
  api/strategic-reasoning-security.test.ts, plus the X7 connected harness
  (governance BLOCK / REVIEW_REQUIRED / forged-approval cases).

### 7. E → D reasoning seam

- seam=strategic-opportunity-risk/strategic-opportunity-risk-reasoning-seam.ts
- owner=R8-E
- classification=KEEP
- reason=Reads `strategic_reasoning_records`/`strategic_reasoning_bundles`
  behind an information-schema guard; validates the frozen
  `strategic-reasoning-to-opportunity-risk/v1` handoff shape (34-key consumer
  contract), engine version, lifecycle status and governance binding before a
  conclusion may seed a candidate. Absent governance binding ⇒ candidate
  derivation fails closed.
- security_effect=Tenant/business re-verification; superseded/demoted
  conclusions cannot seed candidates.
- authority_effect=None — E never re-derives D's conclusions.
- tests=api/strategic-opportunity-risk-acceptance.test.ts (46),
  api/strategic-opportunity-risk-security.test.ts (11).

### 8. E → F governance seam (engine port + approval read port)

- seam=strategic-opportunity-risk/strategic-opportunity-risk-governance-seam.ts
- owner=R8-E (consumes R8-F)
- classification=BOUND (engine) + KEEP (approval read port)
- reason=Same registration-port pattern as D; bound by the same canonical
  binding module (`registerStrategicOpportunityRiskGovernanceEngine` in
  `strategic-governance-engine-binding.ts`). Port requires
  `getCurrentPolicyVersion()` (staleness gate at consumption) — provided from
  the frozen code-level policy (`DEFAULT_STRATEGIC_POLICY_VERSION`). Decision
  payload validated field-by-field (`GOVERNANCE_DECISION_MALFORMED` family);
  approval reads resolve through the shared ledger with binding-hash
  validation.
- security_effect=Fail-closed when unbound; forged decision/approval shapes
  rejected; E cannot self-approve.
- authority_effect=F remains the only governance authority.
- tests=api/strategic-opportunity-risk-acceptance.test.ts,
  api/strategic-opportunity-risk-security.test.ts, X7 harness cases 29–33.

### 9. F governance bridge + store executor

- seam=strategic-governance/strategic-governance-bridge.ts
- owner=R8-F
- classification=KEEP
- reason=Tenant-anchored evidence/provider resolution and the drizzle-shaped
  store executor binding (same structural pattern as the R7-F bridge). Own
  tables are probed through information_schema with memoized existence checks;
  evidence resolution failures fail the whole evaluation closed
  (`ProviderAuthorityUnavailable`) — evidence truth is never guessed.
- security_effect=Read-only provider over canonical tables; no write path.
- authority_effect=None — F evaluates; it never fabricates A/B/C/D/E truth.
- tests=api/lib/strategic-governance/r8-f-acceptance.test.ts (39).

---

## Totals

- seams inspected: 9 (covering A-upstream, B→A, B-upstream, C→F vocabulary,
  D→A/B/C, D→F, E→D, E→F, F bridge)
- KEEP: 8
- BIND: 2 (D→F engine port, E→F engine port — both bound by the one canonical
  binding module at boot)
- REMOVE: 0
- unresolved_seams: 0

## Weakening audit

No seam change weakened: tenant validation, business validation, hash
validation, identity validation, source-version validation,
contract-version validation, status validation, freshness validation,
immutable evidence binding, governance binding, or approval binding. The only
behavioural change is that governed D/E evaluations now reach the real frozen
R8-F engine instead of failing closed with AUTHORITY_UNAVAILABLE — which is
the integrated authority the frozen contracts already prescribed.
