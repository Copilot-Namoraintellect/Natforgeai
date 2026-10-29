# R7-C Business Learning Engine — Acceptance Report

> **Stream:** WBS-R7-C — Business Learning Engine
> **Verdict:** `BUSINESS_LEARNING_ENGINE_READY` (see §Security — all guards green)
> **Rule:** No deploy, no migration execution, no production access, no live
> CRM/provider/payment/billing invocation.

---

## IDENTITY

```
branch=feature/r7-c-business-learning
HEAD=8030e97adc9fe8e6bf1cc3a93a8a66da56025a46 (programme base; this report's slice commits build on it atomically)
remote=https://github.com/Copilot-Namoraintellect/Natforgeai.git
working_tree=clean at report time (all slice files committed; no stray files)
```

## UPSTREAM

```
r7_a_head=3e8aea8   (feature/r7-a-conversion-outcome-intelligence — consumed by branch ref, NOT merged)
r7_b_head=6ff9eca   (feature/r7-b-attribution-intelligence — consumed by branch ref, NOT merged)
r7_f_head=5e4ab95   (feature/r7-f-optimisation-governance — consumed by branch ref, NOT merged)
contract_compatibility=GREEN
```

Compatibility evidence (all in `api/business-learning-acceptance.test.ts`):

- Frozen R7-A `conversion-outcome/v1` projection consumed via an exact 27-key
  allowlist mirror with verbatim causation/attribution disclaimers; any shape
  drift fails closed (`LEARNING_UPSTREAM_CONTRACT_MISMATCH`).
- Frozen R7-B `attribution-to-learning/v1` projection consumed via an exact
  25-key allowlist mirror with the verbatim causation disclaimer and
  `attributionClaimed: true`.
- R7-F remains a separate authority: R7-C mints no governance decision, embeds
  no governance engine, and names `governanceAuthorityRequired: "R7-F"` on the
  downstream projection (cases 35–37).
- R6 Lead Autonomy V1 (`8030e97a…`) untouched; R6 regressions re-run green.

## C0 — AUTHORITY / LEARNING INVENTORY

`C0=COMPLETE` — `docs/recovery/r7-c-business-learning-inventory.md`.

Critical question answered: the programme base **already contains a narrower
R4 campaign-level learning authority** (`api/lib/learning/*`, `learning_records`,
`learningRouter`, `learningPromotionRouter`, contract
`docs/contracts/learning-to-next-cycle-contract.md`). R7-C does **not** compete
with it: R4 stays campaign-performance learning (pre-outcome engine
recommendations, approval-gated promotion to the next Strategy cycle); R7-C is
**business-outcome learning** (post-outcome, evidence-bounded records derived
from governed outcomes + attribution). The four planes (campaign learning /
business-outcome learning / future experiment evidence / future optimisation
authority) are documented with exact boundary rules. No upstream authority
mutated.

## C1 — BUSINESS LEARNING CONTRACT

`C1=COMPLETE` — `docs/contracts/business-learning-contract.md` (versioned,
`business-learning/v1`). Closed vocabularies: 9 learning types, 8 subject
types, 4 confidence classes, 4 evidence classes, 5 novelty classes, 6
statuses, 6 lifecycle types, closed source-version set, closed
protected-trait list. Record shape, deterministic identities (§3),
derivation rules (§5), context scope (§6), confidence table (§7), novelty
rules (§8), lifecycle/immutability (§9), exact-once anchors (§10),
projections (§11), provenance/audit (§12), R7-F binding (§13), limitations
(§15), security invariants (§16).

## C2 — EVIDENCE BUNDLE

`C2=COMPLETE` — `api/lib/business-learning/business-learning-evidence-bundle.ts`.
Deterministic `evb1:` identity binds tenant, business, sorted outcome ids,
sorted attribution ids, consumed source versions; fingerprints bind upstream
integrity hashes (outcome `evidenceHash`, attribution `journeyHash`). No raw
evidence text/PII hashed. Rejection gates: cross-tenant (seam-scoped, case 7),
cross-business (case 6), nonexistent ids (cases 4–5), stale attributions
(case 22), stale contract versions (case 9), tampered bundles
(`LEARNING_EVIDENCE_BUNDLE_CONFLICT`). Case 11 proves order-insensitive
determinism and tenant-inside-hash.

## C3 — LEARNING CANDIDATE DERIVATION

`C3=COMPLETE` — `business-learning-derivation.ts` (pure, rule-first, no model
in the path). Candidates derive per subject from credited touchpoints
(stable ordering), falling back to deterministically-ordered excluded
candidates for zero-credit reversal journeys. Statement rendered from a
bounded closed template ("is associated with" is the strongest verb); the
optional LLM `narrativeDraft` is untrusted, hash-excluded, claim-guarded
(cases 27–29). Reversal targets verified upstream (no dangling reversals).

## C4 — CONTEXT / GENERALISATION BOUNDARIES

`C4=COMPLETE` — `business-learning-context.ts`. `contextScope` is server-derived
only (business, evidenced campaign ids, attribution window, journey stage
types, outcome types); reserved dimensions (audience/geography/creative/
channel) are structurally never derived; protected traits fail closed
(`LEARNING_PROTECTED_TRAIT_DIMENSION`, case 26). Cases 24–25 prove
campaign-scoped learning never generalises.

## C5 — CONFIDENCE / EVIDENCE QUALITY

`C5=COMPLETE` — `business-learning-confidence.ts`. Closed deterministic table:
support count × attribution confidence floor (min over support-contributing
attributions) × verification state, one-class drop per contradiction set,
provisional cap at MODERATE with PROVISIONAL/MIXED labelling. Single pair can
never reach STRONG (case 15); consistent pairs strengthen (case 16);
contradictions lower the class (case 17). No model opinion, no averaging.

## C6 — CONTRADICTION / REPETITION / NOVELTY

`C6=COMPLETE` — `business-learning-novelty.ts`. Closed classification
DUPLICATE → CONTRADICTING → SUPERSEDING → REINFORCING → NEW. Repeated
identical evidence replays without inflating support (cases 10, 19);
contradictions retain both histories with immutable facts and CAS transitions
(cases 18, 31); supersession preserves full history (case 21); reinforcing
recognised (case 20). No deletion path exists anywhere.

## C7 — LEARNING LIFECYCLE / IMMUTABILITY

`C7=COMPLETE` — immutable insert-only rows + CAS-guarded `version` status
transitions + append-only `business_learning_lifecycle_events`. Upstream
changes re-evaluate: outcome reversal/cancellation INVALIDATES the dependent
record and re-derives the contradiction history (case 3); superseded
attributions and verification changes mint SUPERSEDING successors (cases 22,
23). Stale learning never remains silently active.

## C8 — DOWNSTREAM HANDOFF

`C8=COMPLETE` — `docs/contracts/business-learning-to-experiment-optimisation-contract.md`
(`business-learning-to-experiment-optimisation/v1`, exact 23-key projection,
verbatim causation disclaimer) + `business-learning-projection.ts`. Read-only;
downstream may consume ids/type/subject/context/classes/counts/source
ids/limitations/freshness/governance-eligibility metadata only. Learning does
not authorize experiment execution (case 34) or budget change (case 33);
R7-D/R7-E must separately obtain R7-F authority (case 37).

## C9 — CONNECTED ACCEPTANCE

`C9=COMPLETE` — `api/business-learning-acceptance.test.ts`, **41/41 green**.
All 40 required cases proven (1 verified candidate; 2 provisional
conservatism; 3 reversal invalidation; 4–9 rejection gates; 10 no support
inflation; 11 deterministic bundle identity; 12 identical-request
convergence; 13 concurrent convergence; 14 conflicting replay fail-closed;
15 single-outcome cap; 16 multi-outcome strengthening; 17 contradiction
lowers confidence; 18 contradiction visibility; 19 duplicate; 20
reinforcing; 21 supersession history; 22 stale-attribution re-evaluation;
23 verification-change re-evaluation; 24 context specificity; 25 no
cross-audience generalisation; 26 protected-trait rejection; 27–29 narrative/
injection/confidence guards; 30 no client SUPPORTED/STRONG; 31 no
contradiction removal; 32–34 no direct strategy/budget/experiment mutation;
35–36 read-only D/E projections; 37 R7-F separation; 38 zero upstream
mutation; 39 deterministic audit exactly-once; 40 no provider/billing
action) + 4 frozen-contract compatibility assertions.

Harness: REAL service + REAL stores + REAL pure modules over an in-memory
fake DB replicating the durable unique anchors; frozen upstreams consumed by
shape-serving fake authorities; explicit injected clock; no real database,
no provider.

## TESTING

```
targeted=41/41 green (api/business-learning-acceptance.test.ts)
affected_regressions=GREEN — api/learning-router.test.ts, api/learning-promotion-router.test.ts,
  api/learning-promotion-continuation.test.ts, api/lib/learning/** (R4 campaign learning untouched),
  api/r6-x-harness.test.ts (37), api/r6-x-review-acceptance + security (via full suite),
  api/lib/audit/audit-event.test.ts + audit-store.test.ts, db/__tests__/schema.test.ts,
  api/lib/queue/terminal-content-replay-executor.test.ts, R5 suites (via full suite)
full_suite=6532 tests: 6450 passed, 66 skipped, 14 todo; 3 failed files, ALL environmental
  (2 dbName-guard tests require DATABASE_URL — proven green with it set; src/pages/Campaigns.test.tsx
  requires VITE_FIREBASE_* env). None touch R7-C code paths; failures identical in nature at base.
typescript=tsc -b GREEN
build=npm run build GREEN (vite + esbuild + deployment verification)
diff_check=git diff --check GREEN (no whitespace errors; LF-normalized worktree)
secret_scan=GREEN (no secrets/PII in new files; evidence-bundle hashes ids only)
```

## SCHEMA

```
schema_changed=true (append-only: business_learning_records + business_learning_lifecycle_events)
provisional_migration=db/migrations/0035_r7_c_business_learning.sql (+ meta journal idx 35 + 0035_snapshot.json)
migration_execution=False
```

Collision with sibling provisional `0035_*` artefacts documented in
`docs/recovery/r7-c-unexecuted-migrations.md`; R7-X owns canonical R7
convergence. Runtime degrades fail-closed until the upstream tables exist.

## SECURITY

```
SECURITY_VERDICT=PASS
LEARNING_INTEGRITY_VERDICT=PASS        (immutable rows + recordHash; tamper fails closed on every read; conflicting replay rejected)
TENANT_ISOLATION_VERDICT=PASS          (session userId anchors every identity/predicate/hash; cross-tenant evidence unreachable — case 7)
EVIDENCE_INTEGRITY_VERDICT=PASS        (frozen-shape validation; unknown/dangling/stale evidence rejected; no fabricated support)
GENERALISATION_GUARD_VERDICT=PASS      (server-derived bounded scope; reserved/protected dimensions rejected — cases 24–26)
CONTRADICTION_INTEGRITY_VERDICT=PASS   (append-only contradiction history; no removal/averaging path — cases 17–18, 31)
AGENT_ISOLATION_VERDICT=PASS           (model output is untrusted data; narrative drafts hash-excluded + claim-guarded — cases 27–29)
PROMPT_INJECTION_RESISTANCE_VERDICT=PASS (injected drafts with authority claims rejected; no instruction surface in the engine)
TOOL_LEAST_PRIVILEGE_VERDICT=PASS      (no shell/SQL/secret/provider seams in the engine; deps = ports + executor + clock only)
CROSS_AGENT_TRUST_VERDICT=PASS         (no cross-agent trust surface; upstream/downstream consumed via frozen contracts only)
SELF_MODIFICATION_GUARD_VERDICT=PASS   (no policy/threshold/permission mutation path; closed code-level vocabularies)
SECRET_ISOLATION_VERDICT=PASS          (no secret access; evidence bundle hashes ids/labels/hashes only — never raw evidence or PII)
PRIVILEGE_ESCALATION_FOUND=none
ROGUE_AGENT_BLAST_RADIUS=contained — a compromised runtime model/agent can, at worst, submit bounded
  narrative drafts (claim-guarded, non-authoritative) or reference existing evidence ids; it cannot
  fabricate evidence, mint identities, suppress contradictions, raise confidence, or touch
  strategy/budget/experiment/governance authority. No production/provider/payment/billing action
  exists in the stream (case 40).
UNRESOLVED_AGENT_SECURITY_DEBT=none known
```

READY criteria check: untrusted input/agent output cannot fabricate evidence
(cases 4–9, 14), cannot suppress contradictions (cases 18, 31), cannot
increase confidence (cases 15–17, 29–30), and cannot directly alter
strategy/budget/experiment authority (cases 32–37). **READY is permitted.**

## EXTERNAL_LIMITATIONS

- Real-MySQL execution of the provisional migration is deferred to R7-X
  (`MIGRATION_EXECUTION=False`); schema anchors are structurally verified and
  exercised via in-memory fakes replicating the durable unique indexes.
- Two full-suite test files fail only for missing local environment
  variables (`DATABASE_URL` dbName guards; `VITE_FIREBASE_*` Campaigns page)
  — proven green when the variables are present; unrelated to this stream.
- R7-A/R7-B/R7-F consumed by frozen contract shape (branches not merged by
  mandate); production wiring of the guarded read seams lands at R7-X.

## FINAL VERDICT

```
BUSINESS_LEARNING_ENGINE_READY
```
