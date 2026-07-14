import { safeText } from "./brand-palette";

export type FunnelStage = "awareness" | "consideration" | "conversion" | "retention";

const STAGES: FunnelStage[] = ["awareness", "consideration", "conversion", "retention"];

const DEFAULT_FUNNEL_CTAS: Record<FunnelStage, string> = {
  awareness: "Learn More",
  consideration: "Sign Up for a Free Consultation",
  conversion: "Get Started Today",
  retention: "Join Our Community",
};

export function normalizeCtaText(value: string | null | undefined): string {
  return safeText(value)
    .toLowerCase()
    .replace(/[\s\-_.!?;,:'"()\[\]{}]+/g, " ")
    .trim();
}

export function normalizeFunnelStage(value: string | null | undefined): FunnelStage {
  const clean = safeText(value).toLowerCase();
  if (STAGES.includes(clean as FunnelStage)) return clean as FunnelStage;
  return "awareness";
}

export function inferFunnelStageFromObjective(value: string | null | undefined): FunnelStage {
  const objective = safeText(value).toLowerCase();
  if (/(retain|loyal|renew|upsell|community)/i.test(objective)) return "retention";
  if (/(sale|revenue|convert|purchase|get started|book|quote|lead)/i.test(objective)) return "conversion";
  if (/(consider|evaluate|consult|demo|trial|comparison|research)/i.test(objective)) return "consideration";
  return "awareness";
}

export function extractFunnelCtaMap(raw: string | null | undefined): Record<FunnelStage, string> {
  const map = { ...DEFAULT_FUNNEL_CTAS };
  const text = safeText(raw);
  if (!text) return map;

  let matched = false;
  const stagedPattern = /(Awareness|Consideration|Conversion|Retention)\s*[:\-]\s*(.+?)(?=(?:\s+(?:Awareness|Consideration|Conversion|Retention)\s*[:\-])|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = stagedPattern.exec(text)) !== null) {
    const stage = normalizeFunnelStage(match[1]);
    const cta = safeText(match[2]);
    if (cta) {
      map[stage] = cta;
      matched = true;
    }
  }

  if (!matched) {
    const lines = text
      .split(/\r?\n|\|/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      const lineMatch = line.match(/^(awareness|consideration|conversion|retention)\s*[:\-]\s*(.+)$/i);
      if (!lineMatch) continue;
      const stage = normalizeFunnelStage(lineMatch[1]);
      const cta = safeText(lineMatch[2]);
      if (!cta) continue;
      map[stage] = cta;
      matched = true;
    }
  }

  if (!matched) {
    const fallback = safeText(text);
    if (fallback) {
      const stage = inferFunnelStageFromObjective(text);
      map[stage] = fallback;
    }
  }

  return map;
}

export function selectStageCta(raw: string | null | undefined, objectiveOrStage?: string | null): string {
  const map = extractFunnelCtaMap(raw);
  const clean = safeText(objectiveOrStage).toLowerCase();
  const stage = STAGES.includes(clean as FunnelStage)
    ? normalizeFunnelStage(clean)
    : inferFunnelStageFromObjective(objectiveOrStage);
  return map[stage];
}

export function ctaMatchesSelectedStage(opts: {
  cta: string | null | undefined;
  preferredCta?: string | null;
  objectiveOrStage?: string | null;
}): boolean {
  const selected = normalizeCtaText(selectStageCta(opts.preferredCta, opts.objectiveOrStage));
  if (!selected) return false;
  const cta = normalizeCtaText(opts.cta);
  if (!cta) return false;
  return cta === selected || cta.includes(selected) || selected.includes(cta);
}
