import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Normalize CRLF so multi-line source assertions are line-ending agnostic.
const contentStudioSource = readFileSync(
  path.resolve(here, "../ContentStudio.tsx"),
  "utf8"
).replace(/\r\n/g, "\n");

describe("ContentStudio WBS12.9 governance wiring", () => {
  it("imports the governance adapter and badge component", () => {
    expect(contentStudioSource).toContain(
      'from "@/components/content/CreativeGovernanceBadge"'
    );
    expect(contentStudioSource).toContain(
      'from "@/lib/content-studio/governance"'
    );
  });

  it("renders governance badges on every governed artifact surface", () => {
    const badgeUsages = contentStudioSource.match(/<CreativeGovernanceBadge/g);
    // Content card, caption pack header, campaign asset card, leaflet details.
    expect(badgeUsages).not.toBeNull();
    expect(badgeUsages!.length).toBeGreaterThanOrEqual(4);
  });

  it("shows the reapproval-required state on content cards that lost approval", () => {
    const approvedBadgeIndex = contentStudioSource.indexOf("Approved\n                </Badge>");
    expect(approvedBadgeIndex).toBeGreaterThan(-1);
    const guardIndex = contentStudioSource.indexOf("{!approved && (");
    expect(guardIndex).toBeGreaterThan(-1);
    const governanceBadgeAfterGuard = contentStudioSource.indexOf(
      "<CreativeGovernanceBadge",
      guardIndex
    );
    expect(governanceBadgeAfterGuard).toBeGreaterThan(guardIndex);
  });

  it("keeps the approved-parent relationship visible in leaflet details", () => {
    expect(contentStudioSource).toContain('formatGovernanceParent(governanceView.parent)');
    expect(contentStudioSource).toContain("Derived from {governanceParentLabel}");
    expect(contentStudioSource).toContain("Approved copy revision");
  });

  it("opts legacy-aware surfaces into the legacy badge", () => {
    const legacyBadgeCount = contentStudioSource.match(/<CreativeGovernanceBadge[^>]*showLegacy/g);
    expect(legacyBadgeCount).not.toBeNull();
    expect(legacyBadgeCount!.length).toBeGreaterThanOrEqual(2);
  });
});
