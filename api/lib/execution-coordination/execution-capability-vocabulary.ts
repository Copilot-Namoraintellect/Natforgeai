// ─── R9-X governed B→D capability vocabulary translation ───
//
// R9-B's frozen planning capability vocabulary (CAPABILITY_REGISTRY) and
// R9-D's frozen execution capability vocabulary (EXECUTION_CAPABILITIES) are
// different closed namespaces. D's stream was built against a mocked B
// contract; at R9-X integration the real B task rows carry planning
// capabilities. This module is the single, code-level, deterministic
// translation boundary at D's consumption seam:
//
//   - required capabilities (task material) MUST all translate — any
//     unmapped requirement fails closed (CAPABILITY_INVALID), so genuinely
//     unsupported work (whatsapp/sms per R6-X provider truth) can never
//     dispatch;
//   - environment capabilities (plan snapshot contract) are translated with
//     unmapped entries dropped — a planning-environment declaration that has
//     no execution meaning simply is not an execution capability.
//
// Authority is untouched: B still owns planning capability truth, D still
// owns the closed execution registry and adapter selection. This is a
// read-only consumption translation (BIND #2 in
// docs/recovery/r9-x-seam-convergence.md).

import {
  EXECUTION_CAPABILITIES,
  type ExecutionCapability,
} from "./execution-coordination-contract";

/**
 * Deterministic total map over R9-B's closed planning capability registry.
 * Entries marked UNSUPPORTED in B's registry (whatsapp/sms — R6-X provider
 * truth) are deliberately ABSENT: they cannot be translated into any
 * executable capability, so any task requiring them fails closed.
 */
export const PLANNING_TO_EXECUTION_CAPABILITY: Readonly<Record<string, ExecutionCapability>> =
  Object.freeze({
    // Internal planning work — no provider side effect.
    planning_validation: "workflow.run",
    market_research: "workflow.run",
    human_review: "workflow.run",
    governance_evaluation: "workflow.run",
    budget_reallocation: "workflow.run",
    task_scheduling: "workflow.run",
    // Analytics observation — analytics router / metrics.
    analytics_observation: "analytics.record",
    // Content production — Content Studio / image / video generation.
    content_generation: "content.dispatch",
    image_generation: "content.dispatch",
    video_generation: "content.dispatch",
    // Campaign configuration (configuration only — activation governed).
    campaign_configuration: "campaign.activate",
    // Provider-bound capabilities (execution additionally requires R9-F).
    social_publishing: "social.publish",
    email_messaging: "notification.send",
    crm_record_management: "crm.record",
  });

const EXECUTION_CAPABILITY_SET: ReadonlySet<string> = new Set(EXECUTION_CAPABILITIES);

/**
 * Translate one required planning capability to the execution vocabulary.
 * Returns null when the capability is unknown or unsupported (no mapping) —
 * callers fail closed on null.
 */
export function translateRequiredCapability(raw: string): ExecutionCapability | null {
  if (EXECUTION_CAPABILITY_SET.has(raw)) return raw as ExecutionCapability;
  return PLANNING_TO_EXECUTION_CAPABILITY[raw] ?? null;
}

/** Translate a task's required capabilities; null if any cannot translate. */
export function translateRequiredCapabilities(raw: readonly string[]): ExecutionCapability[] | null {
  const out: ExecutionCapability[] = [];
  for (const capability of raw) {
    const translated = translateRequiredCapability(capability);
    if (!translated) return null;
    out.push(translated);
  }
  return out;
}

/**
 * Translate an environment capability set (plan snapshot contract). Unknown
 * or unmapped declarations are dropped — they are not execution
 * capabilities. The result is deduplicated and deterministically ordered.
 */
export function translateEnvironmentCapabilities(raw: readonly string[]): readonly ExecutionCapability[] {
  const out = new Set<ExecutionCapability>();
  for (const capability of raw) {
    const translated = translateRequiredCapability(capability);
    if (translated) out.add(translated);
  }
  return [...out].sort();
}
