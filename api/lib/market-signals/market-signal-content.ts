// ─── R8-C Market & External Signal Intelligence — content isolation (C3) ───
//
// PURE module: inert-evidence handling and deterministic prompt-injection
// DETECTION for external content. Detection only annotates
// (injectionSuspected + a bounded limitation) — the content is never
// executed, never becomes an instruction, never invokes tools, never reaches
// secrets, never mutates policy/Business DNA/strategy, and never produces a
// downstream effect. There is no LLM in any authority path in this stream.
//
// Defense stance (contract §7): external content is untrusted data. The
// detectors below recognize common injection shapes so the evidence carries
// an honest risk annotation into downstream governance (R8-F may raise risk;
// nothing here widens any authority).

import { MARKET_CONTENT_ISOLATION } from "./market-signal-contract";

export const EXTERNAL_CONTENT_INJECTION_LIMITATION =
  "EXTERNAL_CONTENT_INJECTION_SUSPECTED: source content matches a prompt-injection pattern; treated as inert evidence only." as const;

// ─── Injection-shape detectors (deterministic, bounded, conservative) ───

const INJECTION_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  {
    name: "instruction_override",
    pattern: /ignore (all |any )?(previous|prior|above|preceding) (instructions|prompts|rules)/i,
  },
  {
    name: "role_override",
    pattern: /(you are now|from now on you|new persona|act as|pretend (you are|to be)|jailbreak)/i,
  },
  {
    name: "system_channel_reference",
    pattern: /\b(system prompt|system instructions|developer mode|as an ai (language )?model\b.{0,40}(ignore|disregard))/i,
  },
  {
    name: "tool_invocation",
    pattern: /\b(call|invoke|execute|run)\b[^.\n]{0,40}\b(tool|function|plugin|api)\b|<tool_call|tool_use\W|function_call/i,
  },
  {
    name: "secret_request",
    pattern: /\b(reveal|show|print|exfiltrate|send|leak|disclose)\b.{0,40}\b(api[-_ ]?key|password|passwd|secret|token|credential|env|\.env)\b/i,
  },
  {
    name: "sql_shell_marker",
    pattern: /;\s*(drop|delete|truncate|alter)\s+(table|database)|rm\s+-rf\b|#\!\/|\bchmod\s+777\b|\b(curl|wget)\s+[^\s]*\|\s*(sh|bash)\b/i,
  },
  {
    name: "policy_privilege_phrase",
    pattern: /\b(bypass|disable|turn off)\b.{0,40}\b(rules?|polic(y|ies)|filters?|safeguards?|permissions?|restrictions?)\b/i,
  },
  {
    name: "exfiltration_channel",
    pattern: /\bpost (this|the|your).{0,40}\b(to|at)\b.{0,60}\b(http:\/\/|https:\/\/)/i,
  },
];

export interface ContentIsolationResult {
  /** Always INERT_EVIDENCE — external content is never authority. */
  readonly contentIsolation: typeof MARKET_CONTENT_ISOLATION;
  /** Deterministic annotation; never authority, never blocks truthful storage. */
  readonly injectionSuspected: boolean;
  /** Matched detector names (bounded, deterministic order) — audit metadata. */
  readonly injectionPatterns: readonly string[];
}

/**
 * Scan normalized inert content for injection shapes. Detection is
 * annotation-only: a positive result adds a limitation downstream and may
 * raise R8-F governance risk later; it never alters trust, relevance,
 * confidence, or status, and never suppresses the observed event.
 */
export function assessContentIsolation(claimText: string): ContentIsolationResult {
  const matched: string[] = [];
  for (const detector of INJECTION_PATTERNS) {
    if (detector.pattern.test(claimText)) {
      matched.push(detector.name);
    }
  }
  return {
    contentIsolation: MARKET_CONTENT_ISOLATION,
    injectionSuspected: matched.length > 0,
    injectionPatterns: matched.slice(0, 8),
  };
}
