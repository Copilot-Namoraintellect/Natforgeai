# R10_A_A06_NETWORK_SECURITY_REPORT

Verdict: **A06_NETWORK_SECURITY_SPECIFICATION_COMPLETE_WITH_OPEN_LIVE_AND_OWNERSHIP_GATES**. Documentation-only acceptance. No IIS, certificate, firewall, DNS, Windows account, ACL, application, or service configuration was changed or inspected on the production host. Stop after A06; A07 has not begun.

## A. Documents created and modified

Created [A06 network/security specification](r10-a-a06-network-security.md), [A06 source catalog](r10-a-a06-sources.json) and this report. Updated only local planning requirement A05 (IIS/network/TLS) and its A06 continuation in [A01 requirements](r10-a-a01-requirements.md). All prior A01-A05 artifacts remain present; the other sixteen prior artifacts are unchanged.

## B. Network and proxy architecture

The spec proposes one NatForgeAI-specific IIS site, application pool and immutable static release root, with exact hostname/SNI bindings isolated from Zuto. Public ingress is default-deny with IIS on 443 and 80 only where redirect or an explicitly chosen certificate challenge requires it. IIS terminates TLS and proxies only approved routes to Node loopback `127.0.0.1:3001`; MySQL/Redis remain private and direct API/data exposure is denied. It covers trusted/overwritten forwarded headers, host validation, webhooks, request filtering, TLS/HSTS, headers/cookies, request size, timeouts, egress, remote admin, DNS cutover and rollback.

Repository evidence: `api/boot.ts` defaults `PORT` to 3001 and binds loopback; `public/web.config` proxies `/api`, `/generated`, `/uploads` to 3001 and puts SPA fallback last; Hono body cap is 50 MiB. The file has no visible TLS redirect, forwarded-header controls, request filtering or security headers. No WebSocket endpoint was identified in inspected source. These facts do not prove installed modules, rules or host behavior. Microsoft's official IIS references for SNI bindings, ARR/Rewrite, request limits and response headers are linked in the spec; they support the configuration concepts only.

DNS facts are recorded from the mission: apex and `www` currently point to `104.37.190.42`; cutover is not authorized. The safe procedure requires a zone snapshot and exact approved web-record changes while preserving MX, mail, wildcard and unrelated records. No zone data was queried or reproduced.

## C. Acceptance criteria and live gates

Offline criteria cover all A01-A16 and D01-D12 cross-references, the 3001 source alignment and F's 3000 variance, no public direct-service access, Zuto/DNS isolation, and clear labeling of unknowns. Future live gates require inspection of IIS/ARR/Rewrite and bindings, SNI/TLS/redirect/renewal checks, loopback-only API proof, header/host/path/method/body/timeout probes, static-root/media checks, ingress/egress and management deny tests, header/cookie review, and an authorized DNS cutover/rollback rehearsal. **All live checks remain NOT RUN.**

## D. Open decisions and dependencies

D01 port/canonical-host and F variance; D02 supervisor/readiness; D04 route/media ownership; D05 identities/ACLs; D06 private DB/Redis endpoint/ports; D07 secrets and deployment boundary; D08 certificate/challenge/renewal/DNS authority; D09 telemetry; D10 backup egress; D11 independent stop; D12 approvers/signatories remain open as documented. ARR/Rewrite installation and server-scope impact, forwarded-header app support, exact timeout/limit/header/cipher values, IPv6, provider egress set, current zone records and effective NAT/firewall rules are unknown.

A owns platform/IIS/network specification. F/D/E/C/G/H retain their security/provider/telemetry/runtime/backup/stop contract authorities. X coordinates production composition but is not appointed as application implementer. Application work for proxy trust, host/scheme redirects, cookies, media authorization/routes and safe readiness remains unassigned pending recorded ownership. Host, certificate and DNS approval authorities remain unnamed in evidence.

## E. Validation and Git

Checks: branch `feature/r10-a-production-platform`; HEAD remains `799f6b4cb351ebe969f97da606324605fdf2a07b`; accepted source catalogs read and source paths/hashes rechecked; port references manually reconciled to frozen boot/web.config; local Markdown links, JSON parsing, source hash entries, A01 planning crosswalk coverage and whitespace checks passed; `git diff --check` passed. Documentation scope only: three A06 files plus A01 requirements traceability. No application tests or live/prod checks were run; no code, executable config, infra, DNS or Git-history changes occurred.

## F. Recommended next single action

Obtain a recorded D01/D08 decision from the named platform, certificate and DNS authorities covering canonical hostname(s), supported certificate challenge/renewal and explicit port alignment with F before authorizing any IIS or DNS change. Do not begin A07 in this stage.
