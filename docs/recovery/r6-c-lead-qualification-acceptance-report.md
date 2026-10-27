# R6-C C9 acceptance report — blocker closure

Date: 2026-10-27 (blocker-closure pass). Branch: `feature/r6-c-lead-qualification`.
Prior checkpoint: `f9d1eb2c8f1cf29062089f78f465dd4268a57666`
(C9 acceptance report, verdict `LEAD_QUALIFICATION_AUTONOMY_BLOCKED`).
The 73-case C9 suite and all accepted C9 safeguards were preserved and
extended; C0-C8 were not restarted; no upstream branch was merged; no reset,
clean, stash, rewrite or re-branch occurred.

**FINAL VERDICT: LEAD_QUALIFICATION_AUTONOMY_READY** — the four blocked
defect classes (autonomous self-approval, privacy bypass, tenant crossover,
forced qualification) are closed in product code with adversarial test
evidence. Two integration-assurance items are explicitly deferred to R6-X
with justification (real-MySQL concurrency execution; individual
lid1↔numeric identity convergence) — neither is a product/security defect
under the gating criterion above.

## Blocker dispositions

### 1. HUMAN_REVIEW_AUTHENTICATION=CLOSED

**Defect (previous):** a verified tenant session alone could resolve a
REVIEW_REQUIRED review; server-derived `resolvedBy` was attribution, not
human proof (scenario 23d reproduced it).

**Closure.** Reused the existing governed approval/OTP infrastructure
(`api/lib/auth/otp.ts`) — no new auth system was invented:

- New `api/lib/qualification/qualification-review-authority.ts`: a
  `ReviewChallengeGateway` whose production implementation is the existing
  email-OTP primitive extended with one additive closed purpose,
  `review_authorization` (`HUMAN_PRESENCE_PURPOSES`). Single-use,
  10-minute TTL, 5-attempt bcrypt-verified, server-issued to the tenant
  user's authoritative email.
- New governed procedure `qualification.requestReviewResolution`: runs the
  full resolution preconditions (pending review, decision binding, current +
  unexpired decision, actionable privacy) before issuing a code, then
  CAS-binds the challenge token onto the review row
  (`pendingChallengeToken` / `challengeExpiresAt`, new nullable columns on
  the C-owned provisional `lead_qualification_reviews`; 0034 artefact
  updated, execution still FALSE).
- `resolveReview` now requires the review-bound token plus the emailed code:
  the service asserts the token equals the review's bound token, the gateway
  verifies and durably consumes the challenge, and the verified actor must
  equal the session's tenant user. Fail-closed cases: gateway unconfigured
  (`REVIEW_AUTHORIZATION_REQUIRED`), unbound/fabricated/cross-review token
  (`REVIEW_AUTHORIZATION_BINDING_MISMATCH`, FORBIDDEN), wrong/expired/
  consumed code (UNAUTHORIZED via the OTP primitive), and all pre-existing
  stale-state rejections unchanged.
- Reviewer identity, authorization, action and timestamp are server-derived
  and recorded tx-atomically: `resolvedBy` (challenge-verified tenant user),
  audit metadata `humanReviewProof: "out_of_band_email_challenge"` +
  `reviewAuthorizedAt` (sanitizer-safe keys — the shared audit sanitizer
  strips any key containing "authorization"/"token"; verified by test).

**Adversarial evidence.** Scenario 23d (real router + real OTP gateway +
real bcrypt; the email mock is the mailbox): session-only resolution →
FORBIDDEN with zero writes; the API never returns the code; a guessed code →
UNAUTHORIZED; the emailed code resolves once; replay → CONFLICT.
Scenario 23e: fabricated tokens and cross-review challenge replay fail
closed. Service/contract/router suites: no-authorization, never-issued
token, wrong code, cross-review binding, unauthenticated and client-authority
fields. A compromised agent holding the tenant session has no path to
self-approval: the proof exists only in the reviewer's mailbox, out of band
of every API surface the agent can reach.

**Residual (accepted, documented):** mailbox possession is the independence
boundary. An automation that also controls the tenant's email inbox could
complete the challenge — that is outside every API trust boundary and is the
standard step-up-authentication limit. Challenge requests are tenant-scoped
to the caller's own mailbox and invalidate the caller's prior unconsumed
review codes (existing `consumeActiveChallenges` semantics).

### 2. UPSTREAM_IDENTITY_PRIVACY_BINDING=CLOSED

**Defect (previous):** the provisional bridge could only read privacy by
bare numeric id; for `lid1:` identities it failed closed but no
authoritative binding path existed, and privacy inference from numeric IDs
alone was the structural risk.

**Closure.** Replaced the provisional numeric-ID read with the authoritative
chain, all server-derived from the frozen contracts:

```
R6-A identity (lid1, eq(userId) — exact tenant/business ownership)
  ← validated R6-B score (tenant + business scope assertion)
    → score-authoritative legacy numeric leads.id  (score row, hash-bound)
      → R6-F lead_privacy_states (eq(userId) + leadId, latest row, business
        scope recheck) → governance gate → eligibility
```

- `QualificationAuthorityProvider.getPrivacyState(leadId)` →
  `getPrivacyState(scope: { scoreLeadId, businessId })`. The bridge rejects
  non-numeric keys (incl. every `lid1:` id) with
  `ProviderAuthorityUnavailable`; a privacy row whose business scope
  disagrees with the established chain throws the new
  `ProviderPrivacyScopeMismatch` (mapped to OWNERSHIP_MISMATCH); only the
  score-validated numeric key can reach the table. The old "any numeric
  string" path is gone — numeric keys arrive only inside the re-validated
  score binding, whose `scoreContentHash` is re-verified against the stored
  decision on every projection/review privacy re-check.
- SUPPRESSED / RESTRICTED / RETENTION_EXPIRED / ARCHIVED block
  deterministically (engine + read-time re-checks); `RETENTION_PENDING`
  past `retentionDeadlineAt` now resolves to the RETENTION_EXPIRED gate at
  read time (R6-F §5 "must not silently remain actionable"), and the row
  adapter passes `retentionDeadlineAt`/`updatedAt` through to the gate.
- If any link cannot be established (unknown/absent identity or score,
  score with no numeric key, unavailable table, cross-business row,
  tampered score content), evaluation fails closed —
  never degrades to ACTIVE.

**Adversarial evidence (mission list).** Wrong identity version →
IDENTITY_VERSION_UNKNOWN (scenarios 9-12); cross-business lead →
OWNERSHIP_MISMATCH (7) and cross-business privacy row → OWNERSHIP_MISMATCH
(new 34); privacy record for a different lead never binds (new 31);
stale privacy record superseded / retention deadline passed blocks at read
time (new 32); suppressed (6) and restricted (26) leads block; missing
authoritative privacy evidence — unavailable table (26b) and score carrying
no numeric key (new 33) — fails all three surfaces with zero writes.

**Residual (R6-X convergence, not a defect):** the frozen contracts provide
no individual lid1↔numeric binding (R6-F is numeric-keyed with zero lid
awareness; R6-A stores hashes only; R6-B binds score↔identity at tenant +
business scope by design). The chain therefore binds privacy to the
score-authoritative lead within exact tenant/business scope. No suppression
bypass exists: unestablished bindings fail closed and every durable
projection re-reads the chain. R6-X receives the explicit individual-binding
convergence requirement (below).

### 3. RUNTIME_AGENT_ISOLATION=CLOSED

**Defect (previous):** API tests could not prove runtime AI/model components
cannot invoke review resolution, write decisions, or alter policy/identity/
privacy state.

**Closure — executable structural evidence**
(`api/lib/qualification/qualification-agent-isolation.test.ts`, runs on every
full-suite execution):

- **No runtime model exists in the qualification path.** Forward dependency
  scan: no qualification module (engine, seams, store, service, bridge,
  router) imports any model/agent SDK, shell/process execution, filesystem
  access or network fetch. The engine is pure arithmetic over validated
  evidence (unchanged contract §9).
- **Review authority is not model-reachable.** The human-review gateway's
  only out-of-module dependencies are the governed OTP primitive,
  `@db/schema`, the db connection and `@trpc/server` — asserted by test.
  The deterministic engine/evidence/policy files never reference the
  gateway; autonomous evaluation never consults it.
- **No agent→qualification code path.** Reverse dependency scan: zero
  imports of qualification code from `api/lib/agents/**`, `agent-router`,
  engagement, intelligence, creative, social-listening and learning modules.
  A compromised in-process agent component has no code path to
  qualification server functions; combined with the strict input surfaces
  (scenarios 20-22) and the out-of-band review channel, it cannot resolve
  reviews, write decisions, alter policy/scores/identity/privacy, execute
  tools, or mint downstream handoff authority.
- **Closed surface.** Exactly eight procedures; no force-state, policy
  mutation, tool or agent endpoint (scenarios 22b/23b).

### 4. REAL_MYSQL_CONCURRENCY=DEFERRED_TO_R6_X_WITH_JUSTIFICATION

**Disposition.** No safe real-MySQL authority exists in this environment:
no Docker, no local mysqld, no testcontainers/TEST_DATABASE infrastructure
in the repo, and the configured DATABASE_URL must not be touched
(production-access prohibition). Executing against an unauthorized database
would fabricate assurance, so it was not attempted.

**Justification (per the mission's own acceptance rule).**

- DB constraints/CAS are structurally correct and now pinned by executable
  schema tests (`db/__tests__/lead-qualification-schema.test.ts`): unique
  `(userId, qualificationId)`, unique `(userId, reviewId)` and
  `(userId, qualificationId)` + CAS `version`, unique challenge token,
  0034 artefact parity.
- Deterministic concurrency tests pass unchanged: duplicate convergence
  (16a), concurrent same-evidence evaluation (16a), simulated errno-1062
  loser convergence (16b), conflicting replay (17), concurrent/stale review
  resolution races (CAS version guards; store suite), immutable historical
  decisions (18, 30), zero-writes-on-rejection (24/25/25b/25c/26b/31-35).
  Review CAS semantics extended: `updateReviewChallengeRequest` +
  `updateReviewResolution` both fail closed on version drift (store suite).
- No unresolved code defect exists.

**Explicit R6-X acceptance requirement:** spin up a disposable MySQL,
execute the provisional 0034 migration, and re-run: duplicate-qualification
convergence, concurrent same-evidence evaluation, conflicting replay,
concurrent review resolution + challenge binding races, and audit
transaction atomicity under simultaneous physical connections, asserting
MySQL isolation/rollback behavior matches the in-memory executors.

## Final test and verification results

| Check | Result |
| --- | --- |
| C9 acceptance (`api/r6-c-acceptance.test.ts`) | 79 passed, 0 failed (73 preserved + 6 new scenario groups: 23d rewritten, 23e, 31, 32, 33, 34, 35) |
| Qualification module + router + otp + schema tests (offline config) | 337 passed, 0 failed; 19 files |
| Affected security/policy/governance/opportunity/audit/auth/agent regressions (offline config) | 160 passed, 0 failed; 9 files |
| Full offline suite (offline config, dot reporter) | 5,936 passed, 0 failed, 66 skipped, 14 todo; 6,016 total — 378 files passed, 1 file skipped |
| `npm run build` | PASS (client + API + worker bundles, rewrite-rule checks, local files only; smoke URL unset) |
| `git diff --check` | PASS |

The full offline suite ran under `DOTENV_CONFIG_PATH=NUL` with
`scripts/r6-c-offline-vitest.config.ts` (each worker blocks network access
and strips inherited credentials). The 66 skipped and 14 todo tests are not
claimed as passes; real DB integration remains deliberately unexecuted
(blocker 4 disposition).

Reproduction (Git Bash):

```bash
export PATH="/c/Users/27768/.tools/node:$PATH"
DOTENV_CONFIG_PATH=NUL npx vitest run --config scripts/r6-c-offline-vitest.config.ts api/r6-c-acceptance.test.ts api/lib/qualification api/qualification-router.test.ts api/lib/auth/otp.test.ts db/__tests__
DOTENV_CONFIG_PATH=NUL npx vitest run --config scripts/r6-c-offline-vitest.config.ts api/r5-x-security-acceptance.test.ts api/policy-acceptance.test.ts api/governance-acceptance.test.ts api/lib/opportunity/r5-d-acceptance.test.ts api/lib/audit api/local-auth-router.test.ts api/agent-router.test.ts api/lib/agents/engagement-agent.test.ts
npx tsc -b
unset NATFORGE_SMOKE_URL && npm run build
git diff --check
```

No live-provider, CRM, payment, billing or production-DB calls anywhere in
the suite (email is mocked at the module boundary; the OTP/bcrypt paths run
for real).

## Security fields

```text
SECURITY_VERDICT=READY_CODE_STRUCTURE_HOST_RUNTIME_NOT_INSPECTED
QUALIFICATION_INTEGRITY_VERDICT=PASS_DETERMINISTIC_IMMUTABLE_REPLAY_VERIFIED
TENANT_ISOLATION_VERDICT=PASS_TESTED_ROUTER_SERVICE_AND_BRIDGE_SCOPE
PRIVACY_GOVERNANCE_VERDICT=PASS_CHAIN_BOUND_FAIL_CLOSED
AGENT_ISOLATION_VERDICT=PASS_ZERO_MODEL_DEPENDENCY_NO_AGENT_CODE_PATH
PROMPT_INJECTION_RESISTANCE_VERDICT=PASS_STRUCTURED_INPUT_BOUNDARY
TOOL_LEAST_PRIVILEGE_VERDICT=PASS_NO_CALLER_TOOL_SHELL_SQL_OR_PROVIDER_EXEC
CROSS_AGENT_TRUST_VERDICT=PASS_NO_AGENT_TO_QUALIFICATION_IMPORT_REVERSE_SCANNED
SELF_MODIFICATION_GUARD_VERDICT=PASS_CODE_STRUCTURE_CLOSED_SURFACE_NO_RUNTIME_MUTATION_ENDPOINT
SECRET_ISOLATION_VERDICT=NOT_VERIFIED_RUNTIME_HOST_PRODUCTION_INSPECTION_FORBIDDEN_NO_SECRETS_IN_OUTPUTS
SENSITIVE_DATA_EXPOSURE_FOUND=FALSE_IN_SCOPED_OUTPUTS_AND_AUDIT
AUTHORIZATION_REGRESSION_FOUND=FALSE_IN_AFFECTED_TESTS
PRIVILEGE_ESCALATION_FOUND=FALSE_SESSION_ONLY_REVIEW_SELF_APPROVAL_CLOSED
ROGUE_AGENT_BLAST_RADIUS=NONE_WITHIN_API_AND_CODE_BOUNDARIES_AGENT_CANNOT_SELF_APPROVE_RESOLVE_WRITE_DECISIONS_ALTER_GOVERNED_STATE_EXECUTE_TOOLS_OR_MINT_HANDOFF_AUTHORITY_HOST_CREDENTIAL_BOUNDARIES_UNINSPECTED
NEW_SECURITY_DEBT=REVIEW_AUTHORIZATION_REQUEST_NOT_RATE_LIMITED_BEYOND_SINGLE_ACTIVE_CODE_TENANT_SELF_SCOPE_ACCEPTED
UNRESOLVED_AGENT_SECURITY_DEBT=HOST_RUNTIME_CREDENTIAL_TOOL_AND_PROCESS_BOUNDARY_VERIFICATION_R6X_DEPLOYMENT_READINESS_REAL_MYSQL_CONCURRENCY_EXECUTION_R6X_INDIVIDUAL_LID_NUMERIC_BINDING_CONVERGENCE_R6X
```

## Schema and execution boundaries

`0034_lead_qualification_autonomy.sql` gained the two nullable review
challenge columns (provisional artefact, updated in place). Migration
execution remains FALSE; R6-X owns canonical sequencing and collision
resolution. No A/B/F merge; no programme-wide migration renumbering.

```text
migration execution = FALSE
deployment = FALSE
production access = FALSE
live providers / CRM / payment / billing systems invoked = FALSE
```

## R6-X explicit handoff requirements

1. Real-MySQL concurrency acceptance (cases enumerated in blocker 4).
2. Authoritative individual lid1↔numeric binding; at convergence, replace
   the bridge's guarded mirror tables with canonical `@db/schema` imports
   and re-verify the privacy chain end to end.
3. Host/runtime deployment verification: process boundaries, tool grants,
   runtime credential isolation, repository ACLs (forbidden to inspect from
   this task's scope).
4. Optional hardening backlog: per-endpoint rate limit on
   `requestReviewResolution`; purpose-scoped review codes per reviewId
   instead of per-user single-active-code semantics.
