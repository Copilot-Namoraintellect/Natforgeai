# R8-D STRATEGIC REASONING — AUTHORITY / REASONING INVENTORY (D0)

> Stream: WBS-R8-D `feature/r8-d-strategic-reasoning`
> Base: `a2c084a1f0bca110a00e51f83632733789cec5f7` (R7-X integration head)
> Date: 2026-11-10
> Verdict basis for D1–D9 design. Consumes frozen upstream authorities **by
> branch ref only** — no merges.

---

## 1. Frozen upstream authorities (consumed, not merged)

| Authority | Branch | Accepted HEAD | Consumable surface (read-only) |
|---|---|---|---|
| R8-A Strategic Memory | `feature/r8-a-strategic-memory` | `23d0f22` | `strategic-memory-to-reasoning/v1` projection (30-key allowlist): `mem1:` ids, `memoryType`, `statementType` (FACT/ASSUMPTION), `factStatus`, `confidenceClass`, `evidenceRefs`, `sourceAuthority`, `sourceVersion`, validity windows, contradiction visibility (`contradictsMemoryIds`/`contradictedByMemoryIds`), context scope, verbatim causation/attribution disclaimers |
| R8-B Business Change Intelligence | `feature/r8-b-business-change-intelligence` | `055eece` | `business-change-to-reasoning/v1` projection (28-key allowlist): `chg1:` ids, `changeDomain`, `changeType` (directional, closed 20), `subjectType`, state refs, `significanceClass`, `confidenceClass`, `status` (DETECTED…EXPIRED), `governanceEligibilityHint`, contradiction + supersession lineage |
| R8-C Market & External Signals | `feature/r8-c-market-external-signals` | `b366c5e` | `external-signal/v1` projection (34-key allowlist): `xsig1:` ids, `signalType`, `sourceTrustClass` (R8-F frozen vocabulary), `confidenceClass`, `freshnessClass`, `corroborationStatus`, `relevanceClass`, `signalStatus`, `injectionSuspected`, verbatim disclaimers; external content never projected (`INERT_EVIDENCE`) |
| R8-F Strategic Governance | `feature/r8-f-strategic-governance` | `44118e3` | `strategic-governance/v1`: closed decisions `ALLOW_RECOMMENDATION`/`REVIEW_REQUIRED`/`BLOCK`; closed recommendation taxonomy (10, no execution types); trust classes, confidence derivation `min(claimed, evidence ceiling)`, strategic risk, OTP-bound human approval (`approvalType = "strategic_recommendation"`), `assertStrategicRecommendationConsumable` → `RECOMMENDATION_ONLY` |
| R7 Business Optimisation | `integration/r7-business-optimisation` | `a2c084a` | `business-optimisation-to-strategic-intelligence/v1`: outcomes, attribution, learning, experiments, portfolio strategy handoff (`business-optimisation-to-strategy/v1`, 23 keys) as read-only strategic evidence |

Upstream tables are **not on this branch**. Consumption is via raw-SQL seams
behind guarded `information_schema` checks (house pattern, cf.
`api/lib/business-change/business-change-memory-seam.ts`), with in-memory fake
ports enforcing identical semantics in tests. R8-X owns canonical binding.

## 2. Existing strategy / recommendation / reasoning modules (critical task)

Searched for existing owners of campaign strategy, recommendation, strategic
reasoning, insight generation:

| Module | What it owns | Conflict with R8-D? |
|---|---|---|
| `api/lib/strategy/` (`strategy-snapshot*`) | Campaign strategy **materialisation snapshots**: captures the strategy document a campaign run used (`snapshotId`, `strategyHashSha256`, `businessDnaSnapshotId`, versioning, conflict detection on re-materialisation). Pure campaign-strategy record-keeping | **No.** It snapshots campaign-level strategy truth; it does not reason. R8-D references strategy only as evidence (`strategy_snapshot` sourceAuthority rows in R8-A memory). |
| `api/campaign-router.ts` | Campaign CRUD + `strategy` field storage + generation limits | **No.** Campaign strategy authoring/limits remain R2/campaign authority. R8-D never mutates campaigns |
| `api/agent-router.ts`, `api/lib/agents/` | AI agent orchestration (creative/distribution agents), prompt/agent contracts, OpenAI calls | **No ownership conflict**, but note: no existing component performs *strategic* reasoning over governed evidence. R8-D's optional model seam is new and bounded (structured evidence in → schema-validated candidates → every evidence ref revalidated; never authority) |
| `api/lib/learning/` (`learning-router.ts`) | Phase-1 campaign-learning evaluation (idempotent, governed) | **No.** Narrower campaign-level learning; R8-D consumes learning only via R8-A memory projections |
| `api/lib/business-learning/` (R7-C) | Business learning records from R7-A/B | **No.** R8-D consumes via R8-A, never directly |
| `api/lib/intelligence/` (`intelligence-router.ts`) | R5-B intent & sentiment interpretation of social listening | **No.** Signal-class intelligence upstream of R5; different evidence class |
| `api/lib/budget-portfolio/` (R7-E) | Bounded optimisation proposals + read-only strategy handoff | **No.** Optimisation proposes; R8-D reasons over the handed-off evidence. D must not become a second optimisation engine |
| `api/lib/outcome|attribution|experimentation|optimisation-governance` (R7) | R7 authorities | **No.** Read-only consumption via frozen projections only |

**Conclusion: no existing component owns strategic reasoning or strategic
conclusions.** R8-D fills the gap without competing with narrower R4/R7
strategy authorities.

## 3. Boundary map (D0 required deliverable)

```
CAMPAIGN STRATEGY (R2/campaign authority + strategy snapshots)
  owns: the strategy document of a campaign; snapshot truth
  R8-D: references only, as evidence via R8-A memory

BUSINESS OPTIMISATION (R7-E + R7-F)
  owns: bounded budget/portfolio proposals, governed optimisation decisions,
        authorised instructions
  R8-D: consumes read-only handoff evidence; never proposes reallocations,
        never re-derives attribution credit, never evaluates optimisation
        governance

STRATEGIC REASONING (R8-D — THIS STREAM)
  owns: reasoning-session identity, evidence bundles, reasoning graph/
        provenance, hypotheses, implication classification, support/
        contradiction accounting, confidence/uncertainty classification,
        conclusion lifecycle, governance binding, downstream projection
  does NOT own: any upstream truth, governance authority, execution

R8-E OPPORTUNITY / RISK INTELLIGENCE (sibling, future)
  owns: opportunity/risk ranking & classification over governed conclusions
  R8-D→E: read-only projection (`strategic-reasoning-to-opportunity-risk/v1`);
  E must never mutate R8-D authority

R9 MISSION PLANNING (future)
  owns: mission construction / execution planning from approved recommendations
  R8-D→R9: nothing direct; R9 consumes approved recommendation metadata via
  R8-F's read-only handoff. A D conclusion is never an instruction.
```

## 4. AI / LLM orchestration infrastructure

- `api/lib/agents/` — OpenAI-backed agent runners (creative, distribution).
  Prompt/agent contracts live there. R8-D **does not reuse** these executors:
  the strategic-reasoning model seam is a separate, stricter bounded surface
  (no DB/tool access, strict output schema, evidence-ref revalidation,
  candidate-only, no chain-of-thought persistence). If no model is registered,
  rule-first synthesis still produces fully valid conclusions.

## 5. Audit / approval / schema state

- **Audit:** canonical `audit_events` ledger (`api/lib/audit/audit-event.ts`).
  R8-D adds `strategic_reasoning_recorded` / `strategic_reasoning_lifecycle`
  material types (additive; metadata = ids/closed labels/hashes only).
- **Approval:** governed `approval_requests` ledger, R8-F's
  `approvalType = "strategic_recommendation"` (provisional 0036 extension on the
  R8-F branch). R8-D reads the ledger **read-only** to derive approval state;
  it never writes approvals and never self-approves.
- **Schema/migration:** provisional R8 0036 migrations exist per stream
  (A/B/C/F) — **not converged here**. R8-D adds its own stream-local
  provisional `0036_r8_d_strategic_reasoning_foundation.sql` (artefact only,
  NOT executed; R7 `0035` untouched; collision documented in
  `docs/recovery/r8-d-unexecuted-migrations.md`; R8-X owns convergence).

## 6. Design consequences

1. Upstream evidence is loaded server-side by reference only
   (`memoryRefs[]`/`changeRefs[]`/`externalSignalRefs[]`); every row is
   re-validated (tenant, business, contract version, identity pattern,
   status/freshness) before use. Cross-tenant / cross-business / unknown /
   stale-contract refs fail closed.
2. Deterministic evidence-bundle identity: same authoritative evidence set →
   same `evb1:` bundle; duplicate reasoning converges; conflicting replay
   fails closed.
3. Rule-first synthesis (deterministic), model-assistance optional and
   non-authoritative; confidence derives from evidence quality caps only.
4. Governance is R8-F's engine bound through a registration seam — **no
   second governance engine**. Absence of the R8-F authority ⇒ fail closed.
5. Conclusions are recommendation candidates (`MONITOR`…`NO_ACTION` closed
   set); no execution semantics anywhere.
