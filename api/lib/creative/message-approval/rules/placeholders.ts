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
  const text = [copy.headline, copy.subheadline, ...copy.benefitBulletsOrdered, copy.cta].join("\n");
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
