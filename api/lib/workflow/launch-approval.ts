import { buildGroundedCreativeBrief } from "../creative/brief-grounding";

/**
 * Durable lineage for campaign_launch approval requests (G-04 fail-closed
 * hardening).
 *
 * A campaign_launch approval is governed human authority: it must never be
 * fabricated by repair automation. The durable record below links a launch
 * approval request to the campaign brief fingerprint it was created for, so
 * that:
 * - repair may recreate a MISSING pending request, but can never convert a
 *   pending/rejected request into an approval decision;
 * - an existing explicit approval is reusable only while the recorded lineage
 *   still matches the request and the current campaign context;
 * - publishing stays blocked until a lineage-corroborated approval exists.
 *
 * Uses the existing structured `workflowContext` JSON column; no migration is
 * required.
 */

export interface LaunchApprovalLineage {
  /** Fingerprint of the campaign brief the launch approval was requested for. */
  creativeBriefFingerprint: string;
  /** ID of the campaign_launch approval request tied to that brief. */
  approvalRequestId: number;
  /** Terminal state of the lineage request. */
  status: "pending" | "approved" | "rejected" | "stale";
}

export interface LaunchApprovalStatus {
  /** Fingerprint of the currently persisted campaign brief. */
  currentFingerprint: string;
  /** Active lineage entry, if any. */
  lineage: LaunchApprovalLineage | null;
  /**
   * True only when a durable approved lineage exists for the current brief.
   * Missing lineage evidence is treated as no authority (fail closed).
   */
  hasApprovedCurrentLaunch: boolean;
}

function readContextString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function readLaunchApprovalLineage(
  ctx: Record<string, unknown> | null | undefined
): LaunchApprovalLineage | null {
  const raw = ctx?.launchApprovalLineage;
  if (!raw || typeof raw !== "object") return null;
  const l = raw as Record<string, unknown>;
  const creativeBriefFingerprint = readContextString(l.creativeBriefFingerprint);
  const approvalRequestId =
    typeof l.approvalRequestId === "number" && Number.isFinite(l.approvalRequestId) ? l.approvalRequestId : null;
  const status =
    typeof l.status === "string" && ["pending", "approved", "rejected", "stale"].includes(l.status)
      ? (l.status as LaunchApprovalLineage["status"])
      : null;

  if (!creativeBriefFingerprint || approvalRequestId == null || !status) return null;
  return { creativeBriefFingerprint, approvalRequestId, status };
}

function getWorkflowContext(campaign: unknown): Record<string, unknown> | null | undefined {
  return campaign && typeof campaign === "object"
    ? ((campaign as Record<string, unknown>).workflowContext as Record<string, unknown> | null | undefined)
    : undefined;
}

function computeCurrentFingerprint(campaign: unknown, business?: unknown): string {
  try {
    return buildGroundedCreativeBrief({ campaign, business }).fingerprint;
  } catch {
    return "";
  }
}

/**
 * Resolve the launch-approval lineage status for a campaign. Fail closed: an
 * approved launch is current only when a durable lineage exists with status
 * "approved" for the same brief fingerprint as the persisted campaign brief.
 */
export function getLaunchApprovalStatus(campaign: unknown, business?: unknown): LaunchApprovalStatus {
  const currentFingerprint = computeCurrentFingerprint(campaign, business);
  const lineage = readLaunchApprovalLineage(getWorkflowContext(campaign));

  const hasApprovedCurrentLaunch =
    !!lineage &&
    lineage.status === "approved" &&
    lineage.creativeBriefFingerprint === currentFingerprint &&
    !!currentFingerprint;

  return { currentFingerprint, lineage, hasApprovedCurrentLaunch };
}

/** Build a fresh launch-approval lineage entry. */
export function buildLaunchApprovalLineage(
  creativeBriefFingerprint: string,
  approvalRequestId: number,
  status: LaunchApprovalLineage["status"] = "pending"
): LaunchApprovalLineage {
  return { creativeBriefFingerprint, approvalRequestId, status };
}

/**
 * True when the campaign's recorded lineage identifies `approvalRequestId` as
 * the current launch approval request and the recorded fingerprint still
 * matches the current brief. Used to authorise an approval decision.
 */
export function isLaunchApprovalAuthoritative(
  campaign: unknown,
  input: { approvalRequestId?: number | null },
  business?: unknown
): boolean {
  const status = getLaunchApprovalStatus(campaign, business);
  const lineage = status.lineage;
  if (!lineage) return false;
  if (!status.currentFingerprint) return false;
  if (lineage.creativeBriefFingerprint !== status.currentFingerprint) return false;
  if (input.approvalRequestId != null && lineage.approvalRequestId !== input.approvalRequestId) return false;
  return true;
}

/**
 * True when an explicit approval ROW is corroborated by durable lineage and
 * campaign context:
 * - the row is a campaign_launch approval in approved/edited state;
 * - the row belongs to the same campaign and user (campaign context match);
 * - the campaign records a launch lineage pointing at this exact request,
 *   marked approved, for the current brief fingerprint.
 *
 * Fail closed: a bare approval row without corroborating lineage is NOT
 * usable evidence of launch authority.
 */
export function isLaunchApprovalEvidenceUsable(
  campaign: unknown,
  approval: unknown,
  business?: unknown
): boolean {
  if (!campaign || typeof campaign !== "object") return false;
  if (!approval || typeof approval !== "object") return false;

  const c = campaign as Record<string, unknown>;
  const a = approval as Record<string, unknown>;

  if (a.approvalType !== "campaign_launch") return false;
  if (a.status !== "approved" && a.status !== "edited") return false;
  if (typeof a.id !== "number" || !Number.isFinite(a.id)) return false;
  if (a.campaignId == null || c.id == null || a.campaignId !== c.id) return false;
  if (a.userId != null && c.userId != null && a.userId !== c.userId) return false;

  const status = getLaunchApprovalStatus(campaign, business);
  const lineage = status.lineage;
  if (!lineage) return false;
  if (lineage.approvalRequestId !== a.id) return false;
  if (lineage.status !== "approved") return false;
  if (lineage.creativeBriefFingerprint !== status.currentFingerprint) return false;
  return true;
}
