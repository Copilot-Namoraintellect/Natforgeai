# R8-X Integration Baseline (X0 — Exact-Head / Baseline Acceptance)

> Gate: X0. All values below were captured live from the repository on the
> integration host immediately before any merge. Authority gate PASSED.

integration_branch=integration/r8-strategic-intelligence
integration_initial_head=a2c084a1f0bca110a00e51f83632733789cec5f7
integration_remote_head=a2c084a1f0bca110a00e51f83632733789cec5f7
working_tree_clean=true

r8_a_head=23d0f220ea8b36655c12cefb67264c20c81e57bb
r8_b_head=055eecef7eebe75d270b9b446423db3ae0719b63
r8_c_head=b366c5e791e0f080b60a0837633125d3d44a42f7
r8_d_head=00f9adf3f80bf7716bfc0fd01fad2000900351d8
r8_e_head=05f5fa2082ad84fdcb4a4558dd70f95300bbfeb3
r8_f_head=44118e3da325eadabd22c705dad985485b0a76cc

EXPECTED (from programme brief) — all matched exactly:

r8_a_head=23d0f220ea8b36655c12cefb67264c20c81e57bb
r8_b_head=055eecef7eebe75d270b9b446423db3ae0719b63
r8_c_head=b366c5e791e0f080b60a0837633125d3d44a42f7
r8_d_head=00f9adf3f80bf7716bfc0fd01fad2000900351d8
r8_e_head=05f5fa2082ad84fdcb4a4558dd70f95300bbfeb3
r8_f_head=44118e3da325eadabd22c705dad985485b0a76cc

## Verification evidence

- `git fetch origin --prune` completed cleanly; all six frozen remote refs
  re-resolved after the fetch and still match the accepted SHAs.
- Local HEAD == remote HEAD (`a2c084a1...`); `rev-list --left-right --count`
  reported `0 0` (no divergence).
- `git status --porcelain` produced no output (clean tree).
- `git merge-base --is-ancestor origin/feature/r8-{a..f} HEAD` returned false
  for every stream: no stream was already merged accidentally.
- No local-only branch was substituted for any frozen remote authority; all
  verification used `origin/...` refs.

X0 authority gate: **PASSED**. Proceeding to X1 controlled stream merges in
dependency order: A → F → B → C → D → E.
