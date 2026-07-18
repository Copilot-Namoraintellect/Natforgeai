import type { CanonicalMessagePackCopy, MessageQualityIssue } from "../contracts";

const GENERIC_PHRASES = [
  "transform your business",
  "unlock success",
  "unlock your potential",
  "join thousands",
  "limited time",
  "act now",
  "marketing campaign",
  "comprehensive solutions",
];

export function checkGenericLanguage(copy: CanonicalMessagePackCopy): MessageQualityIssue[] {
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

  const hit = GENERIC_PHRASES.find((phrase) => text.includes(phrase));
  if (!hit) return [];

  return [
    {
      code: "GENERIC_LANGUAGE_DETECTED",
      message: `Generic marketing language detected: ${hit}.`,
    },
  ];
}
