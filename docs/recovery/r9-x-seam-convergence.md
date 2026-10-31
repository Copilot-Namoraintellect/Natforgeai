# R9-X Seam Convergence (X4)

**Date:** 2026-11-12
**Integration branch:** `integration/r9-mission-control`
**Classification:** KEEP / BIND / REMOVE per seam, with authority + security effects.

---

## 1. Seam inventory and classification

### 1.1 R9-A → R8 (strategic intelligence)

```
seam=mission-authority-candidate-seam (resolveGovernedCandidate)
owner=R9-A (consumes) / R8-E (authority)
classification=KEEP
reason=Frozen strategic-intelligence-to-mission-control/v1 37-key projection rebuilt
  verbatim from durable R8-E rows behind a guarded information-schema check;
  approval re-derivation + R8-E assertCandidateConsumable (RECOMMENDATION_ONLY)
  re-run on every call; stale/expired/blocked/tampered/cross-scope fail closed.
authority_effect=None — R8 remains the only strategic-recommendation authority.
security_effect=Unknown/ungoverned/cross-tenant/cross-business candidates can never
  mint a mission.
tests=api/mission-authority-acceptance.test.ts (28), api/mission-authority-security.test.ts (14)
```

### 1.2 R9-B → R9-A / R9-F

```
seam=mission-planning-mission-seam (createRawSqlMissionAuthorityReadPort + in-memory twin)
owner=R9-B (consumes) / R9-A (authority)
classification=KEEP
reason=Frozen mission-authority-to-planning/v1 projection (exact key allowlist
  verified identical to R9-A's emitted set — 25 keys, byte-sorted match) rebuilt
  from durable mission rows; mission eligibility/freshness revalidated on every
  planning call; drift fails closed (PLAN_MISSION_AUTHORITY_DRIFT).
authority_effect=None — mission authority remains R9-A.
security_effect=Planning can never mint or widen mission material.
tests=api/mission-planning-acceptance.test.ts (39), api/mission-planning-security.test.ts (17)
```

### 1.3 R9-C → R9-A / R9-F

```
seam=mission-scheduling-upstream-seam (raw-SQL mission revalidation, guarded)
owner=R9-C (consumes) / R9-A (authority)
classification=KEEP
reason=Every scheduling write re-verifies the durable R9-A mission row
  (tenant/business/status/validity) behind a guarded information-schema check;
  absent authority fails closed.
authority_effect=None.
security_effect=Scheduling can never create or rewrite mission authority.
tests=api/mission-scheduling-acceptance.test.ts (35), api/mission-scheduling-security.test.ts (14)

seam=mission-scheduling-governance-seam (read-only R9-F decision reads)
owner=R9-C (consumes) / R9-F (authority)
classification=KEEP
reason=Readiness consults durable R9-F decisions read-only; C may surface
  requiresApproval=true, never mints ALLOW, never invokes the consumption gate.
authority_effect=None — R9-F remains the only decision authority.
security_effect=No self-approval surface exists in C (asserted: no approval-named
  procedures).
```

### 1.4 R9-C → R9-B task-plan port — **the mandated X4 binding**

```
seam=mission-task-plan/v1 typed input port (registerPlan boundary)
owner=R9-C (scheduling material) bound to R9-B (planning authority)
classification=BIND  ← R9-X action
reason=Pre-integration the router accepted a client-supplied typed port document.
  At R9-X the boundary is server-authoritative: clients reference
  { missionId, planId } only; the port document is derived in
  api/lib/mission-scheduling/mission-scheduling-plan-port.ts from R9-B's durable
  plan rows through B's own scheduling-handoff service (mission revalidation,
  freshness, effective-status derivation, frozen projection validators) and
  re-validated through the exact missionTaskPlanPortSchema. The service-level
  typed path (registerMissionTaskPlan) is retained for direct store/service
  tests (verbatim-material integrity, replay-conflict — SEC-9/C11.18).
authority_effect=Plan content authority is R9-B alone; C only sequences/schedules
  the derived material and never rewrites it.
security_effect=Clients/agents can no longer inject arbitrary task definitions,
  capability contracts or environment contracts at the boundary. The
  supportedCapabilities environment contract is the server-owned closed
  registry (R9-B CAPABILITY_REGISTRY keys — verified to satisfy C's
  CAPABILITY_PATTERN exactly; R9-D's dotted execution capability namespace is a
  different vocabulary and is deliberately NOT merged — verified contract
  compatibility, not weakened).
mapping_verified=deterministic total map: B [{condition, ref}] → C bounded task
  refs; B constraint records filtered to C's closed scheduling-constraint
  vocabulary (TIME_WINDOW/EXCLUSIVE_RESOURCE); B governance class/characteristics
  → C governanceCharacteristics (requiresApproval conservative from
  governanceClass; irreversible/financialExposure carried verbatim;
  side-effect class total-mapped; client-declared risk dropped — raise-only
  derives from B financial material); per-task validity null (B defines no
  per-task windows — expired windows bind as TIME_WINDOW constraints ⇒
  BLOCKED_TIME_WINDOW).
tests=api/mission-scheduling-acceptance.test.ts (35, reworked to seed frozen R9-B
  rows and register through the canonical binding), api/mission-scheduling-security.test.ts
  (14, reworked; SEC-4 drift expressed as B-row drift, SEC-10 risk floor from B
  financial material), api/lib/mission-scheduling/mission-scheduling-plan-port.ts
  (module-level PLAN_PORT_BINDING surface).
```

### 1.5 R9-D → R9-A/B/C/F

```
seam=execution-upstream-seams (guarded raw-SQL revalidation of mission/plan/schedule)
owner=R9-D (consumes) / R9-A,B,C (authorities)
classification=KEEP
reason=Immediately before the side-effect boundary, D re-reads the durable A/B/C
  rows behind guarded information-schema checks; staleness, plan/schedule drift
  or absent authority ⇒ NO DISPATCH. Schedule evidence is consumed read-only
  (mission-scheduling-to-execution/v1 projection validated for shape).
authority_effect=None — A/B/C authority is consumed, never rewritten.
security_effect=No dispatch against stale/unscheduled/drifted authority.

seam=execution-governance-seam (assertMissionActionConsumable port)
owner=R9-D (consumes) / R9-F (authority)
classification=KEEP
reason=Faithful frozen port of the mission-governance-to-execution/v1 gate:
  exact decision + policy + params fingerprint + risk + approval binding-hash
  revalidation immediately before dispatch. Forged/expired/edited approvals
  fail closed. D never re-interprets governance semantics, never writes R9-F.
authority_effect=None — R9-F remains the only authorization authority.
security_effect=No dispatch without exact current authorization; no fabricated
  ALLOW consumable.

seam=execution-adapter-registry
owner=R9-D
classification=KEEP
reason=Closed adapter registry (CAMPAIGN/CONTENT/SOCIAL/CRM/NOTIFICATION/
  ANALYTICS/INTERNAL_WORKFLOW) with server-controlled capability-driven
  selection; clients/models can never name modules, URLs, shell, SQL, tools or
  credentials. Sandbox fake/in-memory adapters only (LIVE_EXECUTION=False).
authority_effect=None — execution actions remain exactly-authorized envelopes.
security_effect=Arbitrary adapter/provider/account selection is impossible.
```

### 1.6 R9-E → R9-A/B/C/D/F

```
seam=mission-state-upstream-seam (guarded raw-SQL A/B/C reads)
owner=R9-E (consumes) / R9-A,B,C (authorities)
classification=KEEP
reason=State derivation re-reads durable mission/plan/schedule rows read-only
  behind guarded information-schema checks; absent upstream ⇒ fail-closed
  derivation (never fabricated state).
authority_effect=None.
security_effect=State is derived, never set; no inferred success anywhere.

seam=mission-execution-seam (D evidence consumption)
owner=R9-E (consumes) / R9-D (authority)
classification=KEEP
reason=Execution actions/attempts consumed READ-ONLY via raw-SQL row views with
  closed-vocabulary revalidation (R9-D classification trusted verbatim, never
  re-classified, never rewritten). Malformed rows throw.
authority_effect=None — execution history is immutable input.
security_effect=No rewriting of attempts; UNCERTAIN never becomes SUCCESS.

seam=mission-recovery-governance-seam (R9-F gate for recovery consumption)
owner=R9-E (consumes) / R9-F (authority)
classification=KEEP
reason=Frozen assertMissionActionConsumable semantics re-run for recovery
  consumption (exact subject/action/refs/params fingerprint + policy version +
  approval binding-hash); AUTHORIZED performs nothing inside E — consumable
  recoveries emit a read-only execution-recovery handoff for R9-D.
authority_effect=None — recovery authorization remains R9-F.
security_effect=Recovery proposal != recovery authorization; self-authorization
  impossible.
```

### 1.7 R9-F internals

```
seam=approval ledger reuse (approval_requests, approvalType "mission_action") +
  governed OTP review authority (purpose review_authorization)
owner=R9-F
classification=KEEP
reason=Approvals are exact-bound ledger records (decision + policy version +
  context binding hash); human rejection permanently blocks the decision
  identity; single-use mailbox-only OTP — a tenant JWT alone can never resolve.
authority_effect=R9-F is the single governance/approval authority.
security_effect=No self-approval; forged/expired/edited approvals fail closed.
```

## 2. Convergence verdict

```
seams_keep=10   (A→R8; B→A; C→A; C→F-read; D→A/B/C; D→F-gate; D adapters;
                 E→A/B/C; E→D; E→F-recovery; F ledger/OTP — all read-only
                 consumptions behind guarded checks)
seams_bind=1    (C mission-task-plan/v1 typed port → frozen R9-B planning
                 authority — this X4 action)
seams_remove=0  (no seam was deleted; the provisional client-supplied port path
                 was rebound at the router boundary and retained at service
                 level for store-level integrity tests)
unresolved_seams=0
```

**X4=ACCEPTED** — R9-C's provisional typed task-plan input port is bound to the
actual frozen R9-B planning authority with exact contract compatibility
verified (schema revalidation on every derived document; capability vocabulary
pattern-match proven; no tenant/business/mission/plan/task/status/constraint/
approval/governance/idempotency/hash validation weakened — the binding ADDS
server-authoritative derivation).
