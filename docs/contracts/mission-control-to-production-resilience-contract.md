# MISSION CONTROL → PRODUCTION RESILIENCE CONTRACT (R9-X → R10)

> **Producer:** R9-X Mission Control Integration (`integration/r9-mission-control`)
> **Consumer:** R10 Production Resilience & Pre-Production Acceptance
> **Status:** forward handoff contract — lists everything R9-X deliberately
> deferred and that R10 MUST execute before any live/production use of
> Mission Control. R9-X ships with `LIVE_EXECUTION=False`, sandbox adapters
> only, and the canonical migration `0037_r9_mission_control_foundation`
> **NOT executed**.
> **Blocking:** nothing in R9-X may reach production until the R10 items in
> §2 are complete and signed off.

---

## 1. What R9-X guarantees today (pre-production)

R9-X proves, on deterministic in-memory fakes over the REAL integrated
routers/services:

- the connected governance chain (R8 → R9-A → B → C → F → D → E and back);
- exact-once identity/replay convergence for every authority (missions,
  plans, tasks, schedules, decisions, approvals, execution actions/attempts,
  recovery candidates, state/timeline facts);
- tenant/business isolation across the whole chain;
- R9-F as the single governance authority (no local ALLOW, no bypass, no
  self-approval; OTP-bound independent human approval);
- closed capability/adapter selection (unknown/UNSUPPORTED capability fails
  closed);
- result integrity (no inferred success; uncertainty explicit; retry/recovery
  never widens scope);
- immutability + exactly-one audit event per durable effect;
- secret/PII minimization (fingerprints only, never raw payloads);
- `tsc -b` clean, offline build + deployment-verification green, full offline
  test suite green, `git diff --check` clean, secret scan clean.

## 2. What R10 MUST execute (the handoff)

**REAL_MYSQL_CONCURRENCY_EXECUTED=False** on the R9-X integration host — no
safe disposable real-MySQL environment exists here. This is the same
programme convention carried by R6-X/R7-X/R8-X; it does not block R9-X because
structural concurrency (identity anchors, CAS-guarded lifecycle, unique-index
convergence) is proven deterministically and the canonical migration is
statically validated. R10 must:

1. **Real DB concurrency.** Stand up a disposable real MySQL 8 and run the
   full R9 suite plus dedicated concurrent-writer tests: duplicate-insert
   convergence on every unique anchor (`ER_DUP_ENTRY` → `idempotent_replay`),
   CAS lost-update rejection, concurrent dispatch (single winner), concurrent
   approval resolution, and supersession races under real transactions.
2. **OneGrid setup.** Provision the production-equivalent OneGrid host,
   runtime, reverse proxy and process supervision exactly as other NatForge
   services run.
3. **Production deployment.** Execute the canonical migration
   `0037_r9_mission_control_foundation` (currently artefact-only, NOT
   executed) via the governed migration path; verify `db/schema.ts` ↔ 0037
   semantic match post-migration; only then enable the R9 routers.
4. **Secrets.** Move all secrets to the production secret store; confirm no
   secret material in any R9 projection/receipt (X8 S15 proves minimization);
   rotate any credential that ever touched a non-prod store.
5. **Monitoring.** Wire structured logs, metrics and alerts for: mission
   health transitions, governance decisions/approvals, dispatch outcomes,
   `UNCERTAIN`/`FAILED_FINAL` rates, recovery-candidate lifecycle, audit
   event emission, and seam availability (fail-closed posture).
6. **Worker resilience.** Run the background worker under supervision;
   prove crash/restart recovery: in-flight attempts re-derive to
   `UNCERTAIN`/`FAILED_RETRYABLE`, idempotent retries converge, and no
   duplicate side effects occur across restarts.
7. **Provider resilience.** For each live adapter (CAMPAIGN/CONTENT/SOCIAL/
   CRM/NOTIFICATION/ANALYTICS), prove timeout/ambiguous/connection-loss
   classification never yields success and emits correct retry candidates.
8. **Circuit breakers.** Add per-adapter circuit breakers; prove open-circuit
   degrades dispatch to governed failure (never silent success) and recovery
   is observable.
9. **Backup.** Automated scheduled backups of the production database
   covering all R9 tables.
10. **Offsite / immutable backup.** Replicate backups offsite with an
    immutable (write-once) copy; verify retention.
11. **Restore rehearsal.** Perform a full restore from backup into a clean
    environment and verify mission/state/recovery authority re-derives
    correctly from restored history.
12. **RPO / RTO.** Define and test Recovery Point Objective and Recovery
    Time Objective for Mission Control; demonstrate them in a live drill.
13. **Production security.** Pen-test the production surface: auth, tenant
    isolation, approval flow (OTP), the execution boundary, and the adapter
    registry; confirm no live endpoint exceeds the R9-X authority model.
14. **Kill switches.** Operator-accessible switches to (a) drop Mission
    Control to Decision-Support posture (autonomy Level 1), (b) halt all
    dispatch, and (c) disable individual adapters — each independently and
    audit-logged.
15. **Controlled autonomy activation.** Only after 1–14 pass: enable live
    adapters progressively per the autonomy-boundary contract
    (`mission-control-autonomy-boundary-contract.md`), starting at Level 2
    posture, with human checkpoints at every R9-F `REVIEW_REQUIRED`, and
    never exceeding the §2 universal invariants.

## 3. Non-negotiable carry-overs

- `candidate != mission`; `recommendation != execution authorization`;
  `plan/schedule != execution authorization`; `dispatch != success`;
  `uncertainty != success`; `retry != new authority`;
  `recovery proposal != recovery authorization`.
- R9-F remains the single governance authority; no second engine is
  introduced at any autonomy level.
- The closed capability/adapter registry stays closed; live adapters are
  added only behind R9-F governance and circuit breakers.
- `LIVE_EXECUTION` is enabled only via R10 §2.15, never by default.
