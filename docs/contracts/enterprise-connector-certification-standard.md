# Enterprise connector certification standard

Applies to future Salesforce, Adobe, SAP, Google, Meta, LinkedIn, CRM/CDP and
enterprise internal API connectors. These examples are a certification scope,
not integrations implemented or activated by R10-D.

Certification is per adapter version, capability, account-binding type, tenant
deployment and provider API version. A brand name, credential or healthy endpoint
is insufficient.

| Gate | Required evidence before production activation |
| --- | --- |
| Declaration | Closed code-reviewed declaration; unknown provider/action/capability rejection; immutable registry |
| Authority | Current R9 upstream readiness and R9-F decision/approval/policy checks; exact server-selected provider/account and attempt binding; no selection from model output |
| Account ownership | Verified tenant/business/account mapping, revocation, credential rotation and suspended binding tests |
| Transport | Fixed reviewed HTTPS endpoints, redirect/SSRF policy, TLS verification, bounded connect/read/whole-request timeouts and response size; no arbitrary URLs or commands |
| Credentials | Server-only least-privilege account/capability scopes, fixed vault registration, separate callback verification permission, no secret names from requests, redacted logs/identifiers, rotation/revocation rehearsal |
| Idempotency | Native-key semantics documented where available; durable local claim across crashes; provider-side dedup window measured; unsupported native guarantees disclosed; unresolved effects prohibit blind resend |
| Business results | Provider-specific semantic parser; receipt/HTTP 200 not terminal proof; explicit failure/retryability; malformed/truncated/ambiguous outcomes remain uncertain |
| Callback security | Provider-specific signing protocol, raw-body handling where required, freshness, key rotation, provider/account/event identity, replay, tenant/business/request/attempt binding |
| Convergence | Concurrent duplicate callback/dispatch tests, reordered and contradictory terminal evidence retained, no replay-anchor poisoning |
| Reconciliation | Read-only scoped provider lookup bound to request/account; referenced terminal evidence; unknown remains uncertain; bounded polling; no fabricated evidence |
| Rate limits | Provider global capacity allocation plus account/action quotas; multi-process persisted limits; Retry-After parsing and caps; no autonomous retry |
| Backoff/circuit | Bounded policy, durable restart behavior, half-open concurrency tests, no fallback account/provider selection, fresh authorization for any new attempt |
| Degradation | Pause/pending/attention posture exercised; recovery candidates remain advisory; no widened spend, recipient set or data scope |
| Observability | Tenant/business-scoped provider-health/v1 allowlist, unavailable/unknown samples honest, correlation references only, no credentials or free-text exception leakage |
| Enterprise data | Reviewed mapping and retention, minimal field disclosure, pagination/partial batch behavior, per-item results, cancellation/compensation semantics without inferred rollback |
| Adversarial behavior | Injection strings inert, unknown tools/URLs/secrets rejected, cross-tenant/business/account attacks, credential echo, malformed callbacks, approval drift and stale authority tested |
| Persistence | R10-X migration convergence; isolated real-MySQL crash/restart/rollback/duplicate-key/CAS/row-lock/deadlock tests; no provider call before durable claim commit |
| Release | Security and owner review, sandbox provider conformance, explicit production activation authorization, staged rollout, kill switch and revocation rehearsal |

A failed or unsupported gate keeps that connector/capability disabled. Migration
execution, live-provider trials, deployment and production mutations require a
separate activation task. Provider/circuit health cannot waive any gate.
