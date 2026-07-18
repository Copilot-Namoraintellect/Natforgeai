import type {
  BusinessDNASnapshot,
  CanonicalMessagePackCopy,
  MessageQualityIssue,
} from "../contracts";

export function checkBrandLanguageConstraints(
  copy: CanonicalMessagePackCopy,
  business: BusinessDNASnapshot
): MessageQualityIssue[] {
  const text = [
    copy.headline,
    copy.subheadline,
    ...copy.benefitBulletsOrdered,
    copy.cta,
    ...copy.proofPointsOrdered,
    ...copy.platformCaptionsOrdered.flatMap((caption) => [
      caption.platform,
      caption.caption,
      caption.cta,
      ...caption.hashtagsOrdered,
    ]),
    copy.footer?.phone || "",
    copy.footer?.whatsapp || "",
    copy.footer?.email || "",
    copy.footer?.website || "",
    copy.footer?.location || "",
  ]
    .join("\n")
    .toLowerCase();

  const violated = business.brandLanguageConstraints.find((constraint) =>
    text.includes(constraint.toLowerCase())
  );

  if (!violated) return [];

  return [
    {
      code: "BRAND_LANGUAGE_VIOLATION",
      message: `Brand language constraint violated: ${violated}.`,
    },
  ];
}
