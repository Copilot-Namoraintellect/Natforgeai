import { Badge } from "@/components/ui/badge";
import {
  ShieldCheck,
  Shield,
  ShieldAlert,
  ShieldX,
  PencilLine,
  Archive,
} from "lucide-react";
import {
  formatGovernanceParent,
  type CreativeGovernanceView,
} from "@/lib/content-studio/governance";

interface CreativeGovernanceBadgeProps {
  view: CreativeGovernanceView;
  /**
   * Also render a subtle badge for non-governed (legacy) records. Defaults to
   * false so legacy surfaces stay unchanged unless they opt in.
   */
  showLegacy?: boolean;
}

function buildTitle(view: CreativeGovernanceView): string | undefined {
  const parts: string[] = [];
  if (view.artifactKind) {
    parts.push(`Artifact: ${view.artifactKind.replace(/_/g, " ")}`);
  }
  if (view.platform) parts.push(`Platform: ${view.platform}`);
  const parent = formatGovernanceParent(view.parent);
  if (parent) parts.push(`Derived from ${parent}`);
  if (view.approvedRevisionId) {
    parts.push(`Approved copy revision: ${view.approvedRevisionId}`);
  }
  if (view.approvedAtIso) {
    parts.push(`Approved: ${new Date(view.approvedAtIso).toLocaleString()}`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * Read-only governance indicator for Creative artifacts reviewed in Content
 * Studio. Surfaces governed vs legacy status, approval/readiness state, and
 * the approved-parent relationship without exposing internal hashes.
 */
export function CreativeGovernanceBadge({
  view,
  showLegacy = false,
}: CreativeGovernanceBadgeProps) {
  const title = buildTitle(view);

  switch (view.approvalState) {
    case "approved":
      return (
        <Badge
          variant="outline"
          className="text-[10px] h-6 border-emerald-200 text-emerald-700 bg-emerald-50 flex items-center gap-1"
          title={title}
        >
          <ShieldCheck className="w-3 h-3" />
          Governed · Approved
        </Badge>
      );
    case "pending":
      return (
        <Badge
          variant="outline"
          className="text-[10px] h-6 border-slate-200 text-slate-600 bg-slate-50 flex items-center gap-1"
          title={title}
        >
          <Shield className="w-3 h-3" />
          Governed · Pending approval
        </Badge>
      );
    case "superseded":
      return (
        <Badge
          variant="outline"
          className="text-[10px] h-6 border-amber-200 text-amber-700 bg-amber-50 flex items-center gap-1"
          title={title}
        >
          <ShieldAlert className="w-3 h-3" />
          Governed · Superseded
        </Badge>
      );
    case "invalidated":
      return (
        <Badge
          variant="outline"
          className="text-[10px] h-6 border-red-200 text-red-700 bg-red-50 flex items-center gap-1"
          title={title}
        >
          <ShieldX className="w-3 h-3" />
          Governed · Invalidated
        </Badge>
      );
    case "reapproval_required":
      return (
        <Badge
          variant="outline"
          className="text-[10px] h-6 border-amber-200 text-amber-700 bg-amber-50 flex items-center gap-1"
          title="The copy was edited after approval. This artifact is no longer publish-ready until it is re-approved."
        >
          <PencilLine className="w-3 h-3" />
          Needs reapproval
        </Badge>
      );
    case "legacy_approved":
      // The page already renders its own "Approved" badge for legacy posts.
      return null;
    case "legacy":
    default:
      if (!showLegacy) return null;
      return (
        <Badge
          variant="outline"
          className="text-[10px] h-6 text-slate-500 flex items-center gap-1"
          title="Created before Creative governance lineage existed. Usable as-is, but carries no governed approval state."
        >
          <Archive className="w-3 h-3" />
          Legacy
        </Badge>
      );
  }
}
