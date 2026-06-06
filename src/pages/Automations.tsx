import { useState } from "react";
import { Link } from "react-router";
import { trpc } from "@/providers/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Zap,
  Plus,
  Play,
  Pause,
  Trash2,
  ArrowRight,
  MessageSquare,
  UserPlus,
  ShoppingCart,
  FileText,
  Clock,
  MousePointer,
  Bot,
  CheckCircle2,
  Loader2,
  AlertCircle,
  Rocket,
} from "lucide-react";
import { toast } from "sonner";

const triggerIcons: Record<string, any> = {
  new_lead: UserPlus,
  new_message: MessageSquare,
  new_purchase: ShoppingCart,
  form_submit: FileText,
  schedule: Clock,
  manual: MousePointer,
};

const triggerLabels: Record<string, string> = {
  new_lead: "New Lead",
  new_message: "New Message",
  new_purchase: "New Purchase",
  form_submit: "Form Submit",
  schedule: "Schedule",
  manual: "Manual",
};

// Maps every possible campaign workflowState to a stable 10-step index.
const WORKFLOW_STEP_MAP: Record<string, number> = {
  business_onboarding: 1,
  strategy_pending: 2,
  strategy_generated: 3,
  request_strategy_changes: 3,
  strategy_approved: 4,
  creatives_generating: 5,
  creatives_ready: 5,
  audience_generating: 6,
  audience_ready: 6,
  schedule_generated: 7,
  launch_approval_required: 8,
  campaign_live: 9,
  engagement_active: 10,
  leads_converting: 10,
  optimisation_active: 10,
  completed: 10,
};

const SYSTEM_STEPS = [
  { id: "business_onboarding", label: "Business Profile Captured" },
  { id: "strategy_pending", label: "Strategy Brief Ready" },
  { id: "strategy_generated", label: "AI Strategy Generated" },
  { id: "strategy_approved", label: "Strategy Approved" },
  { id: "creatives_ready", label: "Creative Assets Ready" },
  { id: "audience_ready", label: "Audience Intelligence Built" },
  { id: "schedule_generated", label: "Publishing Schedule Ready" },
  { id: "launch_approval_required", label: "Launch Approval Requested" },
  { id: "campaign_live", label: "Campaign Live" },
  { id: "optimisation_active", label: "Optimization Loop Active" },
];

function getWorkflowProgress(state: string): { completed: number; total: number; currentStep: number; stepLabel: string } {
  const step = WORKFLOW_STEP_MAP[state] || 1;
  return {
    completed: step,
    total: SYSTEM_STEPS.length,
    currentStep: step,
    stepLabel: SYSTEM_STEPS[step - 1]?.label || "In Progress",
  };
}

function getCampaignAction(state: string) {
  switch (state) {
    case "business_onboarding":
      return { label: "Complete Onboarding", href: "/onboarding", variant: "default" as const };
    case "strategy_pending":
      return { label: "View Progress", href: "/agent-activity", variant: "outline" as const };
    case "strategy_generated":
      return { label: "Review Strategy", href: "/approvals", variant: "default" as const };
    case "request_strategy_changes":
      return { label: "View Feedback", href: "/approvals", variant: "outline" as const };
    case "creatives_generating":
      return { label: "View Generation", href: "/agent-activity", variant: "outline" as const };
    case "creatives_ready":
      return { label: "Review Content", href: "/content", variant: "default" as const };
    case "launch_approval_required":
      return { label: "Approve Launch", href: "/approvals", variant: "default" as const };
    case "campaign_live":
      return { label: "View Analytics", href: "/analytics", variant: "outline" as const };
    default:
      return { label: "View Details", href: "/campaigns", variant: "outline" as const };
  }
}

export default function Automations() {
  const [createOpen, setCreateOpen] = useState(false);
  const utils = trpc.useUtils();

  const { data: automations, isLoading } = trpc.automation.list.useQuery();
  const { data: campaigns, isLoading: campaignsLoading } = trpc.campaign.list.useQuery();
  const activeCampaigns = campaigns?.filter((c) =>
    c.workflowState !== "completed" &&
    c.workflowState !== "business_onboarding"
  ) ?? [];

  const createMutation = trpc.automation.create.useMutation({
    onSuccess: () => {
      utils.automation.list.invalidate();
      setCreateOpen(false);
      toast.success("Automation created!");
    },
  });

  const toggleMutation = trpc.automation.toggle.useMutation({
    onSuccess: (data) => {
      utils.automation.list.invalidate();
      toast.success(data.isActive ? "Automation activated!" : "Automation paused!");
    },
  });

  const deleteMutation = trpc.automation.delete.useMutation({
    onSuccess: () => {
      utils.automation.list.invalidate();
      toast.success("Automation deleted!");
    },
  });

  function handleCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const actions = [
      {
        type: (form.get("action1") as string) || "send_email",
        config: {},
      },
      {
        type: (form.get("action2") as string) || "add_to_crm",
        config: {},
      },
    ];
    createMutation.mutate({
      name: form.get("name") as string,
      description: (form.get("description") as string) || undefined,
      trigger: (form.get("trigger") as any) || "new_lead",
      actions,
    });
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Automations</h1>
          <p className="text-muted-foreground mt-1">
            Monitor system workflows and build your own automations.
          </p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] hover:opacity-90">
              <Plus className="w-4 h-4 mr-2" />
              New Workflow
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Create Automation</DialogTitle>
              <DialogDescription>
                Set up a new automated workflow for your marketing tasks.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-4 mt-4">
              <div>
                <Label>Workflow Name</Label>
                <Input name="name" placeholder="Lead follow-up sequence" required />
              </div>
              <div>
                <Label>Description</Label>
                <Textarea name="description" placeholder="What this automation does..." />
              </div>
              <div>
                <Label>Trigger</Label>
                <Select name="trigger" defaultValue="new_lead">
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="new_lead">New Lead</SelectItem>
                    <SelectItem value="new_message">New Message</SelectItem>
                    <SelectItem value="new_purchase">New Purchase</SelectItem>
                    <SelectItem value="form_submit">Form Submit</SelectItem>
                    <SelectItem value="schedule">Schedule</SelectItem>
                    <SelectItem value="manual">Manual</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Action 1</Label>
                <Select name="action1" defaultValue="send_email">
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="send_email">Send Email</SelectItem>
                    <SelectItem value="send_whatsapp">Send WhatsApp</SelectItem>
                    <SelectItem value="add_to_crm">Add to CRM</SelectItem>
                    <SelectItem value="notify_team">Notify Team</SelectItem>
                    <SelectItem value="create_task">Create Task</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Action 2</Label>
                <Select name="action2" defaultValue="add_to_crm">
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="send_email">Send Email</SelectItem>
                    <SelectItem value="send_whatsapp">Send WhatsApp</SelectItem>
                    <SelectItem value="add_to_crm">Add to CRM</SelectItem>
                    <SelectItem value="notify_team">Notify Team</SelectItem>
                    <SelectItem value="create_task">Create Task</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="submit"
                className="w-full bg-gradient-to-r from-[#00D4FF] to-[#7C3AED]"
                disabled={createMutation.isPending}
              >
                {createMutation.isPending ? "Creating..." : "Create Workflow"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* System Automations — AI Campaign Workflows */}
      <section>
        <div className="flex items-center gap-2 mb-4">
          <Bot className="w-5 h-5 text-[#00D4FF]" />
          <h2 className="text-lg font-semibold text-slate-900">System Automations</h2>
          <Badge variant="outline" className="text-[10px]">AI-Powered</Badge>
        </div>

        {campaignsLoading ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {[1, 2].map((i) => (
              <Card key={i} className="animate-pulse">
                <CardContent className="p-6 h-40" />
              </Card>
            ))}
          </div>
        ) : activeCampaigns.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <Bot className="w-10 h-10 text-muted-foreground mb-3" />
              <p className="text-base font-medium text-slate-900">No active AI workflows</p>
              <p className="text-sm text-muted-foreground mt-1 mb-4 max-w-md text-center">
                Launch your first campaign to see the AI automation pipeline in action.
              </p>
              <Link to="/campaigns">
                <Button className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED]">
                  <Rocket className="w-4 h-4 mr-2" />
                  Launch Campaign
                </Button>
              </Link>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {activeCampaigns.map((campaign) => {
              const progress = getWorkflowProgress(campaign.workflowState);
              const action = getCampaignAction(campaign.workflowState);
              const isLive = campaign.workflowState === "campaign_live";
              const needsApproval =
                campaign.workflowState === "strategy_generated" ||
                campaign.workflowState === "launch_approval_required";

              return (
                <Card key={campaign.id} className="hover:shadow-md transition-all">
                  <CardContent className="p-5">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="font-semibold text-slate-900 truncate">{campaign.name}</h3>
                          {isLive ? (
                            <Badge className="bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20">
                              Live
                            </Badge>
                          ) : needsApproval ? (
                            <Badge className="bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 flex items-center gap-1">
                              <AlertCircle className="w-3 h-3" />
                              Needs approval
                            </Badge>
                          ) : (
                            <Badge variant="secondary">In progress</Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1 capitalize">
                          Current step: {SYSTEM_STEPS.find((s) => s.id === campaign.workflowState)?.label || campaign.workflowState.replace(/_/g, " ")}
                        </p>
                      </div>
                      <Link to={action.href}>
                        <Button
                          size="sm"
                          variant={action.variant}
                          className={
                            action.variant === "default"
                              ? "bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] text-white hover:opacity-90"
                              : ""
                          }
                        >
                          {action.label}
                          <ArrowRight className="w-3.5 h-3.5 ml-1" />
                        </Button>
                      </Link>
                    </div>

                    {/* 10-step progress */}
                    <div className="mt-5">
                      <div className="flex justify-between text-[10px] text-muted-foreground mb-1.5">
                        <span>{progress.stepLabel}</span>
                        <span>{Math.round((progress.completed / progress.total) * 100)}% complete</span>
                      </div>
                      <div className="flex gap-1">
                        {SYSTEM_STEPS.map((s, idx) => {
                          const stepIdx = idx + 1;
                          const completed = stepIdx <= progress.completed;
                          const current = stepIdx === progress.currentStep;
                          return (
                            <div
                              key={s.id}
                              className={`h-2 flex-1 rounded-full transition-colors ${
                                completed
                                  ? current
                                    ? "bg-[#00D4FF]"
                                    : "bg-emerald-500"
                                  : "bg-slate-200"
                              }`}
                              title={s.label}
                            />
                          );
                        })}
                      </div>
                    </div>

                    <div className="mt-4 flex flex-wrap gap-2">
                      {SYSTEM_STEPS.slice(0, progress.currentStep).map((s) => (
                        <span
                          key={s.id}
                          className="inline-flex items-center gap-1 text-[10px] text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-100"
                        >
                          <CheckCircle2 className="w-3 h-3" />
                          {s.label}
                        </span>
                      ))}
                      {progress.currentStep < SYSTEM_STEPS.length && (
                        <span className="inline-flex items-center gap-1 text-[10px] text-slate-600 bg-slate-100 px-2 py-0.5 rounded-full border border-slate-200">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          {SYSTEM_STEPS[progress.currentStep].label}
                        </span>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {/* Custom Automations */}
      <section>
        <div className="flex items-center gap-2 mb-4">
          <Zap className="w-5 h-5 text-[#00D4FF]" />
          <h2 className="text-lg font-semibold text-slate-900">Your Workflows</h2>
        </div>

        {isLoading ? (
          <div className="space-y-4">
            {[1, 2].map((i) => (
              <Card key={i} className="animate-pulse">
                <CardContent className="p-6 h-24" />
              </Card>
            ))}
          </div>
        ) : automations?.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16">
              <Zap className="w-12 h-12 text-muted-foreground mb-4" />
              <p className="text-lg font-medium text-slate-900">No automations yet</p>
              <p className="text-sm text-muted-foreground mt-1 mb-4">
                Create your first workflow to automate repetitive tasks.
              </p>
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="w-4 h-4 mr-2" />
                Create Workflow
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {(automations ?? []).map((auto) => {
              const TriggerIcon = triggerIcons[auto.trigger] || Zap;
              return (
                <Card key={auto.id} className="hover:shadow-md transition-all">
                  <CardContent className="p-5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <div
                          className={`p-3 rounded-lg ${
                            auto.isActive
                              ? "bg-emerald-500/10"
                              : "bg-muted"
                          }`}
                        >
                          <TriggerIcon
                            className={`w-5 h-5 ${
                              auto.isActive ? "text-emerald-600" : "text-muted-foreground"
                            }`}
                          />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="font-semibold text-slate-900">{auto.name}</h3>
                            <Badge
                              variant={auto.isActive ? "default" : "secondary"}
                              className={
                                auto.isActive
                                  ? "bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20"
                                  : ""
                              }
                            >
                              {auto.isActive ? "Active" : "Paused"}
                            </Badge>
                          </div>
                          <p className="text-sm text-muted-foreground mt-0.5">
                            {auto.description || "No description"}
                          </p>
                          <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
                            <span className="flex items-center gap-1">
                              <Zap className="w-3 h-3" />
                              {triggerLabels[auto.trigger] || auto.trigger}
                            </span>
                            <ArrowRight className="w-3 h-3" />
                            <span>
                              {Array.isArray(auto.actions)
                                ? auto.actions.length
                                : 0}{" "}
                              actions
                            </span>
                            {auto.runCount && auto.runCount > 0 && (
                              <span>• {auto.runCount} runs</span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => toggleMutation.mutate({ id: auto.id })}
                        >
                          {auto.isActive ? (
                            <Pause className="w-4 h-4 text-amber-500" />
                          ) : (
                            <Play className="w-4 h-4 text-emerald-500" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-red-500"
                          onClick={() => deleteMutation.mutate({ id: auto.id })}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
