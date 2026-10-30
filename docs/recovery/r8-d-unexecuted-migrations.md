# R8-D UNEXECUTED MIGRATIONS — COLLISION DOCUMENTATION

> Stream: WBS-R8-D `feature/r8-d-strategic-reasoning`
> Date: 2026-11-10
> Status: **MIGRATION_EXECUTION=False** — every R8-D migration artefact is
> provisional only. Nothing in this stream was executed against any database.

## Stream-local provisional migration

| Artefact | State |
|---|---|
| `db/migrations/0036_r8_d_strategic_reasoning_foundation.sql` | Artefact only — **NOT executed** |

Tables (all R8-D-owned, no execution columns):

- `strategic_reasoning_bundles` — deterministic `evb1:` evidence bundles
  (unique `(userId, bundleId)` convergence anchor; tamper-evident
  `evidenceFingerprint`; bounded reasoning graph JSON; bound source versions).
- `strategic_reasoning_records` — immutable `rsn1:` conclusions (unique
  `(userId, reasoningId)` convergence anchor; `reasoningFingerprint` replay
  binding; governance binding columns verbatim from the R8-F decision).
- `strategic_reasoning_lifecycle_events` — append-only `srl1:` facts
  (supersession / contradiction / staleness / invalidation / governance
  binding).

The same tables are declared in `db/schema.ts` (canonical single source of
truth, house convention). Because the migration is not executed, no runtime
deployment depends on these tables; the acceptance suites run over the
in-memory fake store.

## 0036 collision statement

The R8 programme has **five** stream-local provisional migrations all
numbered `0036` (deliberately not converged here, per programme governance):

| Stream | Provisional migration |
|---|---|
| R8-A strategic memory | `0036_r8_a_strategic_memory_foundation` |
| R8-B business change | `0036_r8_b_business_change_foundation` |
| R8-C market external signals | `0036_r8_c_market_external_signal_foundation` |
| R8-D strategic reasoning (this stream) | `0036_r8_d_strategic_reasoning_foundation` |
| R8-F strategic governance | `0036_r8_f_strategic_governance_foundation` |

R8-D's tables reference upstream rows **only by identity string** (`mem1:` /
`chg1:` / `xsig1:` / `sgd1:`), never by foreign key (house convention), so
the provisional artefacts are collision-free at the table level. **R8-X owns
canonical sequencing/convergence** into one `0036_r8_strategic_intelligence_foundation`
(or equivalent) exactly as R7-X converged the five provisional `0035`s.

## Invariants held

- R7's `0035_r7_business_optimisation_foundation` is **untouched**.
- No migration was executed; `MIGRATION_EXECUTION=False`.
- R8-D consumes upstream tables through guarded `information_schema` seams —
  it never requires the sibling provisional tables to exist at runtime, and
  fails closed when an authority is absent.
