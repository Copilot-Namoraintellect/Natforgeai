import type { CanonicalMessagePackCopy, MessageQualityIssue } from "../contracts";

const PLACEHOLDER_PATTERNS = [
  /\[your business\]/i,
  /\[your brand\]/i,
  /\[company\]/i,
  /\[product\]/i,
  /\[service\]/i,
  /your business/gi,
  /your brand/gi,
];

export function checkPlaceholderLanguage(copy: CanonicalMessagePackCopy): MessageQualityIssue[] {
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
  ].join("\n");
  const issues: MessageQualityIssue[] = [];

  for (const pattern of PLACEHOLDER_PATTERNS) {
    if (pattern.test(text)) {
      issues.push({
        code: "PLACEHOLDER_LANGUAGE_DETECTED",
        message: "Placeholder language detected in message copy.",
      });
      break;
    }
  }

  return issues;
}
