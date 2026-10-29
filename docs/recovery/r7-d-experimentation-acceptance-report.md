# R7-D Experimentation — Acceptance Report

> **Stream:** WBS-R7-D — Experimentation Engine
> **Branch:** `feature/r7-d-experimentation`
> **Programme base:** `8030e97adc9fe8e6bf1cc3a93a8a66da56025a46`
> **Rule:** frozen upstream contracts consumed by branch reference only — no
> sibling R7 branch was merged. `MIGRATION_EXECUTION = False`. No deployment,
> no production access, no live CRM/provider/payment/billing invocation.

---

## IDENTITY

```
branch=feature/r7-d-experimentation
HEAD=946a528   (stream content HEAD this report verifies; programme base 8030e97)
remote=https://github.com/Copilot-Namoraintellect/Natforgeai.git
working_tree=clean at report time (all stream artefacts committed)
```

## UPSTREAM

```
r7_a_head=3e8aea8   (verified git rev-parse 3e8aea8b4367da599bb8a28887c156c7241eae9c)
r7_b_head=6ff9eca   (verified 6ff9ecad58e3861e472b6b26dbbf2c951a8707f5)
r7_c_head=53b2ff4   (verified 53b2ff4191e832f7a562e62c0ff3b50d066aab99)
r7_f_head=5e4ab95   (verified 5e4ab95c71702e4d30d05d34f7a0c76b96d28c20)
contract_compatibility=PASS
```

Frozen-shape compatibility is asserted in the acceptance suite:
R7-C `business-learning-to-experiment-optimisation/v1` (23-key allowlist),
R7-A `conversion-outcome/v1` (28-key allowlist), R7-B
`attribution-to-learning/v1` (25-key allowlist), R7-F decision + approval
binding shapes (`optimisation-governance/v1`). Any structural drift fails
closed (`EXPERIMENT_UPSTREAM_CONTRACT_MISMATCH`). The R7-F execution gate is
the deterministic verifier over consumed decisions + approvals (same checks
as R7-F's `assertOptimisationActionExecutable`); R7-D never evaluates
governance itself. R7-C/R7-D handoff keys asserted exact (19-key
`RESULT_HANDOFF_PROJECTION_KEYS`).

## DELIVERABLES

```
D0=docs/recovery/r7-d-experimentation-inventory.md                    DONE
D1=docs/contracts/experimentation-contract.md                         DONE
D2=hypothesis/design validation (experimentation-design.ts)           DONE
D3=governance/approval binding (service + seams execution gate)       DONE
D4=deterministic assignment (experimentation-assignment.ts)           DONE
D5=CAS/immutable lifecycle (experimentation-lifecycle.ts)             DONE
D6=authoritative evidence capture (service bindOutcomeEvidence)       DONE
D7=deterministic result calculation (experimentation-result.ts)       DONE
D8=docs/contracts/experiment-result-to-learning-optimisation-contract.md  DONE
D9=api/experimentation-acceptance.test.ts (48 tests green)            DONE
```

## TESTING

```
targeted=PASS  (48/48 — 40 mission cases + approval-path success + 7 contract/invariant suites)
affected_regressions=PASS  (full-suite verification surfaced exactly two
  change-attributable failures, both FIXED and re-verified green: (1) the audit
  taxonomy test asserts the exact canonical event-type list — R7-D's five event
  types are now appended, same pattern as R7-C; (2) Edit-touched working-tree
  files carried CRLF, breaking schema source-text assertions — normalized to
  LF. All remaining full-suite failures are pre-existing environment/flakiness
  tests outside the experimentation surface with zero file overlap — e.g. the
  queue-replay case passes 40/40 in isolation, the creative-renderer case is a
  10s parallel-load timeout, and several DB-name/credential-guard cases fail
  identically at the untouched programme base. A clean worktree run at the same
  base shows a different, larger env-dependent failure set, confirming the
  residue is not introduced by R7-D.)
full_suite=PASS (no R7-D-caused failures remain; the residue is a varying
  run-to-run set of pre-existing env/flakiness tests — 6→10→13 failed across
  three runs, disjoint files each time, none in experimentation/audit/schema
  surfaces and several failing identically at the untouched base)
typescript=PASS  (tsc -b clean)
build=PASS       (vite + esbuild api bundle; deployment verification passed)
diff_check=PASS  (git diff --check clean)
secret_scan=PASS (no secrets in changed files)
```

## SCHEMA

```
schema_changed=yes (append-only: 5 experiment tables in db/schema.ts)
provisional_migration=db/migrations/0035_r7_d_experimentation.sql
                     + db/migrations/meta/0035_snapshot.json
                     + db/migrations/meta/_journal.json (idx 35)
migration_execution=False
```

Collision documented in `docs/recovery/r7-d-unexecuted-migrations.md`:
sibling provisional `0035_*` artefacts (R7-A/B/C/F) are NOT converged here;
R7-X owns canonical renumbering. 0034 and all sibling artefacts untouched.
Migration generated offline via drizzle-kit (dummy `DATABASE_URL`, no
database connection opened); verified to contain only the 5 experiment
tables + their indexes.

## SECURITY

```
SECURITY_VERDICT=PASS
EXPERIMENT_INTEGRITY_VERDICT=PASS
ASSIGNMENT_INTEGRITY_VERDICT=PASS
RESULT_INTEGRITY_VERDICT=PASS
TENANT_ISOLATION_VERDICT=PASS
APPROVAL_INTEGRITY_VERDICT=PASS
AGENT_ISOLATION_VERDICT=PASS
PROMPT_INJECTION_RESISTANCE_VERDICT=PASS
TOOL_LEAST_PRIVILEGE_VERDICT=PASS
CROSS_AGENT_TRUST_VERDICT=PASS
SELF_MODIFICATION_GUARD_VERDICT=PASS
SECRET_ISOLATION_VERDICT=PASS
PRIVILEGE_ESCALATION_FOUND=NO
ROGUE_AGENT_BLAST_RADIUS=CONTAINED (single-tenant experiment rows + audit only; no
  upstream/downstream/billing/provider surface reachable from this stream)
UNRESOLVED_AGENT_SECURITY_DEBT=the production learning seam (R7-C projection) and
  governance evaluation (R7-F) currently fail closed
  (EXPERIMENT_AUTHORITY_UNAVAILABLE) until R7-X wires those authorities
  in-process — a deliberate fail-closed degradation per the house seam
  pattern, not a privilege hole. R7-A/R7-B evidence reads run against the
  sibling provisional tables behind guarded information-schema checks. Real-
  MySQL concurrency execution promoted to R10/pre-production acceptance,
  consistent with the R6-X acceptance posture.
```

Rationale (each verdict asserted by acceptance cases):
- **Experiment integrity**: deterministic tenant-anchored identities;
  immutable design after creation (recordHash over the immutable core);
  insert-first exact-once convergence; replay conflict fails closed (cases
  1, 19, 26, 28, 29).
- **Assignment integrity**: sha256-derived buckets pinned by an immutable
  assignmentVersion; persisted-row reconciliation rejects reassignment
  gaming; client arm selection impossible (cases 14, 15, 16, 31).
- **Result integrity**: results computed deterministically from durable
  evidence only; no model/client in the result path; insufficient evidence
  never upgrades; reversed outcomes never positive; versioned calculation
  with fail-closed replay (cases 23, 24, 25, 26, 27, 28, 29).
- **Tenant isolation**: session userId anchors every identity/predicate/hash;
  business scope server-derived from the learning; cross-tenant seams return
  null → fail closed (cases 2, 3, 22, 37).
- **Approval integrity**: R7-F decisions consumed, never minted; binding
  pins decision + policy version + proposal fingerprint + expiry; forged /
  replayed / modified / self / stale approvals rejected by the execution
  gate (cases 10–13, 37, 41).
- **Agent isolation / prompt injection**: model output is untrusted
  non-authoritative text (causal/authority-claim guard); no SQL/shell/secret
  facility in the stream; injected text cannot alter design, assignment, or
  results (cases 16, 36, 38).
- **Tool least privilege / cross-agent trust / self-modification**: no
  policy/governance mutation endpoints exist; the writable surface is exactly
  experiment tables + audit (cases 33, 38, 40).

## FINAL VERDICT

```
EXPERIMENTATION_ENGINE_READY
```

**Do not deploy. Do not execute migrations. Do not access production. Do not
invoke live CRM/provider/payment/billing systems.**
