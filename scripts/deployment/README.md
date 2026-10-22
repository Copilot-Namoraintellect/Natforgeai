# WBS-R2.2 — Repeatable Deployment Package

Safe-by-default, fail-closed deployment tooling for the recovered NatForgeAI
codebase. **Nothing in this package executes against production on its own:**
every script runs in DRY-RUN mode unless invoked with `-Execute`, and every
gate aborts on the first failed check.

Phases (mirroring the script names):

1. **Preparation** — `verify-release.ps1`: proves the checkout is exactly the
   accepted branch/commit with a clean tree, that the toolchain matches the
   R2.1 baseline, and that required configuration keys exist (values are never
   printed).
2. **Validation** — `install-and-build.ps1`: clean dependency install
   (`npm ci`), full build (`npm run build`, which includes
   `verify-deployment.mjs`), and a post-build artifact check.
3. **Deployment** — `start-runtime.ps1`: PM2 (re)start of the API and,
   when Redis is configured, the standalone worker; followed by health
   verification (tRPC `health.getSystemHealth` on 127.0.0.1:3001 and the
   optional media smoke test).
4. **Rollback** — `rollback.ps1`: repoints PM2 and the IIS site root to a
   previous release directory and re-verifies health.

## Rules

- Run scripts from the repository root: `powershell -File scripts/deployment/<name>.ps1`.
- All scripts fail closed (`$ErrorActionPreference = 'Stop'`, explicit exit codes).
- No secret values are ever read into output; configuration checks are presence-only.
- Deployment/rollback execution requires BOTH `-Execute` and an interactive
  operator; there is no unattended production path.
- Keep `data/public/` (persistent media) OUTSIDE any release directory or
  restore it after rollback (see R2.1 §4).

## Typical sequence

```powershell
# 1. Preparation gate (dry-run safe)
powershell -File scripts/deployment/verify-release.ps1 -ExpectedCommit 53d42969cac76afc5e5bb1509c4e33f16224991f

# 2. Build validation
powershell -File scripts/deployment/install-and-build.ps1 -Execute

# 3. Deployment (operator-attended)
powershell -File scripts/deployment/start-runtime.ps1 -Execute -SmokeUrl https://<host>/generated/<probe-image>

# 4. If needed: rollback to a previous release dir
powershell -File scripts/deployment/rollback.ps1 -PreviousReleaseDir C:\releases\<previous> -IisSiteRoot "C:\releases\<previous>\dist\public" -Execute
```

The exact first production mutation and remaining gate decisions are
documented in the R2 final preparation report (`r2-final-preparation-report.md`).
