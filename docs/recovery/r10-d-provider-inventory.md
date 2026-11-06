# R10-D provider inventory and recovery

Frozen programme base: `799f6b4cb351ebe969f97da606324605fdf2a07b`.
Worktree: `C:\Users\27768\NatForgeAI-R10-D`.
Branch: `feature/r10-d-provider-resilience`.

Recovery inspection occurred before edits. No reset, clean, discarded changes,
sibling merge, migration execution, application start, or deployment occurred.

```text
RECOVERY_BASE_HEAD=799f6b4cb351ebe969f97da606324605fdf2a07b
CURRENT_CHANGED_PATH_COUNT=1
CURRENT_UNTRACKED_PATH_COUNT=18
INFERRED_ACTIVE_STAGE=D14 helpers / connected service incomplete
LEGITIMATE_WORK_PRESERVED=True
SAFE_TO_RESUME=True
```

The original short status grouped untracked files into two paths; the count
above expands them into 17 TypeScript files and one migration. The schema was
the only tracked modification. There were no unmerged paths.

Recovered D1–D12/D14 helper modules and a provisional five-table schema existed.
No connected service, fake-provider acceptance, credential boundary, inventory,
or certification document existed. Recovered code was unverified. Corrections
include R9 canonical parameter hashing; missing declaration imports; malformed
circuit fold return shapes; failure-window reset; OPEN-to-HALF_OPEN persistence;
retry-after arithmetic; actual outer timeout enforcement; Drizzle SQL/query
typing; immutable declaration snapshots; strict bounded JSON; secret-free
diagnostics; request-bound reconciliation; and replay anchors consistent with
the migration. All legitimate recovered modules were retained and completed.

## Existing integration surfaces inspected, read-only

| Surface | Repository source | Boundary / migration posture |
| --- | --- | --- |
| AI text/model calls | api/lib/agents/openai.ts | Existing model SDK; not registered as an R10-D execution provider |
| Facebook, Instagram, LinkedIn, Twitter/X, TikTok OAuth | api/lib/integrations/platforms.ts; oauth.ts; oauth-callback.ts | Existing provider account/OAuth paths; not imported or invoked by R10-D |
| Social publishing adapters | api/lib/integrations/adapters/adapter-registry.ts and platform adapters | Existing closed platform vocabulary; compatibility tested with mocks |
| WhatsApp, SendGrid, SMTP | api/lib/integrations/platforms.ts | Existing messaging transports; no R10-D registration |
| AI images / creative renderers | api/lib/creative/providers/ | OpenAI, Bannerbear, Templated, Creatify and internal/placeholder renderers; not activated by this work |
| Video provider selection | api/lib/video/provider.ts | Existing selection remains outside Mission provider-switch authority |
| Authentication / storage infrastructure | api/lib/firebase-admin.ts; api/lib/creative/storage.ts | Firebase verification and S3-compatible asset storage references; no registration or service access added |
| Email / audience / asset retrieval | api/lib/email.ts; api/lib/audience/adapters/; api/lib/website-analyser.ts; api/lib/creative/brand-asset-resolver.ts | Existing messaging, audience and URL retrieval surfaces; no Mission-provider activation |
| Payment administration | api/banking-router.ts; api/subscription-router.ts; api/admin-router.ts | Payment configuration and administration references; not certified production billing adapters |
| Secret infrastructure | api/lib/secrets.ts | No secret-store lookup, secret read, or arbitrary secret path added |
| R9 execution and recovery | api/lib/execution-coordination/; api/lib/mission-state-recovery/ | Frozen authority consumed read-only; no upstream writes |
| R10-D declared provider | Acceptance fixture in api/lib/provider-resilience/provider-resilience-acceptance.test.ts | In-process sandbox only; no network or external side effects |

The inventory records repository integration surfaces, not certification of
their existing production behavior. They are not silently routed into Mission
Control. Future activation requires the connector certification gates.

No sibling branch was merged. R10-B/E/F were not required to implement the frozen
R9-compatible boundary; the D-to-observability contract is additive and explicit.

## Subsequent interrupted-session recovery (2026-11-02)

The earlier recovery record above is retained as history. This resumption found
the later implementation already staged, rather than the original helper-only
state described in the recovery prompt. Inspection preceded edits and covered
every provider module, the staged schema diff, the migration and contracts.

```text
RECOVERY_BASE_HEAD=799f6b4cb351ebe969f97da606324605fdf2a07b
CURRENT_CHANGED_PATH_COUNT=28
CURRENT_UNTRACKED_PATH_COUNT=0
INFERRED_ACTIVE_STAGE=D17 validation and final acceptance report
LEGITIMATE_WORK_PRESERVED=True
SAFE_TO_RESUME=True
```

All 28 paths were staged; no unmerged paths or R10-D commit existed. D0–D16
artifacts and 76 connected cases were present and initially unverified. This
resumption retained those artifacts, verified them, and strengthened probe
accounting against ordinary stragglers, exact pending reconciliation binding,
callback payload snapshots, unresolved-attempt exclusion, immutable persistence
fields and approval binding acceptance. See the final acceptance report for
validation results and activation limitations.
