// ─── Canonical pre-publish validation authority (WBS13.5) ───
//
// One deterministic, pure validation contract for governed publication. It
// answers a single question before ANY provider call, external side effect,
// credit mutation, credential decryption, or publication-receipt persistence:
//
//     "Is this queue item, with its resolved integration and (for governed
//      execution) its immutable publish package, allowed to proceed to the
//      controlled publication attempt boundary?"
//
// The module is pure by construction: it imports only pure guards/resolvers,
// never touches the database, the network, platform providers, the safety AI,
// or the crypto seam. Callers hand over already-loaded record projections.
//
// ─── Classification of the previously scattered checks ───
//
// REUSED guards (called verbatim, no duplicated logic):
//   - package intactness        → assertPersistedPublishPackageIntact
//                                   (publish-package-contract)
//   - package↔queue binding     → assertPublishPackageMatchesQueueItem
//                                   (publish-package-builder)
//   - payload currentness       → assertPublishPackagePayloadCurrent
//                                   (publish-package-builder)
//   - approval/artifact         → resolveCampaignPublicationReadiness +
//     authority                   buildPublicationReadinessErrorMessage
//                                   (creative/publication-readiness)
//   - media transport shape     → resolvePublicImageUrl (media/url)
//   - adapter platform support  → isPlatformAdapterId (adapters)
//
// NEWLY CENTRALIZED (existed only inline in the publishing runner, or not at
// all — now owned here as the single authority):
//   - queue actionability       (was an inline early return)
//   - safety status evaluation  (was inline; safety EXECUTION stays with the
//                                existing impure checker as a pre-step)
//   - destination pin vs        (was inline in the runner)
//     resolved integration
//   - integration business      (new)
//     ownership
//   - credential presence by    (new — previously only implicit via decrypt
//     platform                    or post-attempt adapter validation)
//   - payload text sufficiency  (new as an explicit check)
//   - governed/legacy path      (new explicit classification)
//     classification
//
// NOT retrofitted: rate limiting, billing/credit deduction, safety AI
// execution, receipt persistence, retry policy. Those keep their owners.
//
// ─── Governed vs legacy ───
//
// The presence of an immutable publish package selects the governed path: the
// package domain runs and the package classification must be "governed" —
// legacy-classified packages are never silently executed as governed. With no
// package the authority runs the legacy path and skips the package domain; the
// remaining domains still apply because the runner performs those checks on
// legacy items today.
//
// ─── Fail-closed order ───
//
// Domains evaluate in one fixed order; the first domain that produces at least
// one issue is the last one evaluated, so the first failure is stable
// regardless of what later data looks like. Within a domain, every independent
// check runs and contributes its own issue (prerequisite-gated, see below).
//
//   1. queue       — item present; actionable (approved/retrying, never
//                    terminal); package↔queue coordinates agree
//   2. approval    — launch approval authority + artifact publishability and
//                    currentness (delegated to the readiness resolver)
//   3. package     — intact fingerprint; understood classification; governed
//                    lineage required on the governed path; frozen payload
//                    still current against the live row
//   4. safety      — persisted safetyStatus governance (high blocks; medium
//                    requires an explicit approval decision)
//   5. integration — resolved row exists; user/business ownership; platform;
//                    destination pin; connected; adapter-supported
//   6. credential  — required encrypted credential material PRESENT per
//                    platform (shape only — nothing is ever decrypted here)
//   7. media       — enough payload to form a provider request: non-empty
//                    text; declared media carries a transportable URL
//
// Prerequisite gating: a missing queue item suppresses every later domain; a
// missing integration emits only integration_missing (credential/media checks
// that need the row are skipped); an intactness failure suppresses the
// classification and currentness reads of the same package; a failed domain
// suppresses all later domains.

import { TRPCError } from "@trpc/server";
import {
  assertPersistedPublishPackageIntact,
  type PublishPackage,
} from "./publish-package-contract";
import {
  assertPublishPackageMatchesQueueItem,
  assertPublishPackagePayloadCurrent,
} from "./publish-package-builder";
import {
  buildPublicationReadinessErrorMessage,
  resolveCampaignPublicationReadiness,
  type CampaignPublicationReadinessReason,
} from "../creative/publication-readiness";
import { resolvePublicImageUrl } from "../media/url";
import { isPlatformAdapterId } from "../integrations/adapters/platform-adapter";

/** Execution path selected by the presence of an immutable publish package. */
export type PrePublishExecutionPath = "governed" | "legacy";

/**
 * Failure domains in canonical evaluation order. The first domain that yields
 * an issue is the first failure.
 */
export const PRE_PUBLISH_DOMAIN_ORDER = [
  "queue",
  "approval",
  "package",
  "safety",
  "integration",
  "credential",
  "media",
] as const;

export type PrePublishFailureDomain = (typeof PRE_PUBLISH_DOMAIN_ORDER)[number];

/**
 * The runner's durable failure-stage vocabulary. Every issue maps onto it so
 * convergence can route authority failures onto the runner's existing
 * audit/queue semantics without a translation layer.
 */
export type PrePublishRunnerFailureStage = "precondition" | "integration" | "media";

/** Stable machine codes — safe to grep, assert on, and persist in metadata. */
export type PrePublishValidationCode =
  | "queue_item_missing"
  | "queue_not_actionable"
  | "queue_package_mismatch"
  | "campaign_missing"
  | "brief_incomplete"
  | "leaflet_missing"
  | "leaflet_stale"
  | "caption_pack_missing"
  | "caption_pack_stale"
  | "selected_artifact_missing"
  | "selected_artifact_stale"
  | "artifact_not_publishable"
  | "artifact_stale"
  | "launch_approval_missing"
  | "publication_authority_missing"
  | "package_not_intact"
  | "package_classification_unrecognized"
  | "package_not_governed"
  | "package_payload_not_current"
  | "safety_high_blocked"
  | "safety_medium_requires_approval"
  | "integration_missing"
  | "integration_wrong_user"
  | "integration_wrong_business"
  | "integration_platform_mismatch"
  | "integration_destination_pin_mismatch"
  | "integration_not_connected"
  | "integration_platform_unsupported"
  | "credential_access_token_missing"
  | "credential_page_token_missing"
  | "credential_business_account_missing"
  | "payload_text_missing"
  | "media_url_missing"
  | "media_url_invalid";

export interface PrePublishValidationIssue {
  readonly domain: PrePublishFailureDomain;
  readonly code: PrePublishValidationCode;
  readonly failureStage: PrePublishRunnerFailureStage;
  /** Safe human-readable reason — never contains secrets or content bodies. */
  readonly message: string;
}

export interface PrePublishValidationResult {
  readonly path: PrePublishExecutionPath;
  readonly ready: boolean;
  /** Issues from the first failing domain only, in deterministic step order. */
  readonly issues: readonly PrePublishValidationIssue[];
  readonly firstFailure: PrePublishValidationIssue | null;
}

// ─── Input projections (callers hand over already-loaded rows) ───

export interface PrePublishQueueItemProjection {
  id: number;
  userId: number;
  campaignId: number | null;
  contentPostId: number | null;
  platform: string;
  integrationId?: number | null;
  status: string;
  safetyStatus?: string | null;
}

export interface PrePublishContentPostProjection {
  id?: number | null;
  campaignId?: number | null;
  hook?: string | null;
  caption?: string | null;
  cta?: string | null;
  imageUrl?: string | null;
  status?: string | null;
  metadata?: unknown;
}

export interface PrePublishIntegrationProjection {
  id: number;
  userId: number;
  businessId?: number | null;
  platform: string;
  status: string;
  accountName?: string | null;
  accessTokenEncrypted?: string | null;
  pageAccessTokenEncrypted?: string | null;
  instagramBusinessAccountId?: string | null;
}

export interface PrePublishValidationInput {
  queueItem: PrePublishQueueItemProjection | null;
  /** Live content row for the queue item's contentPostId, when one exists. */
  contentPost?: PrePublishContentPostProjection | null;
  /** Immutable publish package; its presence selects the governed path. */
  publishPackage?: PublishPackage | null;
  /** Integration row the caller resolved for this queue item, if any. */
  integration?: PrePublishIntegrationProjection | null;
  /** Publication-authority context for the readiness resolver. */
  campaign?: unknown;
  business?: unknown;
  approvals?: unknown[];
  /** Public base URL used to prove media transport readiness. */
  publicAppUrl: string;
}

const ACTIONABLE_STATUSES = new Set(["approved", "retrying"]);

function issue(
  domain: PrePublishFailureDomain,
  code: PrePublishValidationCode,
  failureStage: PrePublishRunnerFailureStage,
  message: string
): PrePublishValidationIssue {
  return { domain, code, failureStage, message };
}

function guardMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Publish package check failed";
}

function readMetadataRecord(metadata: unknown): Record<string, unknown> {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    return metadata as Record<string, unknown>;
  }
  return {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizedPlatform(value: unknown): string {
  return nonEmptyString(value)?.toLowerCase() ?? "";
}

// ─── Domain evaluators ───
// Each returns its issues; an empty array means the domain passed.

function evaluateQueue(input: PrePublishValidationInput): PrePublishValidationIssue[] {
  const item = input.queueItem;
  if (!item) {
    return [
      issue("queue", "queue_item_missing", "precondition", "Publishing queue item not found."),
    ];
  }

  const issues: PrePublishValidationIssue[] = [];
  if (!ACTIONABLE_STATUSES.has(String(item.status || "").trim().toLowerCase())) {
    issues.push(
      issue(
        "queue",
        "queue_not_actionable",
        "precondition",
        `Publishing queue item ${item.id} is not ready for publishing (status: ${item.status}). Terminal or awaiting rows are never re-validated into a provider call.`
      )
    );
  }

  // Governed handoff binding: the package may only be consumed for the exact
  // queue coordinates it was built for (reuses the builder guard verbatim).
  if (input.publishPackage) {
    try {
      assertPublishPackageMatchesQueueItem(input.publishPackage, {
        userId: item.userId,
        campaignId: item.campaignId,
        contentPostId: item.contentPostId,
        platform: item.platform,
        integrationId: item.integrationId ?? null,
      });
    } catch (err) {
      issues.push(issue("queue", "queue_package_mismatch", "precondition", guardMessage(err)));
    }
  }

  return issues;
}

const READINESS_REASON_CODE: Record<CampaignPublicationReadinessReason, PrePublishValidationCode> = {
  campaign_missing: "campaign_missing",
  brief_incomplete: "brief_incomplete",
  leaflet_missing: "leaflet_missing",
  leaflet_stale: "leaflet_stale",
  caption_pack_missing: "caption_pack_missing",
  caption_pack_stale: "caption_pack_stale",
  selected_output_missing: "selected_artifact_missing",
  selected_output_stale: "selected_artifact_stale",
  approval_pending: "launch_approval_missing",
  output_failed: "artifact_not_publishable",
  output_stale: "artifact_stale",
  publication_authority_missing: "publication_authority_missing",
};

function evaluateApproval(input: PrePublishValidationInput): PrePublishValidationIssue[] {
  const item = input.queueItem;
  if (!item) return [];

  // Items not bound to a content post have no publication-authority model on
  // the legacy path; the payload domain fails them closed instead.
  if (item.contentPostId === null || item.contentPostId === undefined) return [];

  const readiness = resolveCampaignPublicationReadiness({
    campaign: input.campaign,
    business: input.business,
    approvals: input.approvals ?? [],
    selectedOutput: { record: input.contentPost ?? null, type: "content_post" },
    requireLaunchApproval: true,
  });

  const uniqueReasons = Array.from(new Set(readiness.reasons));
  return uniqueReasons.map((reason) =>
    issue(
      "approval",
      READINESS_REASON_CODE[reason],
      "precondition",
      buildPublicationReadinessErrorMessage({ ...readiness, ready: false, reasons: [reason] })
    )
  );
}

function evaluatePackage(input: PrePublishValidationInput): PrePublishValidationIssue[] {
  const pkg = input.publishPackage;
  if (!pkg) return [];

  const issues: PrePublishValidationIssue[] = [];

  // 1. Intactness (fingerprint re-derivation over the identity core).
  try {
    assertPersistedPublishPackageIntact(pkg);
  } catch (err) {
    issues.push(issue("package", "package_not_intact", "precondition", guardMessage(err)));
    return issues;
  }

  // 2. Classification understood. The fingerprint covers only the identity
  // core, so a flipped classification would survive intactness — check it
  // explicitly. Governed execution requires governed lineage.
  if (pkg.classification !== "governed" && pkg.classification !== "legacy") {
    issues.push(
      issue(
        "package",
        "package_classification_unrecognized",
        "precondition",
        `Publish package classification "${String(pkg.classification)}" is not understood.`
      )
    );
    return issues;
  }
  if (pkg.classification !== "governed") {
    issues.push(
      issue(
        "package",
        "package_not_governed",
        "precondition",
        `Publish package ${pkg.packageId} is classified legacy (${pkg.legacyReasons.join(", ") || "no reason recorded"}) and cannot be executed on the governed path. Rebuild the package from current governed lineage.`
      )
    );
    return issues;
  }

  // 3. Frozen payload still current against the live row (no semantic
  // re-read/rewrite: the live row is only compared, never recomposed into the
  // payload).
  if (input.contentPost) {
    try {
      assertPublishPackagePayloadCurrent(pkg, input.contentPost);
    } catch (err) {
      issues.push(
        issue("package", "package_payload_not_current", "precondition", guardMessage(err))
      );
    }
  }

  return issues;
}

function evaluateSafety(input: PrePublishValidationInput): PrePublishValidationIssue[] {
  const item = input.queueItem;
  if (!item) return [];

  const safetyStatus = nonEmptyString(item.safetyStatus)?.toLowerCase() ?? null;
  if (safetyStatus === "high") {
    return [
      issue(
        "safety",
        "safety_high_blocked",
        "precondition",
        "Content safety check failed: high risk."
      ),
    ];
  }
  // Medium risk is publishable only under an explicit approval decision; a
  // retrying row has not been granted that decision.
  if (safetyStatus === "medium" && String(item.status).trim().toLowerCase() !== "approved") {
    return [
      issue(
        "safety",
        "safety_medium_requires_approval",
        "precondition",
        "Content safety check flagged medium risk; awaiting approval."
      ),
    ];
  }
  return [];
}

function evaluateIntegration(input: PrePublishValidationInput): PrePublishValidationIssue[] {
  const item = input.queueItem;
  const integration = input.integration;
  if (!item) return [];

  if (!integration) {
    return [
      issue(
        "integration",
        "integration_missing",
        "integration",
        `Admin setup required: no connected ${item.platform} account. Connect the platform in Settings > Integrations first.`
      ),
    ];
  }

  const issues: PrePublishValidationIssue[] = [];
  const queuePlatform = normalizedPlatform(item.platform);
  const integrationPlatform = normalizedPlatform(integration.platform);

  if (integration.userId !== item.userId) {
    issues.push(
      issue(
        "integration",
        "integration_wrong_user",
        "integration",
        `Resolved integration ${integration.id} does not belong to user ${item.userId}.`
      )
    );
  }

  const packageBusinessId = input.publishPackage?.identity.businessId ?? null;
  if (
    packageBusinessId !== null &&
    integration.businessId !== null &&
    integration.businessId !== undefined &&
    integration.businessId !== packageBusinessId
  ) {
    issues.push(
      issue(
        "integration",
        "integration_wrong_business",
        "integration",
        `Resolved integration ${integration.id} belongs to business ${integration.businessId}, but the publish package is bound to business ${packageBusinessId}.`
      )
    );
  }

  if (integrationPlatform !== queuePlatform) {
    issues.push(
      issue(
        "integration",
        "integration_platform_mismatch",
        "integration",
        `Resolved integration platform ${integrationPlatform || "unknown"} does not match the queue platform ${queuePlatform}. A mutable queue or platform field must never redirect publication to another account.`
      )
    );
  }

  const pinnedIntegrationId = input.publishPackage?.identity.destination.integrationId ?? null;
  if (pinnedIntegrationId !== null && integration.id !== pinnedIntegrationId) {
    issues.push(
      issue(
        "integration",
        "integration_destination_pin_mismatch",
        "integration",
        `Publish package is bound to integration ${pinnedIntegrationId}, but the queue item resolved integration ${integration.id}.`
      )
    );
  }

  if (String(integration.status || "").trim().toLowerCase() !== "connected") {
    issues.push(
      issue(
        "integration",
        "integration_not_connected",
        "integration",
        `Integration ${integration.id} is not publishing-ready (status: ${integration.status}). Reconnect the platform in Settings > Integrations.`
      )
    );
  }

  if (!isPlatformAdapterId(integrationPlatform)) {
    issues.push(
      issue(
        "integration",
        "integration_platform_unsupported",
        "integration",
        `Platform ${integrationPlatform || item.platform} is not supported for governed publishing.`
      )
    );
  }

  return issues;
}

/**
 * Credential readiness mirrors the exact credential derivation the runner
 * performs per platform — but as PRESENCE checks over encrypted material only.
 * Nothing is decrypted and no secret ever leaves the projection.
 */
function evaluateCredential(input: PrePublishValidationInput): PrePublishValidationIssue[] {
  const integration = input.integration;
  if (!integration || !input.queueItem) return [];

  const platform = normalizedPlatform(integration.platform);
  const issues: PrePublishValidationIssue[] = [];

  if (!nonEmptyString(integration.accessTokenEncrypted)) {
    issues.push(
      issue(
        "credential",
        "credential_access_token_missing",
        "precondition",
        `Publishing credentials are not ready for ${platform}: the account access token is missing. Reconnect the platform in Settings > Integrations.`
      )
    );
  }

  if (platform === "instagram") {
    if (!nonEmptyString(integration.pageAccessTokenEncrypted)) {
      issues.push(
        issue(
          "credential",
          "credential_page_token_missing",
          "precondition",
          "Instagram publishing is not ready: the Meta page token is missing. Reconnect Meta and ensure a linked Instagram professional account exists."
        )
      );
    }
    if (!nonEmptyString(integration.instagramBusinessAccountId)) {
      issues.push(
        issue(
          "credential",
          "credential_business_account_missing",
          "precondition",
          "Instagram publishing is not ready: the linked Instagram professional account is missing. Reconnect Meta and ensure a linked Instagram professional account exists."
        )
      );
    }
  }

  return issues;
}

function effectiveMediaUrl(input: PrePublishValidationInput): string | null {
  if (input.publishPackage) {
    return input.publishPackage.payload.mediaUrls[0] ?? null;
  }
  const meta = readMetadataRecord(input.contentPost?.metadata);
  return (
    nonEmptyString(meta.imageUrl) ??
    nonEmptyString(input.contentPost?.imageUrl) ??
    null
  );
}

function effectivePayloadText(input: PrePublishValidationInput): string {
  if (input.publishPackage) {
    return input.publishPackage.payload.text;
  }
  const post = input.contentPost;
  return `${post?.hook || ""}\n\n${post?.caption || ""}\n\n${post?.cta || ""}`.trim();
}

function evaluateMedia(input: PrePublishValidationInput): PrePublishValidationIssue[] {
  const item = input.queueItem;
  if (!item) return [];

  const issues: PrePublishValidationIssue[] = [];

  if (!effectivePayloadText(input)) {
    issues.push(
      issue(
        "media",
        "payload_text_missing",
        "media",
        "Publishing payload carries no text; there is not enough information to form a provider request."
      )
    );
  }

  const mediaUrl = effectiveMediaUrl(input);

  if (input.publishPackage?.payload.mediaType && mediaUrl === null) {
    issues.push(
      issue(
        "media",
        "media_url_missing",
        "media",
        `Publishing payload declares ${input.publishPackage.payload.mediaType} media but carries no media URL.`
      )
    );
    return issues;
  }

  if (mediaUrl !== null) {
    const resolved = resolvePublicImageUrl(mediaUrl, input.publicAppUrl);
    if (!resolved.valid || !resolved.publicUrl) {
      issues.push(
        issue(
          "media",
          "media_url_invalid",
          "media",
          `${item.platform} publishing failed: invalid media URL. The media must resolve to a public HTTP(S) URL before any provider call.`
        )
      );
    }
  }

  return issues;
}

// ─── Public contract ───

/**
 * Run the canonical pre-publish validation for one queue item. Deterministic:
 * same projections → same result; the first failure is always the first
 * failing domain in PRE_PUBLISH_DOMAIN_ORDER. Never throws for validation
 * failures — inspect `ready` / `firstFailure`; use assertPrePublishReady when
 * a throwing guard is more convenient.
 */
export function validatePrePublishReadiness(
  input: PrePublishValidationInput
): PrePublishValidationResult {
  const path: PrePublishExecutionPath = input.publishPackage ? "governed" : "legacy";

  const domainEvaluators = [
    evaluateQueue,
    evaluateApproval,
    evaluatePackage,
    evaluateSafety,
    evaluateIntegration,
    evaluateCredential,
    evaluateMedia,
  ] as const;

  const collected: PrePublishValidationIssue[] = [];
  for (const evaluate of domainEvaluators) {
    const issues = evaluate(input);
    if (issues.length > 0) {
      collected.push(...issues);
      break;
    }
  }

  const issues = Object.freeze(collected);
  return {
    path,
    ready: issues.length === 0,
    issues,
    firstFailure: issues[0] ?? null,
  };
}

/**
 * Throwing guard over validatePrePublishReadiness for call sites that already
 * handle TRPCError-shaped precondition failures (the publishing runner's
 * fail-closed path).
 */
export function assertPrePublishReady(result: PrePublishValidationResult): void {
  if (result.ready) return;
  const first = result.firstFailure!;
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: first.message,
    cause: {
      code: first.code,
      domain: first.domain,
      failureStage: first.failureStage,
      path: result.path,
      issues: result.issues.map((i) => ({ code: i.code, domain: i.domain })),
    },
  });
}
