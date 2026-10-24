/**
 * Provider Capability / Execution Boundary (WBS-R5-C5).
 *
 * The transport-grounded capability authority for engagement actions.
 * Policy (R5-E) pre-checks a conservative fixed capability map; THIS boundary
 * is the final gate actually reached before any provider call: an action the
 * repository cannot transport fails closed here with
 * UNSUPPORTED_PROVIDER_CAPABILITY and never touches a provider.
 *
 * Ground truth (C0 inventory §5): R4 ships publication adapters and one
 * unused WhatsApp sender — no Meta comment/reply sender existed. This stream
 * therefore owns exactly one governed outbound seam (Meta public comment
 * reply, facebook + instagram) with a real transport implementation that is
 * never invoked in tests/CI (provider fakes only). LinkedIn / Twitter /
 * TikTok replies, all private messaging, and all reactions have no
 * repository transport and are reported unsupported — we do not pretend
 * unsupported APIs exist.
 *
 * Provider/account ownership is authoritative: bindings are re-verified
 * from the durable social_integrations row on every execution (owner,
 * business, platform, connected status). A drifted or forged binding fails
 * closed before any external effect.
 */

import { createHash } from "crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import { socialIntegrations } from "@db/schema";
import type { EngagementStoreExecutor } from "./execution-store";

export const ENGAGEMENT_PROVIDER_CONTRACT_VERSION = "engagement/provider-boundary@v1";

export class EngagementProviderError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EngagementProviderError";
    this.code = code;
  }
}

/** Retryable provider failure (rate limit, network, 5xx). Safe to re-attempt. */
export class ProviderTransientError extends EngagementProviderError {
  constructor(message: string) {
    super("PROVIDER_TRANSIENT", message);
    this.name = "ProviderTransientError";
  }
}

/**
 * Outcome unknown (timeout after the request may have landed). NEVER blindly
 * resent: the execution records `ambiguous` and the reconciler must probe the
 * provider by operation identity before any retry.
 */
export class ProviderAmbiguousError extends EngagementProviderError {
  constructor(message: string) {
    super("PROVIDER_AMBIGUOUS", message);
    this.name = "ProviderAmbiguousError";
  }
}

/** Permanent provider refusal (auth, permission, validation). Fail closed. */
export class ProviderPermanentError extends EngagementProviderError {
  constructor(message: string) {
    super("PROVIDER_PERMANENT", message);
    this.name = "ProviderPermanentError";
  }
}

// ─── Capability matrix (closed) ───

export type EngagementTransportId = "meta_comment_reply";

export interface EngagementCapabilityDescriptor {
  actionType: "reply_publicly";
  platform: "facebook" | "instagram";
  transportId: EngagementTransportId;
  /** The integration credential field the transport requires. */
  accountRequirement: "pageAccessTokenEncrypted";
  externalTargetKind: "comment_object_id";
  idempotencySupport: "operation_identity_probe";
  receiptKind: "provider_comment_id";
  maxContentLength: number;
}

/**
 * The ONLY provider-capable engagement capability of this stream. Anything
 * not in this list is unsupported and fails closed — no faked APIs.
 */
export const ENGAGEMENT_PROVIDER_CAPABILITIES: readonly EngagementCapabilityDescriptor[] = [
  {
    actionType: "reply_publicly",
    platform: "facebook",
    transportId: "meta_comment_reply",
    accountRequirement: "pageAccessTokenEncrypted",
    externalTargetKind: "comment_object_id",
    idempotencySupport: "operation_identity_probe",
    receiptKind: "provider_comment_id",
    maxContentLength: 1000,
  },
  {
    actionType: "reply_publicly",
    platform: "instagram",
    transportId: "meta_comment_reply",
    accountRequirement: "pageAccessTokenEncrypted",
    externalTargetKind: "comment_object_id",
    idempotencySupport: "operation_identity_probe",
    receiptKind: "provider_comment_id",
    maxContentLength: 1000,
  },
];

export function resolveEngagementCapability(
  actionType: string,
  platform: string
): EngagementCapabilityDescriptor | null {
  return (
    ENGAGEMENT_PROVIDER_CAPABILITIES.find(
      (entry) => entry.actionType === actionType && entry.platform === platform
    ) ?? null
  );
}

export function assertEngagementCapabilitySupported(input: {
  actionType: string;
  platform: string;
}): EngagementCapabilityDescriptor {
  const capability = resolveEngagementCapability(input.actionType, input.platform);
  if (!capability) {
    throw new EngagementProviderError(
      "UNSUPPORTED_PROVIDER_CAPABILITY",
      `Engagement action ${input.actionType} on ${input.platform} has no repository transport seam; failing closed.`
    );
  }
  return capability;
}

export function isEngagementProviderCapable(actionType: string): boolean {
  return ENGAGEMENT_PROVIDER_CAPABILITIES.some((entry) => entry.actionType === actionType);
}

// ─── Platform → provider mapping (closed, mirrors R5-A vocabulary) ───

export const PLATFORM_PROVIDER: Readonly<Record<string, string>> = {
  facebook: "meta",
  instagram: "meta",
  whatsapp: "meta",
  linkedin: "linkedin",
  twitter: "twitter",
  tiktok: "tiktok",
};

// ─── Binding re-verification (durable, server-side) ───

export interface EngagementBindingView {
  integrationId: number;
  userId: number;
  businessId: number | null;
  platform: string;
  provider: string;
  status: string;
  /** Opaque external account reference (page id / ig business id). */
  providerAccountRef: string | null;
}

/**
 * Re-verify the provider account binding from the durable row. Owner,
 * business, platform and connected status are all re-checked at execution
 * time: a revoked, drifted or cross-business binding fails closed. The
 * returned view never carries token material.
 */
export async function resolveEngagementBinding(
  input: {
    integrationId: number;
    businessId: number;
    userId: number;
    platform: string;
  },
  executor?: EngagementStoreExecutor
): Promise<EngagementBindingView> {
  const db = executor ?? (getDb() as unknown as EngagementStoreExecutor);
  const [row] = (await db
    .select()
    .from(socialIntegrations)
    .where(eq(socialIntegrations.id, input.integrationId))
    .limit(1)) as Array<{
    id: number;
    userId: number;
    businessId: number | null;
    platform: string;
    status: string;
    pageId: string | null;
    instagramBusinessAccountId: string | null;
  }>;

  if (!row) {
    throw new EngagementProviderError(
      "PROVIDER_BINDING_MISMATCH",
      "Provider account binding not found; failing closed."
    );
  }
  if (row.userId !== input.userId) {
    throw new EngagementProviderError(
      "OWNERSHIP_MISMATCH",
      "Provider account binding belongs to a different tenant; failing closed."
    );
  }
  if (row.businessId == null || row.businessId !== input.businessId) {
    throw new EngagementProviderError(
      "OWNERSHIP_MISMATCH",
      "Provider account binding is not owned by the acting business; failing closed."
    );
  }
  if (row.platform !== input.platform) {
    throw new EngagementProviderError(
      "PROVIDER_BINDING_MISMATCH",
      "Provider account binding platform does not match the action platform; failing closed."
    );
  }
  if (row.status !== "connected") {
    throw new EngagementProviderError(
      "PROVIDER_BINDING_MISMATCH",
      `Provider account binding is not connected (status: ${row.status}); failing closed.`
    );
  }

  const provider = PLATFORM_PROVIDER[row.platform];
  if (!provider) {
    throw new EngagementProviderError(
      "UNSUPPORTED_PROVIDER_CAPABILITY",
      `Platform ${row.platform} has no provider mapping; failing closed.`
    );
  }

  return {
    integrationId: row.id,
    userId: row.userId,
    businessId: row.businessId,
    platform: row.platform,
    provider,
    status: row.status,
    providerAccountRef: row.pageId ?? row.instagramBusinessAccountId ?? null,
  };
}

// ─── Stable provider operation identity ───

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export interface ProviderOperationIdentityInput {
  provider: string;
  providerAccountRef: string | null;
  externalTarget: string;
  /** sha256 of the exact accepted response content being delivered. */
  contentHash: string;
}

/**
 * Stable identity for one logical provider operation. Deterministic and
 * content-bound: the same action delivering the same accepted content
 * converges to one identity (reconciliation/dedupe anchor), and a changed
 * response produces a new identity (so a stale approval can never ride a
 * swapped payload).
 */
export function deriveProviderOperationIdentity(
  input: ProviderOperationIdentityInput
): string {
  return (
    "eop_" +
    sha256Hex(
      [
        ENGAGEMENT_PROVIDER_CONTRACT_VERSION,
        input.provider,
        input.providerAccountRef ?? "",
        input.externalTarget,
        input.contentHash,
      ].join("|")
    ).slice(0, 40)
  );
}

// ─── Gateway seam ───

export interface ProviderEngagementRequest {
  operationIdentity: string;
  /** Pre-decrypted access token — stays inside this boundary, never logged. */
  accessToken: string;
  providerAccountRef: string;
  externalTarget: string;
  content: string;
}

export interface ProviderEngagementSuccess {
  outcome: "success";
  /** Bounded provider acknowledgement reference (e.g. comment id). */
  providerExternalReceipt: string;
}

export type ProbeOutcome =
  | { status: "confirmed_success"; providerExternalReceipt: string }
  | { status: "confirmed_absent" }
  | { status: "unknown" };

export interface EngagementProviderGateway {
  readonly transportId: EngagementTransportId;
  replyToComment(request: ProviderEngagementRequest): Promise<ProviderEngagementSuccess>;
  /**
   * Reconciliation probe: ask the provider whether an operation identity
   * already produced an effect. Used after ambiguous outcomes and crashes;
   * a fake implements this from its durable script in tests.
   */
  probeOperation(input: {
    accessToken: string;
    providerAccountRef: string;
    operationIdentity: string;
  }): Promise<ProbeOutcome>;
}

interface MetaTransport {
  postComment(input: {
    pageId: string;
    accessToken: string;
    commentObjectId: string;
    message: string;
  }): Promise<{ providerCommentId: string }>;
  probeComment(input: {
    pageId: string;
    accessToken: string;
    commentObjectId: string;
  }): Promise<{ found: boolean; commentId?: string }>;
}

const META_GRAPH_API_BASE = "https://graph.facebook.com/v18.0";

/**
 * Real Meta Graph transport for public comment replies. Production-only:
 * tests and CI never construct it (provider fakes only, per mission). The
 * transport is the single place that knows Graph endpoint shapes.
 */
export function createMetaTransport(fetchImpl: typeof fetch = fetch): MetaTransport {
  return {
    async postComment({ accessToken, commentObjectId, message }) {
      const response = await fetchImpl(
        `${META_GRAPH_API_BASE}/${encodeURIComponent(commentObjectId)}/comments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, access_token: accessToken }),
        }
      );
      if (response.ok) {
        const body = (await response.json()) as { id?: string };
        if (!body.id) {
          throw new ProviderAmbiguousError("Meta reply succeeded without a comment id.");
        }
        return { providerCommentId: body.id };
      }
      const status = response.status;
      const text = (await response.text()).slice(0, 200);
      if (status === 429 || status >= 500) {
        throw new ProviderTransientError(`Meta reply transient failure (HTTP ${status}).`);
      }
      if (status === 408 || status === 504) {
        throw new ProviderAmbiguousError(`Meta reply ambiguous outcome (HTTP ${status}).`);
      }
      throw new ProviderPermanentError(`Meta reply rejected (HTTP ${status}): ${text}`);
    },
    async probeComment({ accessToken, commentObjectId }) {
      const response = await fetchImpl(
        `${META_GRAPH_API_BASE}/${encodeURIComponent(commentObjectId)}?fields=id&access_token=${encodeURIComponent(accessToken)}`,
        { method: "GET" }
      );
      if (!response.ok) return { found: false };
      const body = (await response.json()) as { id?: string };
      return body.id ? { found: true, commentId: body.id } : { found: false };
    },
  };
}

export function createMetaEngagementGateway(transport: MetaTransport): EngagementProviderGateway {
  return {
    transportId: "meta_comment_reply",
    async replyToComment(request) {
      const result = await transport.postComment({
        pageId: request.providerAccountRef,
        accessToken: request.accessToken,
        commentObjectId: request.externalTarget,
        message: request.content,
      });
      return { outcome: "success", providerExternalReceipt: result.providerCommentId };
    },
    async probeOperation(input) {
      const result = await transport.probeComment({
        pageId: input.providerAccountRef,
        accessToken: input.accessToken,
        commentObjectId: input.operationIdentity,
      });
      return result.found && result.commentId
        ? { status: "confirmed_success", providerExternalReceipt: result.commentId }
        : { status: "confirmed_absent" };
    },
  };
}

/**
 * Scripted fake gateway for deterministic tests (the ONLY gateway used in
 * this stream's suites). The script maps operation identity → behaviour;
 * delivered operations are recorded for assertions. Probe answers from the
 * durable script, modelling the provider-side effect log.
 */
export interface FakeEngagementGatewayScriptEntry {
  outcome: "success" | "transient" | "ambiguous" | "permanent";
  /** Provider acknowledgement when outcome is success. */
  providerExternalReceipt?: string;
}

export function createFakeEngagementGateway(input?: {
  script?: Record<string, FakeEngagementGatewayScriptEntry>;
}) {
  const script = input?.script ?? {};
  const delivered = new Map<string, string>();
  const calls: Array<{ operationIdentity: string; content: string }> = [];

  const gateway: EngagementProviderGateway = {
    transportId: "meta_comment_reply",
    async replyToComment(request) {
      calls.push({ operationIdentity: request.operationIdentity, content: request.content });
      const entry = script[request.operationIdentity] ?? { outcome: "success" as const };
      if (entry.outcome === "transient") {
        throw new ProviderTransientError("fake transient provider failure");
      }
      if (entry.outcome === "ambiguous") {
        // Model a provider-side effect that MAY have landed: record it so a
        // later probe can confirm, unless the script marks it absent.
        if (entry.providerExternalReceipt) {
          delivered.set(request.operationIdentity, entry.providerExternalReceipt);
        }
        throw new ProviderAmbiguousError("fake ambiguous provider outcome");
      }
      if (entry.outcome === "permanent") {
        throw new ProviderPermanentError("fake permanent provider rejection");
      }
      const receipt =
        entry.providerExternalReceipt ??
        `fake-comment-${request.operationIdentity.slice(-8)}`;
      delivered.set(request.operationIdentity, receipt);
      return { outcome: "success", providerExternalReceipt: receipt };
    },
    async probeOperation({ operationIdentity }) {
      const receipt = delivered.get(operationIdentity);
      return receipt
        ? { status: "confirmed_success", providerExternalReceipt: receipt }
        : { status: "confirmed_absent" };
    },
  };

  return { gateway, delivered, calls };
}
