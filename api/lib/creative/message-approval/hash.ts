import { createHash } from "crypto";
import type { CanonicalMessagePackCopy } from "./contracts";

function serializeCanonicalCopy(copy: CanonicalMessagePackCopy): string {
  const footer = copy.footer
    ? {
        phone: copy.footer.phone,
        whatsapp: copy.footer.whatsapp,
        email: copy.footer.email,
        website: copy.footer.website,
        location: copy.footer.location,
      }
    : null;

  return JSON.stringify({
    copySchemaVersion: copy.copySchemaVersion,
    headline: copy.headline,
    subheadline: copy.subheadline,
    benefitBulletsOrdered: copy.benefitBulletsOrdered,
    cta: copy.cta,
    footer,
  });
}

export function computeCopyHashSha256(copy: CanonicalMessagePackCopy): string {
  const serialized = serializeCanonicalCopy(copy);
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}
