import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Read-only frozen evidence, not sibling test execution or an integration claim.
const authorities = [
  [
    "b-data-concurrency",
    "5d20c418c8efc6a44abaa053e43c4691af2a5bb1",
    "docs/recovery/r10-b-data-concurrency-acceptance-report.md",
    "REAL_MYSQL_CONCURRENCY_EXECUTED=False",
  ],
  [
    "c-runtime-resilience",
    "cc5712d0a16dfd7dcfc5f0f2991b0d354f853a06",
    "docs/contracts/autonomous-runtime-resilience-contract.md",
    "Process recovery != authority recovery",
  ],
  [
    "d-provider-resilience",
    "d9492c6c2be4389d046948fc5aefd00b350b2d7d",
    "docs/contracts/production-provider-adapter-contract.md",
    "Provider health != provider-switch authority",
  ],
  [
    "e-observability-operations",
    "ea4f1f890ecd59079b4b13f7a67a6c96c617e11c",
    "docs/contracts/production-observability-contract.md",
    "observability != authority",
  ],
  [
    "f-production-security",
    "a0074a66c596fac3abca36c00c83413b744140cd",
    "docs/contracts/production-security-configuration-contract.md",
    "R11",
  ],
  [
    "g-backup-dr",
    "e4c5e56fc31001f66167be3f0d1bba686bc39d63",
    "docs/contracts/backup-monitoring-contract.md",
    "Runtime cannot suppress",
  ],
] as const;
describe("R10-H frozen sibling compatibility evidence (offline)", () => {
  it.each(authorities)(
    "R10-%s hash and boundary remain frozen",
    (branch, hash, path, invariant) => {
      expect(
        execFileSync("git", ["rev-parse", `origin/feature/r10-${branch}`], {
          encoding: "utf8",
        }).trim()
      ).toBe(hash);
      expect(
        execFileSync("git", ["show", `${hash}:${path}`], { encoding: "utf8" })
      ).toContain(invariant);
    }
  );
  it("C runtime dispatch still enters R9-D, which contains both H barriers", () => {
    const source = execFileSync(
      "git",
      [
        "show",
        `${authorities[1][1]}:api/lib/runtime-resilience/runtime-service.ts`,
      ],
      { encoding: "utf8" }
    );
    expect(source).toContain("dispatchExecutionAction(db, binding.execution");
    const current = readFileSync(
      "api/lib/execution-coordination/execution-coordination-service.ts",
      "utf8"
    );
    expect(
      current.match(/await assertAutonomyBoundary\(deps, action\)/g)
    ).toHaveLength(2);
  });
  it("D still requires fresh authority resolution and rejects live adapters", () => {
    const source = execFileSync(
      "git",
      [
        "show",
        `${authorities[2][1]}:api/lib/provider-resilience/provider-resilience-service.ts`,
      ],
      { encoding: "utf8" }
    );
    expect(source).toContain("live adapters are disabled");
    expect(source).toContain("await deps.authorize(");
  });
});
