# Intelligence → Engagement / Opportunity Handoff Contract

> **Stream:** WBS-R5 Stream B (Intent & Sentiment Intelligence)
> **Consumers:** R5-C (Autonomous Engagement), R5-D (Opportunity Detection)
> **Branch:** `feature/r5-b-intent-sentiment` (base `e4493a8`)
> **Status:** ACCEPTED — downstream interpretation authority
> **Rule:** R5-C and R5-D must consume, not redefine, interpretation authority.
> **Upstream (frozen, consumed not merged):** R5-A signal contracts,
> branch `feature/r5-a-social-listening` @ `c9a930e` (§2 identity mapping)

---

## 1. Interpretation identity

- `interpretationId` — sha256 over canonical JSON of
  `{ schemaVersion, businessId, signalId, signalVersion, signalContentHash, classifierVersion }`
  (`api/lib/intelligence/interpretation-identity.ts`). Stable, deterministic,
  server-minted. Downstream must treat it as an opaque immutable reference and key
  their own durable effects by it where idempotency is required.

## 2. Source signal identity

- `signalId` = R5-A `signalKey` (`"sigv1:" + sha256(provider|providerAccountId|externalEventId)`,
  server-minted only) + `signalVersion` = R5-A `ingestionVersion` (integer ≥1) +
  `signalContentHash` (sha256 of the sanitized aligned signal, including R5-A's
  `providerEvidenceHash`).
- `signalType` is R5-A's frozen 11-value set: `comment|reply|mention|reaction|
  direct_message|repost|follow|unfollow|campaign_response|inbound_message|unknown`;
  `platform` ∈ `facebook|instagram|whatsapp|linkedin|twitter|tiktok`;
  `provider` ∈ `meta|linkedin|twitter|tiktok`.
- `businessId` is `number | null`: null mirrors R5-A unattributed signals
  (tenant-scoped, context-free interpretation — never a fabricated linkage).
- One `(businessId, signalId, signalVersion, classifierVersion)` maps to exactly one
  accepted interpretation. A new `signalVersion` or `classifierVersion` mints a new
  `interpretationId`; historical rows are never mutated.

## 3. Controlled intent vocabulary

Closed set (`INTENT_VALUES`): `information_request, purchase_interest,
product_question, service_question, complaint, support_request, praise, objection,
cancellation_or_churn_signal, partnership_interest, recruitment_or_employment, spam,
abuse, irrelevant, unknown`. Downstream must not invent or extend labels; map at their
boundary if needed.

## 4. Sentiment vocabulary

`positive, neutral, negative, mixed, unknown` — deliberately coarse; no false
precision. (Legacy `conversation_messages.sentiment` is a separate, older axis — do not
conflate.)

## 5. Confidence semantics

Bounded ordinal `high|medium|low|unknown` with explicit `confidenceBasis`
(`deterministic_rule | model_self_assessed | insufficient_evidence`). NOT a calibrated
probability — never arithmetic on these values. `overallConfidence` is the ordinal min
of the per-dimension confidences. Governing rules:

- `low`/`unknown` overall ⇒ handling was already gated to `monitor`/`human_review`
  (or `safety_escalation`); such records must not drive autonomous engagement.
- `medium` ⇒ tentative; suitable for ranking, not for unattended execution.
- `high` ⇒ strong, still subject to risk-flag gates below.

## 6. Relevance semantics

`relevant | partially_relevant | not_relevant | unknown`. Deterministic Business DNA
token-overlap when a snapshot exists (authoritative); bounded model hint otherwise.
Context-free records carry `relevance: unknown` + `relevanceConfidence: low` and
`businessDnaSnapshotId: null` — never a fabricated linkage.

## 7. Urgency semantics

`low | normal | high | critical`. Ordinal priority hint for queue ordering; `critical`
combined with negative sentiment implies `high_emotion_escalation` risk classification.

## 8. Topic/category semantics

`topics: string[]` — ≤5 entries, ≤48 chars each, lowercase, no PII, deduped.
Navigation hints only; not authority, not a taxonomy. Downstream must not treat topic
presence as verified categorization.

## 9. Risk flags

Closed set (`RISK_FLAG_VALUES`): `abusive_or_harassing, self_harm_safety_concern,
legal_compliance_sensitive, privacy_sensitive, refund_dispute_or_complaint,
reputational_risk, high_emotion_escalation, spam_or_scam, potential_opportunity,
normal_engagement`. Each entry is `{ flag, evidence }` with sanitized evidence
(≤160 chars). Presence of `self_harm_safety_concern` or `abusive_or_harassing` forces
`safety_escalation`; any other risk flag (except the non-gating
`normal_engagement`/`potential_opportunity`) forces `human_review` — unless a safety
flag already applied. Risk flags are routing hints to policy/human review; they are
not a moderation verdict.

## 10. Opportunity indicators

Closed set (`OPPORTUNITY_INDICATOR_VALUES`): `purchase_intent_detected,
partnership_or_b2b_signal, high_value_praise, support_recovery_moment,
repeat_engagement_signal, none`. Hints for R5-D prioritization — NOT qualified
opportunities, NOT lead scores. `none`/`[]` means no opportunity signal detected.

## 11. Recommended handling classes

`no_action | monitor | candidate_for_engagement | human_review | safety_escalation |
opportunity_candidate`. This is a **classification, never a command**. R5-C/R5-D must
run their own policy gates (R5-E invariants) before any action; `candidate_for_engagement`
does not authorize engagement, and `opportunity_candidate` does not create opportunities.

## 12. Rule vs model source

`source: RULE | MODEL`. `RULE` = deterministic engine only (spam markers, empty text,
non-text signals, deterministic safety triggers) — non-billable, `billingIdentity: null`.
`MODEL` = governed AI boundary. Downstream may weight MODEL records as more
context-sensitive and RULE records as definitive for their class; they must not
re-interpret either.

## 13. Versioning / reinterpretation rules

- Records are immutable (`status: "accepted"`, no update/delete path).
- `classifierVersion` (`intent-sentiment-classifier/v1`) is bound into the identity;
  a classifier change produces NEW rows alongside historical ones. Downstream
  consuming "latest interpretation for signal S" must order by
  `(signalVersion, classifierVersion)` and tolerate multiple rows.
- Replays (duplicate delivery, process restart) return the existing row with
  `replayed: true` semantics — no second model call, no second billing, no second
  audit event.
- Tampered content for an accepted signal version fails closed
  (`InterpretationTamperError`); downstream should treat that as a signal-integrity
  incident, not as new intelligence.

## 14. Evidence references

`evidenceReferences: { kind: signal_excerpt | rule | model | business_dna |
provider_metadata, ref, excerpt? }[]` (≤8, excerpts ≤160 chars, sanitized). Display-only
provenance for explainability; never re-ingested as authority input.

## 15. Billing identity

`billingIdentity: "interpretation:" + sha256("intelligence/interpretation-billing@v1:
{businessId}:{signalId}:{signalVersion}:{signalContentHash}:{classifierVersion}")`
for MODEL records; `null` for RULE records. Registered in
`docs/contracts/financial-reliability-contract.md` §2. Downstream must not charge
against interpretation and must not reuse this keyspace.

## 16. Sensitive-data restrictions

- Social text is NOT in the record: only sanitized excerpts (≤160 chars) inside
  evidence/risk entries. Downstream must not reconstruct full messages from excerpts.
- `explanation` is display-only prose (≤280 chars) — never execute, parse, or
  re-authority it.
- No provider tokens, secrets, credentials, or raw PII appear in any field;
  `userId`/`businessId` are internal ids, not personal data.
- Downstream must apply their own PII handling before surfacing excerpts to users.

## 17. Fields R5-C (engagement) may consume

`interpretationId, signalId, signalVersion, signalType, platform (via source signal),
intent, urgency, sentiment, relevance, overallConfidence, confidenceBasis,
riskFlags, recommendedHandling, evidenceReferences, explanation, businessId,
createdAt`. Gate: act only when `recommendedHandling === candidate_for_engagement`,
`overallConfidence ∈ {medium, high}`, no gating risk flags (§9), and R5-E policy
allows — otherwise `monitor`/`human_review`/`safety_escalation` routing applies.

## 18. Fields R5-D (opportunity) may consume

Everything in §17 plus `opportunityIndicators, topics, businessDnaSnapshotId,
intentConfidence, sentimentConfidence, relevanceConfidence`. Opportunity indicators
are unqualified hints; R5-D owns qualification, scoring, and any lead/opportunity
record creation (explicitly NOT owned by this stream).

## 19. Fields downstream must not mutate

All of them. Interpretation records are immutable. Downstream must not rewrite labels,
confidence, handling, evidence, or identity — reinterpretation is a new versioned row
owned solely by R5-B. Downstream metadata belongs in their own stores keyed by
`interpretationId`.

## 20. Schema / migration dependencies

- `social_interpretations` table (migration `0029_add_social_interpretations`,
  **generated, not executed** as of this contract) — columns mirror §1–§15 query dims;
  full canonical record in the `record` JSON column; `businessId` nullable (§2).
- `agent_runs.agentType` / `ai_usage.agentType` enums extended with `interpretation`
  (same unexecuted migration). Migration execution confirmation = FALSE; R5-F or an
  operator must execute before deployment.
- `AUDIT_EVENT_TYPES` now includes `interpretation_recorded` (code-level, no
  migration needed).
- **R5-X convergence item:** R5-A's provisional `0029_social_listening_foundation`
  (creating `social_signals`/`social_listening_states`) and this stream's provisional
  `0029_add_social_interpretations` **collide at journal idx 29** across the two
  branches. R5-B did not execute, renumber, or duplicate the R5-A artefact. R5-X owns
  final renumbering/journal convergence at integration; downstream must not execute
  either 0029 until then.

## 21. Overlap-risk files

| File | Risk |
|---|---|
| `api/router.ts` | merge hotspot — `intelligence` key registered; rebase carefully |
| `db/schema.ts` / `db/migrations/` | append-only; next migration is `0030_*`; never renumber 0029 |
| `api/lib/agents/runner.ts` | `AgentType` union extended (`interpretation`); coordinate before further changes |
| `api/lib/audit/audit-event.ts` | taxonomy extended (`interpretation_recorded`) |
| `docs/contracts/financial-reliability-contract.md` | §2 registry row added; frozen formats untouched |
| `api/lib/billing/cost-tracker.ts` | estimate map gained `interpretation: 1` |
| `api/lib/engagement/`, `api/lib/audience/` | R5-C/R5-D territory — R5-B does not write here |
| `db/schema.ts` `conversation_messages.sentiment` | legacy enum unchanged; do not align it silently |

## 22. Security / prompt-injection invariants (downstream must preserve)

1. Social text is untrusted data; R5-B already sanitizes/bounds it (4000-char cap,
   unicode normalization, control/format char stripping). Do not bypass by re-ingesting
   raw provider payloads into new model calls without equivalent controls.
2. Model output is schema-validated before persistence; downstream must equally
   validate anything they feed back into a model boundary.
3. `interpretationId`/identities are server-minted; never accept client-supplied
   interpretation identity or ownership.
4. Confidence is ordinal and honesty-enforced: low/unknown never became
   auto-actionable inside R5-B; downstream must not "upgrade" it.
5. Cross-tenant isolation rests on server-side business ownership checks
   (id + userId) — replicate that pattern, never trust caller-scoped queries alone.
6. No record contains raw credentials/tokens; keep it that way when projecting
   records into APIs or logs.
