import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("V2 hook integrity", () => {
  it("keeps a single V2 hook outside creative-agent and service", () => {
    const root = resolve(__dirname, "../../..");
    const architect = readFileSync(resolve(root, "creative/campaign-message-architect.ts"), "utf8");
    const agent = readFileSync(resolve(root, "agents/creative-agent.ts"), "utf8");
    const service = readFileSync(resolve(root, "creative/service.ts"), "utf8");

    expect((architect.match(/observeMessageApprovalV2Shadow\(/g) || []).length).toBeGreaterThan(0);
    expect(agent.includes("message-approval")).toBe(false);
    expect(service.includes("message-approval")).toBe(false);
  });
});
