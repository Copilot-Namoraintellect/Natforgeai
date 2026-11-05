# R10-B — Execution Exactly-Once / Effectively-Once Semantics (B5) + Database Security Boundary (B7)

> **Stream:** R10-B Data Integrity, Real MySQL & Concurrency (`feature/r10-b-data-concurrency`)
> **Programme base:** `799f6b4cb351ebe969f97da606324605fdf2a07b`
> **Date:** 2026-11-11
> **Companion docs:** `docs/recovery/r10-b-data-concurrency-inventory.md` (B0/B1),
> acceptance report (B2–B9 verdicts).

---

## B5 — Exact-once / effectively-once: precise semantics

NatForgeAI Mission Control does **not** claim distributed exactly-once
semantics. The honest decomposition, per boundary:

### 1. Exactly-once durable intent creation — **YES (structural)**

Every authority row is created at most once, under all concurrency, by
construction:

- deterministic, content-addressed identity (`mis1:` `pln1:` `sch1:` `exa1:`
  `idem1:` `exr1:` `mst1:` `tst1:` `rcn1:` `mgd1:` `misl1:` `exl1:` …);
- a durable **unique index** per anchor (tabulated in the inventory §4);
- insert-first write idiom: on `ER_DUP_ENTRY` (1062) the store re-reads the
  committed row and converges (`idempotent_replay`) or fails closed
  (`*_REPLAY_CONFLICT`) — never merges, never double-writes;
- no client can supply an identity or idempotency key (server-minted;
  `z.strictObject` rejects authority fields at the boundary).

Harness proof: structural s1–s3, s6, s9–s11, s20, s20b; real-MySQL r1–r3, r5,
r9–r11, r16–r18, r20 (when executed).

### 2. Idempotent request identity — **YES**

`idem1:` keys are server-derived (sha256 over tenant + action identity);
retries and redeliveries carrying the same logical request converge to the
same durable row. A forged collision with *different* material fails closed
(`EXECUTION_REPLAY_CONFLICT`). Duplicate queue delivery (BullMQ at-least-once)
collapses at the same anchors.

### 3. Effectively-once provider action — **CONDITIONAL — adapter responsibility**

The dispatch boundary is **not** effectively-once by itself under a genuine
duplicate-dispatch race: two concurrent `dispatchExecutionAction` workers can
both pass the version CAS (Finding CAS-1: the loser observes the convergent
row and continues) and both invoke the adapter. The **durable** outcome is
exactly-once (one `exr1:` attempt, one `DISPATCHED` transition, one terminal
result via the null→value CAS); the **provider invocation** may repeat.

Mitigations and residual responsibility:

- every attempt carries a deterministic server-issued `ext1:` external
  reference; adapters MUST treat it as the provider idempotency key where the
  provider supports one (contract for the R10-X live-adapter hardening);
- in practice the job layer serialises per-item work (BullMQ job ids derived
  from durable row ids), so duplicate dispatch of the same action requires
  concurrent user/API-driven dispatch of the identical action — a narrow
  window;
- result binding is single-winner regardless: the second invocation's result
  cannot overwrite the first (null→value CAS + re-read verify).

Honest verdict: **exactly-once durable intent + idempotent identity +
at-most-once recorded result; provider-side effect is effectively-once only
when the adapter honours `ext1:`** (sandbox adapters are fakes; live adapters
are R10-X scope with `LIVE_EXECUTION=False` today).

### 4. Uncertain provider outcome — **FIRST-CLASS, never success**

Timeout, connection loss, malformed or ambiguous callbacks classify as
`UNCERTAIN` / `FAILED_RETRYABLE` / `PENDING_EXTERNAL` — never `SUCCEEDED`
(D7 mapping). `dispatch != success`; `uncertainty != success`. A conflicting
late callback cannot overwrite a recorded terminal result (structural s8;
real-MySQL r7/r8). Crash-after-commit-before-ack leaves conservative state
(structural s16: action stays `DISPATCHED`, never falsely `SUCCEEDED`).

### Summary table

| Boundary | Semantics | Mechanism | Evidence |
|---|---|---|---|
| Durable intent creation | exactly-once | deterministic id + unique anchor + insert-first | s1–s3/s6/s9–s11/s20 |
| Request identity | idempotent | server-minted `idem1:`/`mgov1:` | s20/s20b, r20 |
| Attempt recording | exactly-once | `exr_user_action_attempt_uidx` + deterministic `exr1:` | s5, r5/r6 |
| Result recording | at-most-once, first-writer-wins | null→value CAS + re-read verify | s7/s8, r7/r8 |
| Provider invocation | effectively-once **iff adapter honours `ext1:`** | external reference binding | s5 (dispatch count), B5 note |
| Queue delivery | at-least-once | BullMQ + deterministic job ids + anchors | r16/r17, inventory §7 |
| Approval consumption | read-only gate, any-concurrency-safe | `assertMissionActionConsumable` (pure) | s4, r4 |
| Recovery/retry authority | advisory, exact-once durable proposal | `rcn1:` + `mrc_user_recovery_uidx` + fresh R9-F gate per execution | s9/s10, r9–r11 |

---

## B7 — Database security boundary

Verified against the frozen base (evidence anchors inline).

| # | Requirement | Verdict | Evidence |
|---|---|---|---|
| 1 | Tenant/business filters on every authority read | **PASS** | Every store query is `userId`-predicated (`execution-coordination-store.ts`, `mission-*-store.ts` passim); business scope re-verified at every consumption gate (`mission-approval.ts:320-355`); structural s18/s19 |
| 2 | No arbitrary SQL from model output | **PASS** | All queries are Drizzle-compiled from code; the only raw-SQL surfaces are server-owned seams (`execution-upstream-seams.ts`, `execution-governance-seam.ts`, `mission-*-seams`) executing fixed templates with bound parameters — model output never reaches SQL text; routers validate with `z.strictObject` |
| 3 | No database credentials exposed to agents | **PASS** | `DATABASE_URL` lives only in `api/lib/env.ts` → `getDb()` singleton; adapters receive secret-scrubbed payloads (`execution-coordination-service.ts:853-868`); R9-D security suite asserts no secret material in payloads/timeline |
| 4 | No unrestricted DB-admin path | **PASS** | No router exposes raw SQL/admin execution; `db:push/migrate/generate` are operator npm scripts only; no API route imports drizzle-kit or spawns SQL against client input |
| 5 | Parameterized queries | **PASS** | Drizzle parameter binding throughout (`eq()`/`inArray()` bind values, never interpolate); the rehearsal script uses bound `?` params; raw seams use sql`` templates with `${}` binding |
| 6 | Schema mutation not reachable through autonomous runtime | **PASS** | Routers never issue DDL; `db.transaction()` callers mutate rows only; no `CREATE/ALTER/DROP` outside `db/migrations` + rehearsal script |
| 7 | Migration authority separate from agent authority | **PASS** | Migrations = operator-run drizzle-kit + R10-B rehearsal script with fail-closed localhost+`r10b_rehearsal_` guards; agents hold tenant JWTs only (R9-F: tenant JWT alone cannot resolve reviews — OTP in mailbox) |
| 8 | Transaction manipulation resistance | **PASS (structural)** | Authority stores use single autocommit statements (no client-controlled tx boundaries); `withTerminalReplayTransaction` is server-owned; fault-injection sweep s13–s15 proves crash/disconnect/deadlock never produce partial claims |

### Rogue-agent scenario results (SECURITY section)

| Attack | Result |
|---|---|
| Raw SQL injection via any router input | Fails closed — `z.strictObject` + Drizzle binding; no SQL text path |
| Transaction manipulation (client-supplied tx/rollback) | No such surface; tx boundaries are server-owned |
| Idempotency collision | Converges only on identical material; conflict otherwise (s20/r20) |
| Tenant collision | Tenant-predicated anchors + global `mgd` anchor + gate ownership checks (s18/r18) |
| Approval-consumption race | Read-only gate; unanimous verdicts; rejection permanently blocks (s4/r4) |
| Forced success | Impossible: result CAS first-writer-wins; UNCERTAIN never promoted; no client authority field accepted |
| History rewrite | Rows immutable (hash-drift = tamper); corrections are new superseding rows |
| Migration execution / schema mutation | No runtime path; rehearsal script hard-guards localhost + `r10b_rehearsal_` prefix |
| Credential extraction | Credentials never enter payloads, projections, timeline, or error messages (R9-D/E security suites + structural s16 assertions) |

All fail closed. **DB_SECURITY_VERDICT = PASS (structural); real-MySQL
re-confirmation remains env-blocked (B2).**
