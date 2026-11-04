# R10-A A01 platform baseline

Recorded 2026-11-04. Scope: documentation only for the first NatForgeAI deployment on TNN05-WIN1. This is a new environment, not restoration of a previous installation. No server was contacted in A01.

## Evidence and authority

The mission supplied by the user is source M: verified host facts and approved planning direction. These facts are operator-supplied verification evidence, not measurements performed by this agent. Repository evidence is indexed, with observed worktree heads and file hashes, in [the source catalog](r10-a-a01-sources.json). The frozen R9-X authority is `799f6b4cb351ebe969f97da606324605fdf2a07b`; no sibling was merged. Source document dates and embedded HEAD statements are historical claims, not current checkout identity. Several source dates are later than this session date; they are preserved as source metadata, not used to infer execution chronology.

## Verified host facts (M)

| Fact | Evidence boundary |
|---|---|
| Host TNN05-WIN1, OneGrid; Windows Server 2022 Standard x64 | Supplied verified fact; no new host inventory |
| 6 logical processors, approximately 31.89 GB RAM | Capacity available to the host, not a NatForgeAI reservation |
| IIS running existing Zuto applications; SNI enabled | Coexistence required; NatForgeAI site, certificate, ARR and URL Rewrite readiness not verified |
| Public IP 41.185.71.10 | No connectivity or firewall verification performed |
| Node.js 26.13.0 and npm 11.20.0 installed and verified | Installation does not establish application/dependency compatibility |
| Dedicated root `D:\www\natforgeai` exists; no application deployed | No release, service or media subdirectory asserted to exist |
| Existing Azure DevOps deployment agents use an administrator-privileged deployer identity | Identity must not be reused for application runtime; no account details recorded |
| natforgeai.com DNS points elsewhere | Leave DNS unchanged; no cutover authorization |

## Approved planning direction (M), not implemented state

Use Windows/IIS with a NatForgeAI-specific site/application pool and TLS/SNI isolation from Zuto. IIS fronts API HTTP on `127.0.0.1:3001`; never expose 3001 publicly. Frozen `api/boot.ts` explicitly binds loopback and defaults to 3001; `public/web.config` proxies `/api`, `/generated` and `/uploads` there. F section 8's generic 3000 guidance conflicts with this port; record the variance for F/X reconciliation, without editing F.

Use isolated, versioned release directories beneath the dedicated root. Keep persistent generated media and uploads in absolute shared roots outside all releases. Exact directory names, release-pointer mechanics and ACLs remain D03/D04 decisions. Illustrative candidates are `D:\www\natforgeai\releases\<release-id>` and `D:\www\natforgeai\shared\media\{generated,uploads}`; they are not approved concrete paths or created directories. Shared secrets, logs and backups need distinct access boundaries; backups must also be outside any web-served root.

Use dedicated unprivileged runtime identities, distinct from deployment, migration, backup, monitoring and independent incident administration. Run API and worker under separate supervision. Supervisor product, API/worker account granularity and service names remain open. A process restart never restores business authority. No provider, scheduler or autonomy activation follows from this topology.

## Historical configurations, not host facts

`docs/recovery/deployment/r2.1-server-runtime-baseline.md`, `r2-final-preparation-report.md`, and `docs/publishing-workflow-system-documentation.md` describe earlier deployment/recovery models: Node 20/npm 10, PM2, old application paths, relative `data/public` storage and earlier migration chains. None proves an installation on TNN05-WIN1. Do not reuse an old path, service name or process identity as a discovered fact. G's Linux shell/systemd/cron examples require a reviewed Windows implementation choice; they do not establish Windows backup readiness.

## Assumptions and unresolved verification

No evidence yet establishes MySQL/Redis location, version, provisioning, TLS, access controls or capacity; installed IIS proxy modules; domain/certificate ownership; outbound restrictions; time synchronization; available disk and backup capacity; supervisor/reboot behavior; alert delivery; or Node 26 build/native dependency compatibility. G's same-host MySQL and offsite-storage assumptions remain unconfirmed. RPO/RTO figures in G remain provisional until a measured X drill.

The R9-X handoff's broad offline-green summary must be read alongside its final acceptance report, which records build/environment failures and unexecuted real-MySQL tests. H's later offline-ready report is sibling-local evidence, not a repair integrated into this baseline. No offline verdict here establishes live readiness.

## Storage remediation requirements (record only)

Frozen `api/lib/creative/storage.ts:8` and `:12` derive production writer roots from `process.cwd()`. `api/lib/vite.ts:30` and `:31` derive media roots the same way, while its serving middleware uses relative roots at lines 42-43. Release-local working directories would therefore split media between releases even though storage is outside `dist`.

Application media resolver, video renderer, metadata and runtime-route modifications remain UNASSIGNED implementation work coordinated through X under the reconciliation mission R. No cited contract explicitly appoints their implementer. A owns platform path/ACL planning; that does not assign application code ownership. The application handoff requires consistent absolute shared roots for readers, writers and static serving, containment/traversal checks and startup validation. No configuration variable name or implementation is approved here. Inventory also includes `api/lib/creative/brand-palette.ts`, `brand-asset-resolver.ts`, `composition.ts`, `premium-v2/brand-kit.ts`, `premium-v2/fixture-logos.ts`, `providers/hybrid-leaflet-composer.ts` and `providers/internal-template-renderer.ts`; a complete reader/writer search remains required before implementation.

Acceptance must demonstrate API and worker resolve identical roots from different working directories, read/write/serve parity, preserved media across release switch/rollback, no writes to release trees, correct identity ACLs, backup coverage and verified restore. Distinguish persistent media from scratch/render temporary files with cleanup and quota policies. A01 changes none of these paths or files. Since this host has no NatForgeAI data, do not invent a legacy-data migration; separately decide whether any external historical media import is wanted.

See [traceability](r10-a-a01-requirements.md), [decisions and ownership](r10-a-a01-decisions.md), and [acceptance](r10-a-a01-acceptance-report.md).
