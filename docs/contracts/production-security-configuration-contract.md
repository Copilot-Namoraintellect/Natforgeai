# Production Security & Trust Boundary Contract (WBS-R10-F)

> Canonical contract for the production security architecture of the
> autonomous Mission Control runtime.
> Branch `feature/r10-f-production-security`; frozen base
> `799f6b4cb351ebe969f97da606324605fdf2a07b` (R9-X `MISSION_CONTROL_V1_READY`).
> Implementation: `api/lib/production-security/`; scan:
> `scripts/secret-scan.mjs`; inventory:
> `docs/recovery/r10-f-production-security-inventory.md`; acceptance:
> `docs/recovery/r10-f-production-security-acceptance-report.md`.
> Date: 2026-11-10.

## 1. Purpose and charter principles

This contract defines the trust boundaries between autonomous agents,
application services, human administrators and external providers, the
classification of every secret class and its permitted readers, and the
repository-level mechanisms that keep secrets out of model-visible payloads,
logs, audits, errors, callbacks and diagnostics.

**Charter principles (verbatim on every surface):**

1. **Least privilege, no implicit equivalence.** Every identity holds exactly
   the authority this contract grants it; nothing is implied by role
   adjacency, process co-location or deployment topology.
2. **AI/model output is untrusted data.** A model can never obtain a secret,
   name a secret path, select a provider account, change tenant/business,
   alter permissions, elevate autonomy, or inject secret material into a
   persisted payload — every such attempt fails closed.
3. **Server-side last binding.** Provider credentials are bound to provider
   calls in server code behind the broker boundary; agents never receive raw
   provider credentials, and no client-supplied material can select a
   credential.
4. **Fail closed.** Missing classification, unknown reader, unknown variable,
   tampered shape — all deny.
5. **No real production secrets in-repo, ever.** Values live only in the
   runtime secret source (production: environment/secret manager injected by
   the deployment authority — R10-A owns the mechanism). This stream used no
   real production secrets and did not access OneGrid.

**Boundaries:** this contract owns security architecture, classification,
redaction and the broker mechanism. It does not execute deployment or server
verification (R10-A), does not implement R11 product capabilities (SSO/SCIM/
enterprise RBAC), and does not modify stream business authority (R5–R9).

## 2. Trust model (F1)

Nine distinct identities. **No implicit equivalence:** any cross-identity
authority requires an explicit, audited grant defined in this contract or a
frozen stream contract.

| Identity | Definition | Authority highlights | Explicit non-authority |
|---|---|---|---|
| **Human identity** | A person authenticated via local credentials + OTP/2FA (`REQUIRE_TWO_FACTOR`) or Firebase/Google OAuth with verified session | Uses the app within subscription limits; completes OTP-bound reviews | Cannot act as a service; cannot read secrets; tenant JWT alone never resolves a governed human review |
| **Service identity — web/API** | The `node dist/boot.js` HTTP/tRPC process | Serves requests; reads APPLICATION/DATABASE/PROVIDER/INFRASTRUCTURE classes via broker | No deployment/backup/break-glass authority; no infrastructure admin |
| **Service identity — workers** | `node dist/worker.js` BullMQ consumers (publishing, content-generation) | Queue consumption; DATABASE/REDIS via broker | No inbound HTTP authority; no deployment/backup authority |
| **Service identity — scheduler** | In-process scheduled passes (post-live lifecycle/metrics, listening polls — all default-OFF/operator-gated) | Trigger due work through governed services | Cannot create execution authority; no secret beyond app/db/infra classes |
| **Service identity — migration/admin** | `drizzle-kit`/one-off schema tooling under operator control | DATABASE/INFRASTRUCTURE schema migrations | Not a runtime process; never serves traffic |
| **Service identity — backup** | Future backup/DR job (no in-repo job today) | BACKUP_SECRET class only | No application secret access; no runtime presence |
| **Service identity — monitoring** | Health/readiness probes and log shipping | Read health projections; INFRASTRUCTURE (redis) metrics | No business data authority; no writes |
| **Service identity — deployment** | CI/CD pipeline and server provisioning (R10-A) | DEPLOYMENT_SECRET class; writes build artefacts; restarts services | No application business authority; no backup/break-glass reads |
| **Agent identity** | The autonomous Mission Control runtime (R9 A–F) acting through `runAgent` and governed seams | Bounded proposals/decisions per frozen stream contracts | **No broker mint (denied at mint time); no env reader; no secret ever; no shell/SQL/tool; no permission change** |
| **Tenant identity** | The authenticated principal scoping every request (`ctx.user`, JWT `userId`) | Own-row data within subscription limits | Cannot cross tenants; cannot select business scope outside own rows |
| **Business identity** | The business scope key inside a tenant (campaigns/leads/DNA attach to it) | Scoped data ownership within the tenant | Never crosses tenants; never implied by tenant alone where a business key is required |
| **Provider identity** | External API principal (OpenAI, Meta, Stripe, SMTP, OAuth platforms) | Receives only its own bound credential at call time | Never sees other providers' credentials; webhook calls verified with per-provider shared secrets |
| **Infrastructure administrator identity** | The OneGrid server/OS administrator (human, R10-A) | OS-level administration outside the application runtime | Separate from all application identities; application runtime must not automatically hold this privilege (F4) |
| **Break-glass identity** | Emergency human administrator (F8) | Time-bounded emergency actions, fully audited | Not available to agents; not used for routine execution; no runtime reader exists |

## 3. Secret classification (F2)

Closed vocabulary, mirrored in code (`secret-classification.ts`) and asserted
by tests. `agent-runtime` appears in **no** reader list.

| Class | Definition | Examples (names only) | Permitted readers (runtime) |
|---|---|---|---|
| `PUBLIC_CONFIGURATION` | Non-secret config; browser-exposed `VITE_*` included | `PORT`, `VITE_FIREBASE_*`, feature flags, credit pricing | all identities (not brokered — not secret material) |
| `APPLICATION_SECRET` | App-owned crypto/session material | `APP_SECRET`, `TOKEN_ENCRYPTION_KEY`, `FACEBOOK_WEBHOOK_VERIFY_TOKEN` | web-api, worker, scheduler |
| `DATABASE_SECRET` | DB connection credentials | `DATABASE_URL` (maintenance variants `MYSQL_URL`/`DB_URL` are script-only) | web-api, worker, scheduler, migration-admin |
| `PROVIDER_SECRET` | Third-party API credentials | `OPENAI_API_KEY`, `STRIPE_SECRET_KEY`, `SMTP_PASS`, `META_APP_SECRET`, `FIREBASE_SERVICE_ACCOUNT` | web-api, worker, provider-adapter |
| `DEPLOYMENT_SECRET` | CI/CD + cloud provisioning credentials | `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_*` | deployment only |
| `INFRASTRUCTURE_SECRET` | Middleware credentials | `REDIS_URL` | web-api, worker, scheduler, monitoring, migration-admin |
| `BACKUP_SECRET` | Backup/DR encryption + storage credentials | `BACKUP_ENCRYPTION_KEY` (reserved — none in-repo) | backup only |
| `BREAK_GLASS_SECRET` | Emergency credentials | `BREAK_GLASS_*` (reserved — none in-repo) | **none** (human console only, F8) |

**Agents must never directly receive:** DB admin credentials, server admin
credentials, deployment credentials, backup credentials, secret-store
management authority, or raw provider credentials (the provider-adapter
service binds them server-side at the last moment). Unknown secret-looking
names fail closed to `APPLICATION_SECRET`; unknown anything fails closed.

## 4. Agent trust boundary (F3)

Model output is untrusted data. The following are architecturally impossible,
not merely disallowed by policy — there is no code path that would service
them, and the F10 rogue-agent suite proves each fails closed:

| Attempt | Mechanism that fails closed |
|---|---|
| Request arbitrary secret / choose secret name or path | No tRPC procedure, agent tool or runtime module exposes secret lookup; the broker refuses `agent-runtime` at mint time |
| Reveal environment / dump process environment | Agents have no env reader; `env.ts` is a server module outside agent reach; prompt guard rejects env-shaped strings in payloads |
| Select arbitrary provider account | Provider selection is a closed, server-side registry (sandbox adapters only; `LIVE_EXECUTION=False`) |
| Change tenant/business | `ctx.user` from verified JWT anchors every row; seams re-verify ownership from durable rows |
| Alter permission / elevate autonomy | Role checks in middleware; governance engines are raise-only; no `EXECUTE`/override semantics exist (R9-X audit) |
| Create / rotate credential | No such procedure exists |
| Expose secret in logs | Structured logger redacts by key + value shape; shared redaction module covers nested payloads |
| Inject secret into prompt | `assertSecretFreeModelPayload` screens prompt/system **before** billing or model call; output screened before persistence |
| Run shell / SQL / dynamic tool | No agent-invoked `child_process`/SQL/eval exists; the only `spawn` (ffmpeg) is a fixed binary + fixed args, unreachable from agent input |

## 5. Service least privilege (F4)

Production service identities and their **minimum authority**:

| Service | Reads (broker classes) | Network | Explicitly denied |
|---|---|---|---|
| web/API | APPLICATION, DATABASE, PROVIDER, INFRASTRUCTURE | 443 public via reverse proxy; app port internal-only | deployment/backup/break-glass/secret-store admin |
| workers | APPLICATION, DATABASE, INFRASTRUCTURE, PROVIDER (generation) | Redis + DB + provider egress only | inbound HTTP, deployment, backup |
| scheduler | APPLICATION, DATABASE, INFRASTRUCTURE | none public | execution authority creation |
| migration-admin | DATABASE, INFRASTRUCTURE | DB admin endpoint only | runtime traffic serving |
| backup | BACKUP | backup destination only | all application classes |
| monitoring | health projections, INFRASTRUCTURE metrics | metrics/log egress | business data |
| deployment | DEPLOYMENT | CI → artefact store → host | application business authority |
| provider-adapter | PROVIDER (last binding at call time) | provider endpoints | other providers' credentials, secret-store admin |

The application runtime (web-api/workers/scheduler) must not automatically
have infrastructure-admin privilege: it runs as an unprivileged OS account
(R10-A implements the account; this contract requires it).

## 6. Secret loading & redaction mechanisms (F5)

Code map (all under `api/lib/production-security/`, re-exported by `index.ts`):

- `secret-shapes.ts` — closed vocabulary of secret-shape patterns
  (word-boundary anchored; private-key blocks require material). Pure,
  deterministic, no entropy heuristic on the fail-closed path.
- `secret-classification.ts` — the F2 taxonomy + permitted readers as code.
- `redact.ts` — one deep-redaction primitive for every emission surface:
  `redactForLog`, `redactForError` (message-only), `redactForCallback`,
  `redactForDiagnostics`, `redactDeep`. Key taxonomy mirrors the audit
  envelope so no surface can drift wider than audit. Cycle-safe, depth-capped,
  never throws (it runs on failure paths).
- `payload-guard.ts` — `assertSecretFreeModelPayload` / `scanPayloadForSecrets`
  / `isSecretFreeModelPayload`; throws `MODEL_PAYLOAD_SECRET_DETECTED` naming
  paths only, never values.
- `secret-broker.ts` — `createSecretBroker(identity, source?)`: deny-by-default
  reads against the classification reader lists; refuses `agent-runtime` (and
  any unknown identity) at mint time; `BREAK_GLASS_SECRET` has no readers.

Hardened call sites:
- `api/lib/logger.ts` — sanitization now delegates to `redactForLog` (deep;
  previously only top-level keys and flat strings were covered).
- `api/lib/agents/runner.ts` — `runAgent` screens `{system, prompt}` before
  billing/run-record creation and screens model output before return; both
  fail closed through the existing failure-accounting path.
- `scripts/secret-scan.mjs` (`npm run security:secret-scan`) — deterministic
  tracked-file scan; findings hash-only, values never printed.

All fixtures are synthetic (Stripe's published example key, jwt.io example
JWT, AWS documented example id, repo-local fakes). No real secret was used,
generated or committed in this stream.

## 7. Production configuration contract (F6)

Required production configuration **by category** — no values recorded here.
Sources: runtime secret source = environment variables injected by the
deployment authority (R10-A) or a mounted secret store; placeholders live in
`.env.example` only; filled files are untracked from VCS (R10-F enforced +
`secret-scan` guards regression).

| Variable (name only) | Class | Required production source | Permitted readers |
|---|---|---|---|
| `APP_SECRET` | APPLICATION_SECRET | runtime secret source (≥32B random) | web-api, worker, scheduler |
| `DATABASE_URL` | DATABASE_SECRET | runtime secret source (private DB endpoint) | web-api, worker, scheduler, migration-admin |
| `REDIS_URL` | INFRASTRUCTURE_SECRET | runtime secret source (private endpoint) | web-api, worker, scheduler, monitoring, migration-admin |
| `OPENAI_API_KEY`, `CREATIFY_*`, `BANNERBEAR_*`, `TEMPLATED_IO_*`, `SMTP_PASS`/`SENDGRID_API_KEY` | PROVIDER_SECRET | provider-specific service binding (server-side last binding) | web-api, worker, provider-adapter |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | PROVIDER_SECRET | provider-specific service binding | web-api, provider-adapter |
| `META_APP_SECRET`, `LINKEDIN_CLIENT_SECRET`, `TIKTOK_CLIENT_SECRET`, `TWITTER_CLIENT_SECRET`, `FACEBOOK_APP_SECRET` | PROVIDER_SECRET | provider-specific service binding | web-api, provider-adapter |
| `FIREBASE_SERVICE_ACCOUNT` | PROVIDER_SECRET | mounted service-account file (never inline JSON) | web-api |
| `TOKEN_ENCRYPTION_KEY` | APPLICATION_SECRET | runtime secret source | web-api, worker |
| `VITE_FIREBASE_*` | PUBLIC_CONFIGURATION | build-time public config (Firebase client config) | all |
| `BACKUP_ENCRYPTION_KEY`, `BACKUP_STORAGE_CREDENTIAL` | BACKUP_SECRET | backup job identity only | backup — **inaccessible to application runtime** |
| `DEPLOYMENT_CREDENTIAL` / `GOOGLE_APPLICATION_CREDENTIALS` | DEPLOYMENT_SECRET | CI/admin only | deployment — never the application runtime |
| `BREAK_GLASS_*` | BREAK_GLASS_SECRET | sealed emergency store, human console | none (F8) |

Configuration rules: production boot fails closed on missing
`APP_SECRET`/`DATABASE_URL`/`FIREBASE_SERVICE_ACCOUNT`/`REDIS_URL`
(existing `env.ts` `required()` semantics, unchanged); all secret values come
from the runtime secret source — never from client input, model output, or
repository files.

## 8. Network / service boundary design (F7)

**OneGrid-ready security requirements** — prepared for R10-A; **these are
requirements, not claimed implementations.** R10-A verifies the real server
before any of this is asserted as live.

- **Externally exposed ports:** 80→443 only (HTTPS). IIS (or reverse proxy)
  terminates TLS 1.2+ and forwards to the app on an **internal-only** port
  (default 3000 bound to 127.0.0.1/loopback or an internal interface only).
- **DB exposure:** MySQL reachable only from application hosts (private IP /
  authorized-networks list); no public DB endpoint; migration-admin uses a
  separate least-privilege DB user.
- **Redis exposure:** private network only; no public endpoint; optional AUTH.
- **IIS/API boundary:** request-filtering rules block `.*` dot-segment and
  verb abuse; `web.config` carries no secrets; `.bak` artefacts removed.
- **TLS:** publicly trusted certificate; HSTS; redirect 80→443; no plain-HTTP
  admin paths.
- **Remote administration:** no public RDP/SSH; administration via VPN/bastion
  host + per-admin named accounts; break-glass follows F8.
- **Firewall:** default-deny inbound; allow-list 443 (and 80 for redirect)
  only; outbound restricted to provider endpoints + package/artifact stores.
- **Service account permissions:** application runtime = unprivileged OS
  account (no local admin, no service control, no registry secrets); workers
  same; deployment runs under a distinct CI account (F4).

## 9. Admin / break-glass model (F8)

Break-glass is **emergency human administrator access, separate from normal
runtime** by construction:

- **Human initiated:** an out-of-band human action on the host (or sealed
  credential store) — never an API call, never an agent action.
- **Audited:** every break-glass credential use is recorded in the
  infrastructure audit trail (OS + provider console), reviewed after use.
- **Time-bounded where practical:** one-time or short-lived credentials with
  automatic expiry; standing break-glass credentials are sealed and rotated.
- **Not available to agents:** no runtime reader exists
  (`BREAK_GLASS_SECRET` reader list is empty and tested).
- **Not used for routine execution:** routine admin uses the normal admin
  role + OTP flows; break-glass use triggers a post-incident review and
  credential rotation.
- No break-glass credential exists in the repository today; the class is
  reserved so R10-A can provision it without contract change.

## 10. Dependency / attack-surface review (F9)

Read-only review; scope kept to security surfaces (no feature work).

| Surface | Finding | Disposition |
|---|---|---|
| Tracked `.env.production` / `.env.backup-*` with filled values | **Critical** — live-looking secrets in VCS | **Fixed in-stream:** untracked (working copies kept), `.gitignore` extended, `secret-scan` guards regression. **Rotation mandatory for R10-A** (history exposure cannot be undone by untracking) |
| Raw `console.*` in boot/webhook/worker paths bypass structured logger | Moderate — redaction now applied at logger; raw paths still unsanitized | Documented debt: migrate hot paths to `logger.ts` (R10-X hygiene); webhook handlers already log bounded fields only |
| `firebaseStatus` public query reveals project id + error messages | Low — information disclosure | Documented debt: gate behind admin or degrade details (R10-X) |
| Admin env toggles: `ENABLE_ADMIN_RATE_LIMIT_BYPASS`, `TERMINAL_REPLAY_ADMIN_ENABLED`, `CREATIVE_V2_DIAGNOSTIC_HARNESS_ENABLED`, `FREE_AI_LEAFLET_FALLBACK` | Low–moderate — powerful when enabled | All default-off, admin-gated, fixture-only/in-memory where diagnostic; inventory recorded; R10-A must keep them unset in production |
| Anonymous endpoints (OAuth callbacks, webhooks, `ping`, `firebaseStatus`) | Expected — verified ingestion pipelines | Webhooks signature-verified, raw-body, exact-once; `ping` rate-limited; no env/secret material returned by any public procedure (F10 proves) |
| Dynamic `import()` in routers | Bounded — static string literals only | No user-controlled module selection; accepted |
| `child_process.spawn` (ffmpeg video renderer) | Bounded — fixed binary path + argument array | No shell interpolation; args derived from validated job rows, not client text; accepted |
| `eval` / `new Function` | **None found** in runtime code | Accepted |
| Outbound fetch (`api/lib/http.ts`, adapters, `website-analyser.ts`) | `HttpClient` base-URL bound; website-analyser fetches operator/tenant-supplied URLs (SSRF-shaped) | Existing URL-input guards retained; R10-A network egress allow-list (F7) is the production mitigation; documented debt: explicit SSRF guard (R10-X) |
| Local FS reads (brand resolvers) | Path-joined to project dirs | Accepted; no user-controlled absolute paths |
| `public/web.config.bak` tracked | Low — artefact | Delete at R10-A packaging (F7) |

## 11. R11 forward-compatibility (F11)

The model is prepared for, but does **not** implement, the R11 enterprise
capabilities:

- **SSO / Entra ID / Okta:** identity verification funnels through one
  session authority (`api/lib/session.ts` + `ctx.user`); an OIDC verifier can
  mint the same session shape without touching tenant anchoring.
- **SCIM:** service identities are a closed, named vocabulary — SCIM
  provisioning maps to those names rather than inventing parallel identities.
- **Enterprise RBAC:** role checks are centralized in `api/middleware.ts`;
  additional roles can layer between `user` and `admin` without weakening the
  `admin` gate.
- **Separation of duties:** the approval ledger is already OTP-bound and
  self-approval-free (R6-C/R9-F); SoD policies can bind to existing approval
  types without new authority.
- **Organisation hierarchy / business-unit policies:** tenant+business scoping
  is explicit in every governed stream; hierarchy adds a scope prefix, not a
  new trust domain.

## 12. Verification

- Unit: `api/lib/production-security/production-security.test.ts`.
- Rogue-agent: `api/r10-f-security.test.ts` (compromised-agent attempts across
  the real routers — all must fail closed).
- Regression: full vitest suite, `tsc -b`, production build,
  `git diff --check`, `npm run security:secret-scan`.
- Verdicts: recorded in the acceptance report.
