import { describe, expect, it } from "vitest";
import { canonicalizeMessagePackCopy } from "../canonical-copy";
import { computeCopyHashSha256 } from "../hash";

describe("computeCopyHashSha256", () => {
  const base = canonicalizeMessagePackCopy({
    copySchemaVersion: "v2.1",
    headline: "Reduce payout delays",
    subheadline: "For operations managers",
    benefitBulletsOrdered: ["A", "B", "C"],
    cta: "Learn More",
    proofPointsOrdered: ["Verified local team"],
    platformCaptionsOrdered: [
      {
        platform: "Instagram",
        caption: "Trusted payouts for local teams",
        cta: "Learn More",
        hashtagsOrdered: ["#payouts", "#local"],
      },
    ],
    footer: null,
  });

  it("is deterministic for same input", () => {
    expect(computeCopyHashSha256(base)).toBe(computeCopyHashSha256(base));
  });

  it("is punctuation-sensitive", () => {
    const variant = canonicalizeMessagePackCopy({ ...base, headline: "Reduce payout delays!" });
    expect(computeCopyHashSha256(base)).not.toBe(computeCopyHashSha256(variant));
  });

  it("is capitalization-sensitive", () => {
    const variant = canonicalizeMessagePackCopy({ ...base, headline: "reduce payout delays" });
    expect(computeCopyHashSha256(base)).not.toBe(computeCopyHashSha256(variant));
  });

  it("is CTA-sensitive", () => {
    const variant = canonicalizeMessagePackCopy({ ...base, cta: "Schedule a Consultation" });
    expect(computeCopyHashSha256(base)).not.toBe(computeCopyHashSha256(variant));
  });

  it("is benefit-order-sensitive", () => {
    const variant = canonicalizeMessagePackCopy({ ...base, benefitBulletsOrdered: ["B", "A", "C"] });
    expect(computeCopyHashSha256(base)).not.toBe(computeCopyHashSha256(variant));
  });

  it("is schema-version-sensitive", () => {
    const variant = canonicalizeMessagePackCopy({ ...base, copySchemaVersion: "v2.2" });
    expect(computeCopyHashSha256(base)).not.toBe(computeCopyHashSha256(variant));
  });

  it("is source-neutral when canonical copy is unchanged", () => {
    const sameCopy = canonicalizeMessagePackCopy({ ...base });
    expect(computeCopyHashSha256(base)).toBe(computeCopyHashSha256(sameCopy));
  });

  it("is proof-point-sensitive", () => {
    const variant = canonicalizeMessagePackCopy({ ...base, proofPointsOrdered: ["Different proof"] });
    expect(computeCopyHashSha256(base)).not.toBe(computeCopyHashSha256(variant));
  });

  it("is platform-caption-cta-sensitive", () => {
    const variant = canonicalizeMessagePackCopy({
      ...base,
      platformCaptionsOrdered: [
        {
          platform: "Instagram",
          caption: "Trusted payouts for local teams",
          cta: "Schedule a Consultation",
          hashtagsOrdered: ["#payouts", "#local"],
        },
      ],
    });
    expect(computeCopyHashSha256(base)).not.toBe(computeCopyHashSha256(variant));
  });

  it("is hashtag-order-sensitive and internal-whitespace-sensitive", () => {
    const reordered = canonicalizeMessagePackCopy({
      ...base,
      platformCaptionsOrdered: [
        {
          platform: "Instagram",
          caption: "Trusted payouts for local teams",
          cta: "Learn More",
          hashtagsOrdered: ["#local", "#payouts"],
        },
      ],
    });
    const whitespace = canonicalizeMessagePackCopy({
      ...base,
      subheadline: "For  operations managers",
    });
    expect(computeCopyHashSha256(base)).not.toBe(computeCopyHashSha256(reordered));
    expect(computeCopyHashSha256(base)).not.toBe(computeCopyHashSha256(whitespace));
  });
});
