import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import {
  CheckCircle,
  XCircle,
  Edit3,
  AlertTriangle,
  Shield,
  Sparkles,
  Loader2,
  Users,
  Target,
  MessageSquare,
  Wallet,
  Megaphone,
  Lightbulb,
} from "lucide-react";

const riskLevelConfig = {
  low: { color: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20", icon: Shield },
  medium: { color: "bg-amber-500/10 text-amber-600 border-amber-500/20", icon: AlertTriangle },
  high: { color: "bg-red-500/10 text-red-600 border-red-500/20", icon: AlertTriangle },
};

const approvalTypeLabels: Record<string, string> = {
  campaign_launch: "Campaign Launch",
  budget_increase: "Budget Increase",
  sensitive_reply: "Sensitive Public Reply",
  high_value_proposal: "High-Value Lead Proposal",
  ad_spend: "Paid Ad Spend",
  shutdown: "Campaign Shutdown",
  brand_risk: "Brand Risk Content",
  strategy_review: "Strategy Review",
};

export default function ApprovalCentre() {
  const utils = trpc.useUtils();
  const [selectedApproval, setSelectedApproval] = useState<any>(null);
  const [notes, setNotes] = useState("");
  const [actionType, setActionType] = useState<"approve" | "reject" | "edit" | null>(null);

  const { data: approvals, isLoading } = trpc.approval.listApprovals.useQuery();

  const approveMutation = trpc.approval.approveAction.useMutation({
    onSuccess: () => {
      toast.success("Approved successfully");
      utils.approval.listApprovals.invalidate();
      setSelectedApproval(null);
      setNotes("");
      setActionType(null);
    },
    onError: (err) => toast.error(err.message || "Failed to approve"),
  });

  const rejectMutation = trpc.approval.rejectAction.useMutation({
    onSuccess: () => {
      toast.success("Rejected successfully");
      utils.approval.listApprovals.invalidate();
      setSelectedApproval(null);
      setNotes("");
      setActionType(null);
    },
    onError: (err) => toast.error(err.message || "Failed to reject"),
  });

  const pendingApprovals = approvals?.filter((a) => a.status === "pending") || [];
  const resolvedApprovals = approvals?.filter((a) => a.status !== "pending") || [];

  function StrategyDetails({ campaignId }: { campaignId?: number | null }) {
    const { data: campaign } = trpc.campaign.get.useQuery(
      { id: campaignId ?? 0 },
      { enabled: !!campaignId }
    );
    if (!campaign) return <p className="text-sm text-gray-400">Loading strategy...</p>;

    const campaignAny = campaign as any;
    const ctx = (campaignAny.workflowContext || {}) as any;
    const personas = (campaignAny.personas || []) as any[];
    const offers = (campaignAny.offers || []) as any[];
    const budget = ctx.budgetRecommendation;

    return (
      <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-2">
        {personas.length > 0 && (
          <div className="p-3 rounded-lg bg-[#0F172A] border border-[#334155]">
            <div className="flex items-center gap-2 mb-2">
              <Users className="w-4 h-4 text-[#00D4FF]" />
              <span className="text-xs font-medium text-[#00D4FF]">Target Audience / Personas</span>
            </div>
            <div className="space-y-2">
              {personas.slice(0, 3).map((p: any, i: number) => (
                <div key={i} className="text-xs text-gray-300">
                  <span className="font-medium text-white">{p.name}</span>
                  {p.demographics && <span className="text-gray-500"> — {p.demographics}</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {ctx.positioning && (
          <div className="p-3 rounded-lg bg-[#0F172A] border border-[#334155]">
            <div className="flex items-center gap-2 mb-2">
              <Target className="w-4 h-4 text-purple-400" />
              <span className="text-xs font-medium text-purple-400">Positioning</span>
            </div>
            <p className="text-xs text-gray-300">{ctx.positioning}</p>
          </div>
        )}

        {campaign.coreMessage && (
          <div className="p-3 rounded-lg bg-[#0F172A] border border-[#334155]">
            <div className="flex items-center gap-2 mb-2">
              <MessageSquare className="w-4 h-4 text-emerald-400" />
              <span className="text-xs font-medium text-emerald-400">Core Message</span>
            </div>
            <p className="text-xs text-gray-300">{campaign.coreMessage}</p>
          </div>
        )}

        {ctx.valueProposition && (
          <div className="p-3 rounded-lg bg-[#0F172A] border border-[#334155]">
            <div className="flex items-center gap-2 mb-2">
              <Lightbulb className="w-4 h-4 text-amber-400" />
              <span className="text-xs font-medium text-amber-400">Value Proposition</span>
            </div>
            <p className="text-xs text-gray-300">{ctx.valueProposition}</p>
          </div>
        )}

        {ctx.platformStrategy && Array.isArray(ctx.platformStrategy) && ctx.platformStrategy.length > 0 && (
          <div className="p-3 rounded-lg bg-[#0F172A] border border-[#334155]">
            <div className="flex items-center gap-2 mb-2">
              <Megaphone className="w-4 h-4 text-cyan-400" />
              <span className="text-xs font-medium text-cyan-400">Platform Strategy</span>
            </div>
            <div className="space-y-1">
              {ctx.platformStrategy.slice(0, 4).map((ps: any, i: number) => (
                <p key={i} className="text-xs text-gray-300">
                  <span className="font-medium text-white">{ps.platform}:</span> {ps.purpose}
                </p>
              ))}
            </div>
          </div>
        )}

        {campaignAny.campaignTheme && (
          <div className="p-3 rounded-lg bg-[#0F172A] border border-[#334155]">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles className="w-4 h-4 text-pink-400" />
              <span className="text-xs font-medium text-pink-400">Content Themes</span>
            </div>
            <p className="text-xs text-gray-300">{campaignAny.campaignTheme}</p>
          </div>
        )}

        {offers.length > 0 && (
          <div className="p-3 rounded-lg bg-[#0F172A] border border-[#334155]">
            <div className="flex items-center gap-2 mb-2">
              <Wallet className="w-4 h-4 text-emerald-400" />
              <span className="text-xs font-medium text-emerald-400">Offer / CTA Recommendation</span>
            </div>
            <div className="space-y-1">
              {offers.slice(0, 3).map((o: any, i: number) => (
                <p key={i} className="text-xs text-gray-300">
                  <span className="font-medium text-white">{o.name}:</span> {o.description}
                </p>
              ))}
            </div>
          </div>
        )}

        {campaignAny.ctaStrategy && (
          <div className="p-3 rounded-lg bg-[#0F172A] border border-[#334155]">
            <div className="flex items-center gap-2 mb-2">
              <Target className="w-4 h-4 text-red-400" />
              <span className="text-xs font-medium text-red-400">CTA Strategy</span>
            </div>
            <p className="text-xs text-gray-300 whitespace-pre-line">{campaignAny.ctaStrategy}</p>
          </div>
        )}

        {budget && (
          <div className="p-3 rounded-lg bg-[#0F172A] border border-[#334155]">
            <div className="flex items-center gap-2 mb-2">
              <Wallet className="w-4 h-4 text-indigo-400" />
              <span className="text-xs font-medium text-indigo-400">Budget Guidance</span>
            </div>
            <p className="text-xs text-gray-300">
              Recommended total: <span className="font-medium text-white">${budget.total?.toLocaleString?.() || budget.total}</span>
            </p>
            {budget.allocation && (
              <div className="mt-1 space-y-0.5">
                {budget.allocation.slice(0, 4).map((a: any, i: number) => (
                  <p key={i} className="text-xs text-gray-400">
                    {a.channel}: ${a.amount?.toLocaleString?.() || a.amount} ({a.percentage}%)
                  </p>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  const handleAction = () => {
    if (!selectedApproval || !actionType) return;

    if (actionType === "approve") {
      approveMutation.mutate({ approvalId: selectedApproval.id, notes: notes || undefined });
    } else if (actionType === "reject") {
      rejectMutation.mutate({ approvalId: selectedApproval.id, notes: notes || undefined });
    }
  };

  const isProcessing = approveMutation.isPending || rejectMutation.isPending;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <CheckCircle className="w-6 h-6 text-[#00D4FF]" />
            Approval Centre
          </h1>
          <p className="text-gray-400 mt-1">
            Review and approve critical AI decisions
          </p>
        </div>
        <Badge className="bg-[#00D4FF]/10 text-[#00D4FF] border-[#00D4FF]/20 px-3 py-1">
          {pendingApprovals.length} Pending
        </Badge>
      </div>

      {/* Pending Approvals */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold text-white">Pending Approvals</h2>

        {isLoading ? (
          <div className="p-8 text-center text-gray-400">Loading approvals...</div>
        ) : pendingApprovals.length === 0 ? (
          <Card className="bg-[#1E293B] border-[#334155]">
            <CardContent className="p-8 text-center">
              <CheckCircle className="w-12 h-12 text-emerald-500/50 mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-white mb-2">All caught up!</h3>
              <p className="text-gray-400 mb-2">
                No launch approvals are pending right now.
              </p>
              <p className="text-gray-500 text-sm">
                When a campaign reaches a review stage — such as when a strategy is ready or a launch needs approval — it will appear here. You can also review campaigns directly from the Campaigns page.
              </p>
            </CardContent>
          </Card>
        ) : (
          pendingApprovals.map((approval) => {
            const risk = riskLevelConfig[approval.riskLevel as keyof typeof riskLevelConfig];
            const RiskIcon = risk?.icon || Shield;

            return (
              <Card
                key={approval.id}
                className="bg-[#1E293B] border-[#334155] hover:border-[#00D4FF]/30 transition-colors"
              >
                <CardContent className="p-5">
                  <div className="flex items-start justify-between mb-4">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="font-semibold text-white">{approval.title}</h3>
                        <Badge className={`${risk.color} border`}>
                          <RiskIcon className="w-3 h-3 mr-1" />
                          {approval.riskLevel}
                        </Badge>
                      </div>
                      <p className="text-sm text-gray-400">
                        {approvalTypeLabels[approval.approvalType] || approval.approvalType}
                      </p>
                    </div>
                  </div>

                  {approval.description && (
                    <div className="mb-3">
                      <p className="text-sm text-gray-300">{approval.description}</p>
                    </div>
                  )}

                  {approval.approvalType === "strategy_review" && approval.campaignId && (
                    <div className="mb-4">
                      <div className="p-3 rounded-lg bg-[#0F172A] border border-[#334155]">
                        <div className="flex items-center gap-2 mb-2">
                          <Sparkles className="w-3.5 h-3.5 text-purple-400" />
                          <span className="text-xs font-medium text-purple-400">Generated Strategy</span>
                        </div>
                        <StrategyDetails campaignId={approval.campaignId} />
                      </div>
                    </div>
                  )}

                  {approval.aiRecommendation && approval.approvalType !== "strategy_review" && (
                    <div className="p-3 rounded-lg bg-[#0F172A] border border-[#334155] mb-4">
                      <div className="flex items-center gap-2 mb-1">
                        <Sparkles className="w-3.5 h-3.5 text-purple-400" />
                        <span className="text-xs font-medium text-purple-400">AI Recommendation</span>
                      </div>
                      <p className="text-sm text-gray-300">{approval.aiRecommendation}</p>
                    </div>
                  )}

                  <div className="flex items-center gap-3">
                    <Button
                      size="sm"
                      onClick={() => {
                        setSelectedApproval(approval);
                        setActionType("approve");
                      }}
                      className="bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 border border-emerald-500/30"
                    >
                      <CheckCircle className="w-4 h-4 mr-1" />
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setSelectedApproval(approval);
                        setActionType("reject");
                      }}
                      className="border-red-500/30 text-red-400 hover:bg-red-500/10"
                    >
                      <XCircle className="w-4 h-4 mr-1" />
                      Reject
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setSelectedApproval(approval);
                        setActionType("edit");
                      }}
                      className="border-[#334155] text-gray-300 hover:text-white hover:bg-[#334155]"
                    >
                      <Edit3 className="w-4 h-4 mr-1" />
                      Edit & Approve
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>

      {/* Resolved Approvals */}
      {resolvedApprovals.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-white">History</h2>
          <div className="space-y-2">
            {resolvedApprovals.slice(0, 10).map((approval) => (
              <Card key={approval.id} className="bg-[#1E293B]/50 border-[#334155]/50">
                <CardContent className="p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {approval.status === "approved" ? (
                      <CheckCircle className="w-5 h-5 text-emerald-500" />
                    ) : approval.status === "rejected" ? (
                      <XCircle className="w-5 h-5 text-red-500" />
                    ) : (
                      <Edit3 className="w-5 h-5 text-blue-500" />
                    )}
                    <div>
                      <p className="text-sm text-white">{approval.title}</p>
                      <p className="text-xs text-gray-500">
                        {approvalTypeLabels[approval.approvalType] || approval.approvalType} •{" "}
                        {approval.approvedAt
                          ? new Date(approval.approvedAt).toLocaleDateString()
                          : approval.rejectedAt
                          ? new Date(approval.rejectedAt).toLocaleDateString()
                          : "Recently"}
                      </p>
                    </div>
                  </div>
                  <Badge
                    className={
                      approval.status === "approved"
                        ? "bg-emerald-500/10 text-emerald-600"
                        : approval.status === "rejected"
                        ? "bg-red-500/10 text-red-600"
                        : "bg-blue-500/10 text-blue-600"
                    }
                  >
                    {approval.status}
                  </Badge>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Action Dialog */}
      <Dialog open={!!selectedApproval && !!actionType} onOpenChange={() => {
        setSelectedApproval(null);
        setActionType(null);
        setNotes("");
      }}>
        <DialogContent className="bg-[#1E293B] border-[#334155] text-white">
          <DialogHeader>
            <DialogTitle>
              {actionType === "approve" && "Approve Action"}
              {actionType === "reject" && "Reject Action"}
              {actionType === "edit" && "Edit & Approve"}
            </DialogTitle>
            <DialogDescription>
              {selectedApproval?.approvalType === "strategy_review"
                ? "Review the full generated strategy before approving. Your notes will be saved with the approval."
                : "Review the details below before confirming your decision."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <p className="text-sm text-gray-400 mb-1">Action</p>
              <p className="text-white">{selectedApproval?.title}</p>
            </div>
            {selectedApproval?.aiRecommendation && (
              <div>
                <p className="text-sm text-gray-400 mb-1">AI Recommendation</p>
                <p className="text-sm text-gray-300">{selectedApproval.aiRecommendation}</p>
              </div>
            )}
            <div>
              <p className="text-sm text-gray-400 mb-1">Notes (optional)</p>
              <Textarea
                placeholder="Add your notes or feedback..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="bg-[#0F172A] border-[#334155] text-white"
              />
            </div>
            <div className="flex justify-end gap-3">
              <Button
                variant="outline"
                onClick={() => {
                  setSelectedApproval(null);
                  setActionType(null);
                  setNotes("");
                }}
                className="border-[#334155] text-gray-300"
              >
                Cancel
              </Button>
              {actionType === "edit" ? (
                <Button
                  onClick={() => {
                    // For now, edit & approve works same as approve
                    handleAction();
                  }}
                  disabled={isProcessing}
                  className="bg-blue-500 hover:bg-blue-600"
                >
                  {isProcessing && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  Save & Approve
                </Button>
              ) : actionType === "approve" ? (
                <Button
                  onClick={handleAction}
                  disabled={isProcessing}
                  className="bg-emerald-500 hover:bg-emerald-600"
                >
                  {isProcessing && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  Confirm Approve
                </Button>
              ) : (
                <Button
                  onClick={handleAction}
                  disabled={isProcessing}
                  className="bg-red-500 hover:bg-red-600"
                >
                  {isProcessing && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  Confirm Reject
                </Button>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
