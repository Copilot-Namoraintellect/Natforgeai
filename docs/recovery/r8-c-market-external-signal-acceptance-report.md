# R8-C Market & External Signal Intelligence — Acceptance Report

> **Stream:** R8-C Market & External Signal Intelligence
> **Date:** 2026-11-12
> **Verdict:** see FINAL VERDICT below.

---

## IDENTITY

```
branch=feature/r8-c-market-external-signals
HEAD=66593da
remote=origin (https://github.com/Copilot-Namoraintellect/Natforgeai.git)
working_tree=clean
```

## UPSTREAM

```
r8_a_head=23d0f22   (consumed by contract only — strategic-memory contracts read
                     for business-context/relevance semantics; no code merged)
r8_f_head=44118e3   (consumed by contract only — trust vocabulary §5 consumed
                     exactly via EXTERNAL_MARKET_FROZEN_TRUST_VOCABULARY;
                     no governance authority created or merged)
contract_compatibility=PASS — R8-C source-trust classes are the exact R8-F
                     closed vocabulary (asserted in acceptance); R8-C reads
                     R8-A only through its frozen read-only projection contract
                     at integration (v1: verified business row inputs only);
                     downstream contract (C8) mandates R8-F revalidation before
                     any governed recommendation.
```

## Deliverables

```
C0=PASS  docs/recovery/r8-c-market-external-signal-inventory.md — providers,
         R5 boundary, reusable primitives, gaps (greenfield build list).
C1=PASS  docs/contracts/market-external-signal-contract.md — record shape,
         closed vocabularies, identity formulas, trust derivation, freshness
         policy, relevance, lifecycle, client boundary, security, audit, schema.
C2=PASS  Deterministic src1:/xsig1: identities over normalized coordinates;
         safe normalized source references; exact-once natural anchors
         (userId,originKey) + (userId,sourceId,eventKey); malformed/spoofed
         sources rejected; no client/model-controlled trust.
C3=PASS  Inert-content isolation (INERT_EVIDENCE), NFC normalization, malformed
         unicode rejection, deterministic injection-pattern annotation;
         model assistance strictly candidate-only, excluded from identity/hash.
C4=PASS  Server-side registry (code-level official allow-list + verified
         catalog), exact R8-F trust vocabulary, confidence ceilings,
         independence-enforced corroboration (origin AND eventKey distinct).
C5=PASS  Per-signal-type freshness thresholds (code-level), CURRENT/AGING/
         STALE/EXPIRED derived identically at read; expired excluded from the
         active projection; ±5 min skew bounds.
C6=PASS  Deterministic term-overlap relevance with exact matched-term evidence;
         model proposals bounded by the deterministic ceiling; protected-trait
         tokens excluded from relevance inference.
C7=PASS  OBSERVED/CORROBORATED/CONTRADICTED/SUPERSEDED/STALE/INVALIDATED;
         append-only xsf1: facts; contradictions visible both ways;
         supersession preserves history.
C8=PASS  docs/contracts/external-signal-to-strategic-reasoning-contract.md —
         frozen 34-key external-signal/v1 projection, verbatim disclaimers,
         mandatory R8-F revalidation, mutability/audit/security invariants.
C9=PASS  36/36 connected adversarial cases (api/market-signal-acceptance.test.ts)
         covering acceptance checks 1–36, plus pure-module adversarial units.
```

## C9 evidence map (all PASS)

1 official/authoritative ingest → OFFICIAL/VERIFIED_EXTERNAL/HIGH ·
2 verified catalog source → VERIFIED ·
3 duplicate event converges (1 row, 1 audit) ·
4 malformed source rejected (nothing persisted) ·
5 spoofed origin rejected ·
6 self-trust fields rejected ·
7 model cannot raise trust ·
8 single source bounded (SINGLE_EXTERNAL_SOURCE/LOW) ·
9 independent corroboration → CORROBORATED_EXTERNAL/MEDIUM both rows ·
10 syndicated copy (same eventKey) NOT independent ·
11 contradiction flips target CONTRADICTED, both visible ·
12 supersession preserves history + xsf1 fact ·
13 stale classified STALE ·
14 expired excluded from active projection, queryable labelled ·
15 cross-business association rejected ·
16 cross-tenant read returns nothing ·
17 irrelevant excluded from active evidence ·
18 DIRECT relevance keeps exact matched terms ·
19 relevance ≠ truth (both directions) ·
20 modelAssistance candidate-only (hash-neutral, converges) ·
21–24 injection detected/annotated/inert, no execution, no secrets, SQL/shell
text inert · 25–30 hostile ingest writes nothing outside R8-C tables
(businesses row byte-identical; write-guard enforced) · 31 protected-trait
terms never drive relevance · 32 projection read-only (frozen allowlist,
no content, verbatim disclaimers) · 33 identity deterministic · 34 conflicting
replay fails closed · 35 audit/provenance exactly-once, metadata hygiene ·
36 fully offline (no raw-SQL executor use, no provider surface).

## TESTING

```
targeted=PASS            api/market-signal-acceptance.test.ts 36/36
affected_regressions=PASS audit 12/12 + taxonomy suite 20/20;
                         R5 listening 137/137 (incl. r5-a acceptance 19/19);
                         R7 outcome 33/33, attribution 49/49,
                         business-learning 41/41, experimentation 48/48,
                         r7-x security 21/21 (+ harness green)
full_suite=PASS          6907 passed, 68 skipped, 14 todo across 431 files;
                         single failure src/pages/Campaigns.test.tsx is
                         environmental (Firebase auth/invalid-api-key — this
                         fresh worktree has no .env Firebase keys; zero files
                         under src/ changed in this stream: verified via
                         `git diff --name-only a2c084a HEAD -- src/` = empty)
typescript=PASS          tsc -b exit 0
build=PASS               vite build + api bundle + deployment verification
diff_check=PASS          git diff --check clean
secret_scan=PASS         no secrets/PII in diff; only defensive detector
                         patterns (injection regexes, credential rejection)
```

## SCHEMA

```
schema_changed=true            external_sources, external_signals,
                               external_signal_lifecycle_events (+ row types,
                               closed vocab consts) in db/schema.ts
provisional_migration=0036_r8_c_market_external_signal_foundation.sql
                               (stream-local artefact, SQL-only — no journal/
                               snapshot entry, following the R8-A convention)
migration_execution=False      no DDL executed against any database;
                               collision with R8-A/R8-F provisional 0036s
                               documented for R8-X convergence
                               (docs/recovery/r8-c-unexecuted-migrations.md)
```

## SECURITY

```
SECURITY_VERDICT=PASS
EXTERNAL_SIGNAL_INTEGRITY_VERDICT=PASS   immutable evidenceHash core; drift
                                         fails closed on read; exact-once
                                         convergence; conflicting replay fails
                                         closed
SOURCE_PROVENANCE_VERDICT=PASS           identity binds normalized coordinates;
                                         malformed + spoofed origins rejected;
                                         syndicated copies converge/detected
SOURCE_TRUST_BOUNDARY_VERDICT=PASS       trust server-derived only (code-level
                                         registry); client/model can never
                                         supply or raise trust; exact R8-F
                                         vocabulary, no competing authority
CORROBORATION_INTEGRITY_VERDICT=PASS     independence = distinct origin AND
                                         distinct eventKey; syndication never
                                         counts; contradiction stays visible
FRESHNESS_INTEGRITY_VERDICT=PASS         deterministic per-type thresholds;
                                         recomputed at read; expired excluded;
                                         future-dated evidence rejected (±5min)
TENANT_ISOLATION_VERDICT=PASS            session userId anchors every read/
                                         write; cross-tenant reads return
                                         nothing; cross-business lineage fails
PROMPT_INJECTION_RESISTANCE_VERDICT=PASS content inert by construction;
                                         deterministic detection annotates only;
                                         21–24 adversarial cases green
AGENT_ISOLATION_VERDICT=PASS             compromised extraction agent cannot
                                         fabricate provenance, raise trust,
                                         invent corroboration, hide contradiction,
                                         mark stale current, or fabricate
                                         relevance (all bounded server-side)
TOOL_LEAST_PRIVILEGE_VERDICT=PASS        stream exposes no execution surface;
                                         fake-DB write guard proves writes only
                                         to R8-C tables + audit
CROSS_AGENT_TRUST_VERDICT=PASS           no cross-agent trust delegations; model
                                         output is candidate material only
SELF_MODIFICATION_GUARD_VERDICT=PASS     no runtime policy mutation endpoints;
                                         registry/policy are code-level
SECRET_ISOLATION_VERDICT=PASS            no secret access; audit metadata
                                         hygiene; injection secret-request
                                         shapes detected and inert
PRIVILEGE_ESCALATION_FOUND=NONE
ROGUE_AGENT_BLAST_RADIUS=NONE            contained to inserting inert,
                                         honestly-classified evidence rows;
                                         zero authority, zero execution paths
UNRESOLVED_AGENT_SECURITY_DEBT=NONE
```

## FINAL VERDICT

```
MARKET_EXTERNAL_SIGNAL_INTELLIGENCE_READY
```
