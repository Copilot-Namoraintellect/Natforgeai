# R8-X Duplicate Authority / Bypass Audit (X6)

> Scope: fully integrated tree (api/, db/, docs/). Method: exact-name search
> across the X6 suspect list, semantic follow-through on every hit, insert/
> update/delete surface audit on all 14 R8 tables, approval-path audit,
> mission/R9-surface audit. Result: **exactly one authority per capability;
> no alternate approval or execution path exists.**

## Suspect-name sweep results

Every hit for `forceAllow`, `forceApprove`, `overrideRisk`,
`overridePolicy`, `setTrusted`, `setConfidence`, `setPriority`,
`executeRecommendation`, `autoApprove`, `skipGovernance`, `bypassGovernance`,
`executeMission`, `createMission`, `runRecommendation`,
`raiseConfidence`, `promoteTrust`, `lowerRisk`, `suppressContradiction`,
`hideContradiction` is one of:

1. a **client-authority deny-list** in a frozen stream contract
   (`strategic-reasoning-contract.ts`, `strategic-opportunity-risk-contract.ts`,
   `market-signal-contract.ts`) — the boundary guard
   `assertNoClientAuthorityFields` rejects these fields fail-closed;
2. the **closed recovery-action rejection list** in R8-F's decision engine
   (`strategic-decision-engine.ts`) and R7-F's equivalent — recovery actions
   are validated against a closed vocabulary that excludes them;
3. **security-test payloads** asserting rejection (`strategic-reasoning-security.test.ts`,
   `strategic-opportunity-risk-security.test.ts`, R7-F acceptance);
4. **documentation comments** recording their deliberate absence.

No implementation, endpoint, tool, or call path performs any of these acts.

## Write-surface audit (who can create truth)

Inserts into R8 tables exist **only** in each stream's own store module, and
nowhere else (test files excluded; verified by exhaustive grep):

| Table | Only writer |
|---|---|
| strategic_memory_records / _lifecycle_events | `strategic-memory-store.ts` |
| business_change_events / _lifecycle_events | `business-change-store.ts` |
| external_sources / external_signals / external_signal_lifecycle_events | `market-signal-store.ts` |
| strategic_reasoning_bundles / _records / _lifecycle_events | `strategic-reasoning-store.ts` |
| strategic_opportunity_risk_candidates / _relations / _lifecycle_events | `strategic-opportunity-risk-store.ts` |
| strategic_governance_decisions | `strategic-governance-store.ts` (via executor) |

Updates are limited to optimistic-CAS guarded status/derived-class transitions
inside the owning store (`transitionMemoryStatus`, `transitionChangeStatus`,
signal derived-class patch, candidate lifecycle transition). Immutable
evidenceHash-bound cores have **no update path** anywhere. No R8 table has a
delete path.

## Authority uniqueness proof (one authority each)

- **Strategic memory — ONE authority.** FACT derives only via `ingestR7`
  through the frozen upstream seam (R7 stores + canonical snapshot tables);
  the operator `record` path attests ASSUMPTION/objective/decision/constraint
  only and can never create or promote FACT (no promotion path exists).
- **Business change — ONE authority.** Detection is a deterministic
  before/after comparison of authoritative states assembled server-side; no
  model/client can fabricate change, raise significance, or confirm its own
  evidence (confirmation only via independent-source corroboration).
- **External signal — ONE authority.** Source registry class and trust class
  are server-derived only; a source can never mark itself trusted; spoof
  origins rejected; corroboration requires genuine independence; freshness
  classes are policy-computed.
- **Strategic reasoning — ONE authority.** Only D's synthesis mints
  conclusions, from validated evidence bundles over frozen upstream versions;
  confidence caps are rule-derived; contradictions are preserved, never
  suppressed; association never becomes causation (verbatim disclaimers).
- **Opportunity/risk — ONE authority.** Candidates derive only from governed
  D conclusions through the validated reasoning seam; priority is a
  deterministic function of impact/urgency/horizon/confidence with weak-
  confidence caps; overlapping candidates cannot inflate priority (relations
  are lineage, never score inputs).
- **Strategic governance — ONE authority.** All decisions flow through the
  frozen R8-F engine; D/E consume via the X4-bound canonical port and
  re-validate every returned field at their seam boundaries; approvals bind
  decision + policy version + proposal/evidence fingerprints
  (`deriveApprovalBindingHash`) and resolve only through the shared approval
  ledger — there is no self-approval, no generic approve path that bypasses
  the binding check, and no recovery action that can mutate an immutable
  decision (audit-only).

## Execution-boundary audit

- No R8 code path creates or schedules missions; the only R9 surface is E's
  read-only `getMissionControlHandoff` projection (`candidate != mission`;
  `recommendation != execution authorization`).
- No R8 code writes Business DNA, strategy snapshots, budgets, campaigns,
  experiments, CRM, providers, payments, or billing (grep + stream acceptance
  suites; re-proven live in X7 cases 46–50).
- No alternate strategic-authority router, legacy route, or admin surface
  exists (admin router has zero strategic references; one router per
  capability verified in X2).

## Verdict

- ONE strategic-memory authority ✔
- ONE business-change authority ✔
- ONE external-signal authority ✔
- ONE reasoning authority ✔
- ONE opportunity/risk authority ✔
- ONE governance authority ✔
- No alternate approval or execution path ✔
- PRIVILEGE_ESCALATION_FOUND=False
