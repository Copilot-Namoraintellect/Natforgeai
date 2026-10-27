# R6-C C9 acceptance report

Date: 2026-10-27. Branch: `feature/r6-c-lead-qualification`.
Starting checkpoint: `58518e67f126716d27c58e9af0bcf96e4e5ded7e`
(`wip(r6-c): preserve C9 acceptance work at quota interruption`).
C0-C8 were preserved; no upstream branches were merged.

**LEAD_QUALIFICATION_AUTONOMY_BLOCKED**

The C9 executable suite is complete, but programme/security acceptance is
**EXECUTED_NOT_ACCEPTED**. Passing tests below do not constitute independent
human authentication, deployed agent isolation, or live upstream integration.
Only the tested C9 fixes, offline verification harness and this blocked report
are accepted for commit. The final delivery response records the post-push
HEAD, remote comparison and clean status; a report cannot embed its own Git hash.

## Accepted C9 changes

- Completed scenarios 19-22 and 26-30 and the connected C-seam fixture trace.
  Added adversarial field matrices, tenant read/review checks, delayed retries,
  expanded replay tampering checks, and expired/suppressed/unavailable reviews.
- Only `QUALIFIED` may project `mayProgress: true`, when current, fresh and
  privacy-actionable. Review authorization never replaces qualification.
  `REVIEW_REQUIRED` remains blocked even after `progress_authorized`; corrected
  evidence must produce a new deterministic `QUALIFIED` decision.
- Reject superseded and expired review decisions and non-actionable privacy
  before CAS resolution or audit writes.
- Remove wall-clock assembly metadata from evidence identity. Later retries
  converge without renewing validity. Replays check stored snapshot content,
  reviewRequired, original timestamp consistency and validity duration.
- Fail closed when privacy schema or the `lid1:` to legacy numeric privacy
  mapping is unavailable. The former TypeScript cast could not establish a
  real mapping and could misinterpret suppression as an absent row.
- Add an opt-in offline Vitest configuration. Each worker blocks TCP/TLS/UDP
  connections and real fetch, suppresses dotenv loading, removes inherited
  credential variables, and supplies inert Firebase/database configuration.
  DB integration guards deliberately skip real database cases. Test mocks
  still exercise provider/CRM/billing code without invoking those systems.

## C9 case coverage

Source: `api/r6-c-acceptance.test.ts`. Scenario variants expand into separate
Vitest cases; 15 protected categories, 4 upstream authority fields and 11
client authority fields are tested individually.

| Scenario | Evidence / result |
| --- | --- |
| 1 | Valid governed evidence -> QUALIFIED; eligible D projection, no execution |
| 2 | VERY_HIGH score with no fit/intent -> INSUFFICIENT_EVIDENCE |
| 3 | Missing business-fit evidence -> INSUFFICIENT_EVIDENCE |
| 4 | Contradicting evidence -> REVIEW_REQUIRED and one bound pending review |
| 5 | Explicit disqualifier -> NOT_QUALIFIED |
| 6 | Privacy suppression -> BLOCKED and blocked projection |
| 7 | Cross-business assertion rejected |
| 8 | Forged and cross-tenant lead references rejected indistinguishably |
| 9-12 | Stale identity, stale score, tampered score, unknown scoring version rejected |
| 13-14 | Unknown policy rejected; new policy binds new immutable history |
| 15, 15b | Same-clock and delayed replay converge; no renewed expiry or extra audit |
| 16a-b | Fake concurrent duplicates and simulated errno-1062 loser converge |
| 17, 17b | Conflicting decision, review flag, validity or snapshot replay fails closed |
| 18 | Historical decisions unchanged; no qualification update export |
| 19 | Protected traits rejected at evidence, identity and score boundaries |
| 20 | Injected provenance cannot override disqualification; executable tool fields rejected; raw text not persisted |
| 21 | Upstream qualified/decision/mayProgress/reviewOutcome claims rejected |
| 22, 22b | Client final outcome, score, policy, privacy, actor and tools rejected; closed router endpoint set |
| 23, 23b | Fabricated/unknown reviews cannot approve; client/model actor claims and unauthenticated approval rejected |
| 23c | Cross-tenant score, decision, history and review access rejected |
| 23d | **Blocker reproduced:** verified tenant session can resolve review without independent human proof; still cannot progress REVIEW_REQUIRED |
| 24-25c | Superseded, drifted, expired and suppressed review resolutions rejected without writes |
| 26, 26b | Current suppression/restriction/retention blocks prior QUALIFIED; unavailable privacy authority blocks evaluate/projection/review |
| 27-28 | NOT_QUALIFIED and REVIEW_REQUIRED cannot progress, including authorized review |
| 29 | Closed reference-only D projection; no PII, secrets, raw text, tools or hidden chain of thought |
| 30 | Evaluation/replay/review/projection write only C decision/review tables and audit |
| H | Real C seam/engine/store/service fixture trace agrees end to end; not a live A/B/F integration test |

## Final test and verification results

| Check | Result |
| --- | --- |
| C9 acceptance file | 73 passed, 0 failed, 0 skipped |
| Targeted qualification, including C9 | 274 passed, 0 failed; 14 files passed |
| Affected security/policy/governance/opportunity/audit/auth/agent regressions | 160 passed, 0 failed; 9 files passed |
| Full offline suite | 5,898 passed, 0 failed, 66 skipped, 14 todo; 5,978 total |
| Full suite files | 375 passed, 0 failed, 1 skipped; 376 total |
| `npm run check` (`tsc -b`) | PASS, exit 0 |
| `npm run build` | PASS, exit 0; client + API + worker bundles and local rewrite-rule checks |
| `git diff --check` | PASS |

Reproduction commands (Windows PowerShell; no dependency installation):

```powershell
$env:DOTENV_CONFIG_PATH = 'NUL'
npm test -- --config scripts/r6-c-offline-vitest.config.ts api/r6-c-acceptance.test.ts api/lib/qualification api/qualification-router.test.ts
npm test -- --config scripts/r6-c-offline-vitest.config.ts --reporter=dot
npm run check
Remove-Item Env:NATFORGE_SMOKE_URL -ErrorAction SilentlyContinue
npm run build
git diff --check
```

The separately selected affected regression run covered:
`api/r5-x-security-acceptance.test.ts`, `api/policy-acceptance.test.ts`,
`api/governance-acceptance.test.ts`, `api/lib/opportunity/r5-d-acceptance.test.ts`,
`api/lib/audit`, `api/local-auth-router.test.ts`, `api/agent-router.test.ts`,
and `api/lib/agents/engagement-agent.test.ts`. All are also in the final full run.

An initial scrubbed-environment full run had 5,891 passes, three failed tests
and one failed suite: two database-name configuration assertions, missing inert
Firebase API-key configuration, and an R4 dynamic-import hook exceeding 10s.
The opt-in offline config supplies inert values and a 30s hook timeout; all
four files passed on focused rerun (59 passed, 48 skipped), followed by the
successful complete rerun above. No product fixes outside R6-C were made.

The 66 skipped and 14 todo tests are not claimed as passes; real DB integration
remains deliberately unexecuted. The build emitted environment warnings:
Node 20.13.1 is below Vite's advertised 20.19+/22.12+ requirement, Browserslist
data is old, `.env` NODE_ENV guidance, and large client chunks. No packages,
runtime versions or environment files were changed. Build verification checked
local files only: the HTTP smoke URL was unset and no deployment occurred.

## Security boundary and outstanding blockers

1. **Human review authentication.** `qualification.resolveReview` uses ordinary
   `authedQuery`: verified session and tenant ownership. There is no separate
   human-presence assertion, approval challenge, agent principal restriction or
   credential separation. Scenario 23d proves that a caller holding that session
   can record `progress_authorized`. Server-derived `resolvedBy` is attribution,
   not proof of a human. Restricting projection to QUALIFIED closes the former
   downstream review bypass, but does not satisfy the prohibition on agent
   self-approval. READY is forbidden until independent human authority exists.
2. **Upstream ID reconciliation.** R6-B scores and R6-F privacy use legacy
   numeric CRM lead IDs; A uses `lid1:` identities. Score binding currently
   establishes tenant/business scope, not exact individual identity. The privacy
   path now rejects unmapped identities instead of guessing ACTIVE. R6-X must
   supply an authoritative individual binding before runtime acceptance. No
   mapping, upstream schema, policy, score, or migration was fabricated here.
3. **Deployment isolation evidence.** API tests prove no caller-controlled
   command/tool endpoint and strict input rejection. They cannot prove the host
   denies agents shell/filesystem/database credentials, blocks code/policy
   modification, isolates secrets, or prevents one compromised in-process
   component from invoking another component's server functions. Runtime
   credentials, tool grants, process boundaries and repository ACLs must be
   independently verified. No production or secret inspection was performed.
4. **Database verification limit.** Exactly-once and CAS tests use in-memory
   executors, including simulated duplicate errors. They do not prove MySQL
   transaction isolation, rollback, simultaneous physical connections or deployed
   audit atomicity. Those checks require a separately authorized disposable DB;
   no migration execution or database access was performed for this task.

```text
SECURITY_VERDICT=BLOCKED
QUALIFICATION_INTEGRITY_VERDICT=PASS_C_TESTS_BLOCKED_UPSTREAM_INDIVIDUAL_BINDING
TENANT_ISOLATION_VERDICT=PASS_TESTED_ROUTER_SERVICE_AND_BRIDGE_SCOPE
PRIVACY_GOVERNANCE_VERDICT=FAIL_CLOSED_BLOCKED_UNRESOLVED_ID_MAPPING
AGENT_ISOLATION_VERDICT=BLOCKED_SHARED_SESSION_HUMAN_AUTHORITY_GAP
PROMPT_INJECTION_RESISTANCE_VERDICT=PASS_STRUCTURED_INPUT_BOUNDARY
TOOL_LEAST_PRIVILEGE_VERDICT=PASS_C_API_SURFACE_RUNTIME_NOT_VERIFIED
CROSS_AGENT_TRUST_VERDICT=BLOCKED_RUNTIME_AND_UPSTREAM_BINDING_NOT_VERIFIED
SELF_MODIFICATION_GUARD_VERDICT=NOT_VERIFIED_RUNTIME
SECRET_ISOLATION_VERDICT=NOT_VERIFIED_RUNTIME
SENSITIVE_DATA_EXPOSURE_FOUND=FALSE_IN_SCOPED_OUTPUTS
AUTHORIZATION_REGRESSION_FOUND=FALSE_IN_AFFECTED_TESTS
PRIVILEGE_ESCALATION_FOUND=SHARED_SESSION_REVIEW_SELF_APPROVAL_POSSIBLE_NO_TENANT_ROLE_ESCALATION_OBSERVED
ROGUE_AGENT_BLAST_RADIUS=TENANT_SESSION_CAN_EVALUATE_AND_RESOLVE_OWN_REVIEWS_NO_C_OUTREACH_CRM_CONVERSION_OR_REVIEW_TO_D_BYPASS
NEW_SECURITY_DEBT=NONE_INTRODUCED_KNOWN_BLOCKERS_RETAINED
UNRESOLVED_AGENT_SECURITY_DEBT=HUMAN_APPROVAL_AUTHENTICATION_UPSTREAM_BINDING_RUNTIME_TOOL_SECRET_AND_CODE_ISOLATION
```

## Schema and execution boundaries

`0034_lead_qualification_autonomy.sql`, snapshot and journal entry remain
provisional, unchanged and unexecuted. R6-X owns collision resolution,
canonical sequencing and upstream integration. See
`docs/recovery/r6-c-unexecuted-migrations.md`.

```text
migration execution = FALSE
deployment = FALSE
production access = FALSE
live providers / CRM / payment / billing systems invoked = FALSE
```

No reset, clean, stash, branch switch, history rewrite, upstream merge or
dependency installation was performed. No CRM/outreach/conversion mutations,
force-state endpoint, protected-trait decision rule, model authority or hidden
chain-of-thought persistence was introduced.
