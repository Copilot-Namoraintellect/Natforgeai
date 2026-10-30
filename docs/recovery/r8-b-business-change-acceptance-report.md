# R8-B Business Change Intelligence — Acceptance Report

> **Stream:** WBS-R8-B Business Change Intelligence
> **Branch:** `feature/r8-b-business-change-intelligence`
> **Verdict:** `BUSINESS_CHANGE_INTELLIGENCE_READY`

---

## IDENTITY

```
branch=feature/r8-b-business-change-intelligence
HEAD=cb422a3 (slice commit; this report is committed on top as the final artefact)
remote=origin (https://github.com/Copilot-Namoraintellect/Natforgeai.git) — branch pushed
working_tree=clean at acceptance time
```

## UPSTREAM

```
r8_a_head=23d0f22 (STRATEGIC_MEMORY_READY — consumed by branch ref only, NOT merged)
r8_f_head=44118e3 (STRATEGIC_GOVERNANCE_READY — consumed by contract reference only, NOT merged)
contract_compatibility=CONFIRMED — R8-B consumes the frozen
  strategic-memory-to-reasoning/v1 semantics (CURRENT-only anchors, FACT/
  ASSUMPTION distinction, contradiction visibility, read-only) through the
  memory seam; R8-F is referenced only for the advisory
  governanceEligibilityHint (R8-F remains the sole governance authority).
  No R8-A/R8-F code merged; no sibling R8 streams merged.
```

## DELIVERABLES

```
B0=docs/recovery/r8-b-business-change-inventory.md — authority/change
   inventory; directly observable vs derived vs unsupported inference
   classified; PRICING/CHANNEL/CUSTOMER_BEHAVIOUR/LEAD_CONVERSION evaluated
   and deferred (no durable before/after authority without unsupported
   inference in v1).
B1=docs/contracts/business-change-intelligence-contract.md — versioned
   business-change/v1 contract (closed vocabularies; chg1: identity; state
   refs; significance model; lifecycle; security; audit; schema).
B2=deterministic change identity — api/lib/business-change/business-change-identity.ts
   (changeKey over tenant+business+subject+changeType+before/after
   fingerprints; tamper/fingerprint rejections; §4 contract).
B3=rule-first change detection — business-change-detection.ts (closed
   directional types over canonical-normalised state views; documented
   normalisation; no model; representation drift cannot mint changes).
B4=closed significance model — business-change-significance.ts
   (LOW<MODERATE<HIGH<CRITICAL; bounded dimensions; binding confidence caps:
   UNVERIFIED≤LOW, OBSERVED/PROVISIONAL≤MODERATE, VERIFIED≤HIGH,
   AUTHORITATIVE≤CRITICAL).
B5=temporal/lifecycle model — business-change-temporal.ts + bcl1: facts
   (DETECTED/CONFIRMED/PROVISIONAL/CONTRADICTED/SUPERSEDED/INVALIDATED/
   EXPIRED; precedence derivation; CAS transitions; corrections are new
   rows bound by supersedesChangeId; duplicates converge).
B6=strategic memory binding — business-change-memory-seam.ts (read-only
   raw-SQL seam behind guarded information-schema check; CURRENT-only
   anchors; validUntil exclusion; FACT/ASSUMPTION preserved and
   confidence-capping; pointer re-load of immutable upstream rows; change
   can never rewrite memory — memoryCandidate is a labelled reference only).
B7=governance/security/agent boundaries — strict zod boundaries + pure
   client-authority guard; protected-trait rejection; server-side ownership
   re-verification; R8-F consumed by reference (advisory hint only);
   non-execution invariant (no DNA/strategy/budget/memory/R7 writes).
B8=docs/contracts/business-change-to-strategic-reasoning-contract.md —
   business-change-to-reasoning/v1, exact 28-key allowlist (asserted in
   acceptance), verbatim causation disclaimer, memoryCandidate shape,
   governanceEligibilityHint table.
B9=connected acceptance — api/business-change-acceptance.test.ts, 39/39
   green over the real router/service/store/seams against the in-memory
   fake (all 36 required checks + corroboration classification + memory-seam
   semantics + anchor-advance idempotency).
```

## TESTING

```
targeted=39/39 R8-B connected acceptance green; 20/20 audit taxonomy green
affected_regressions=full offline suite: 6909 passed / 1 failed (flake) —
  r4-x6-full-autonomy-e2e hook timeout under parallel load; re-run in
  isolation: 21/21 green. No regressions attributable to R8-B.
full_suite=6992 tests collected (6909 passed, 68 skipped, 14 todo, 1 flake)
typescript=npx tsc -b — clean (TSC_EXIT=0)
build=npm run build — green (vite + api bundle + deployment verification)
diff_check=git diff --check — clean
secret_scan=manual grep over new files — no secrets/PII (hashes + closed
  labels only; audit metadata carries ids/classes/hashes, never state text)
```

## SCHEMA

```
schema_changed=true — db/schema.ts gains business_change_events +
  business_change_lifecycle_events (source of truth only).
provisional_migration=db/migrations/0036_r8_b_business_change_foundation.sql
migration_execution=False — artefact only; 0036 collision with the R8-A
  (0036_r8_a_strategic_memory_foundation) and R8-F
  (0036_r8_f_strategic_governance_foundation) stream-local provisionals
  documented in docs/recovery/r8-b-unexecuted-migrations.md; R8-X owns
  canonical convergence. R7 0035 untouched.
```

## SECURITY

```
SECURITY_VERDICT=PASS
BUSINESS_CHANGE_INTEGRITY_VERDICT=PASS — change detection compares
  server-loaded authoritative states only; immutable evidenceHash-bound
  cores; conflicting replay fails closed; corrections are new rows.
TENANT_ISOLATION_VERDICT=PASS — session userId anchors every read/write;
  cross-tenant and cross-business sources fail closed (B9.8/B9.9).
STATE_COMPARISON_INTEGRITY_VERDICT=PASS — previous state is R8-A CURRENT
  memory re-resolved through the pointer chain; clients can never supply
  previous/current state, fingerprints, or refs (B9.29; guard rejects).
SIGNIFICANCE_INTEGRITY_VERDICT=PASS — server-derived, confidence-capped;
  no boundary field; weak evidence cannot rank HIGH/CRITICAL (B9.21/22/23).
TEMPORAL_INTEGRITY_VERDICT=PASS — deterministic precedence; CAS-guarded
  transitions; append-only bcl1: facts; supersession/contradiction lineage
  preserved; expiry excluded from active projection (B9.18/19/20).
AGENT_ISOLATION_VERDICT=PASS — no model field exists at the boundary; a
  runtime agent can only name sources/subjects or attest bounded content.
PROMPT_INJECTION_RESISTANCE_VERDICT=PASS — injected text is inert bounded
  content, protected-trait scanned, never authority (B9.24/25/26).
TOOL_LEAST_PRIVILEGE_VERDICT=PASS — the stream exposes no shell/SQL/tool
  execution; the only writes are its two tables + canonical audit events.
CROSS_AGENT_TRUST_VERDICT=PASS — no trust delegation between agents; all
  authority is server-derived from durable rows.
SELF_MODIFICATION_GUARD_VERDICT=PASS — no permission/role/policy mutation
  surface exists in the stream.
SECRET_ISOLATION_VERDICT=PASS — no secret access; raw SQL is a fixed
  template over the guarded memory table; no environment/secret reads.
PRIVILEGE_ESCALATION_FOUND=NONE
ROGUE_AGENT_BLAST_RADIUS=CONFINED_TO_OWN_TABLES — a compromised runtime
  agent can at most create PROVISIONAL, confidence-capped change rows bound
  to real compared states; it cannot fabricate before/after state, raise
  significance, suppress contradiction, confirm its own evidence, mutate
  strategic memory/DNA/strategy/budget, or reach any execution surface.
UNRESOLVED_AGENT_SECURITY_DEBT=NONE known. Documented v1 design boundary
  (not debt): cross-source corroboration (CONFIRMED) is structurally
  unreachable in v1 because every subject type binds exactly one source
  authority; the confirmation machinery is implemented and store-verified
  for future two-source domains at R8-X.
```

## FINAL VERDICT

```
BUSINESS_CHANGE_INTELLIGENCE_READY
```

R8-B detects and classifies meaningful internal changes to the durable
strategic state of the business — deterministic, evidence-bounded,
immutable, tenant-isolated, and read-only towards every upstream authority.
Change detection compares authoritative states; it does not invent change.
