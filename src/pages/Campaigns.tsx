import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Link } from "react-router";
import { useUsage } from "@/hooks/useUsage";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Megaphone,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Eye,
  Target,
  DollarSign,
  Crown,
  AlertCircle,
} from "lucide-react";
import { toast } from "sonner";

export default function Campaigns() {
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [viewCampaign, setViewCampaign] = useState<any>(null);
  const utils = trpc.useUtils();
  const { campaigns: campaignUsage, results: resultUsage, isLoading: usageLoading } = useUsage();

  const { data: campaigns, isLoading } = trpc.campaign.list.useQuery();
  const createMutation = trpc.campaign.create.useMutation({
    onSuccess: () => {
      utils.campaign.list.invalidate();
      utils.subscription.myUsage.invalidate();
      setCreateOpen(false);
      toast.success("Campaign created successfully!");
    },
    onError: (err) => {
      toast.error(err.message || "Failed to create campaign");
    },
  });
  const deleteMutation = trpc.campaign.delete.useMutation({
    onSuccess: () => {
      utils.campaign.list.invalidate();
      toast.success("Campaign deleted!");
    },
  });

  const filtered = campaigns?.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase())
  );

  const statusColors: Record<string, string> = {
    draft: "bg-amber-500/10 text-amber-600",
    active: "bg-emerald-500/10 text-emerald-600",
    paused: "bg-orange-500/10 text-orange-600",
    completed: "bg-blue-500/10 text-blue-600",
  };

  function handleCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    createMutation.mutate({
      name: form.get("name") as string,
      goal: form.get("goal") as string,
      targetAudience: form.get("targetAudience") as string,
      platforms: form.get("platforms") as string,
      budget: Number(form.get("budget")) || undefined,
      coreMessage: form.get("coreMessage") as string,
    });
  }

  const isCampaignLimitReached = campaignUsage.atLimit;

  return (
    <div className="space-y-6">
      {/* Usage Banner */}
      {!usageLoading && (
        <Card className="border-[#00D4FF]/20 bg-gradient-to-r from-[#00D4FF]/5 to-[#7C3AED]/5">
          <CardContent className="p-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#00D4FF] to-[#7C3AED] flex items-center justify-center">
                  <Crown className="w-5 h-5 text-white" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-[#0F172A]">
                    Free Plan Usage
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {campaignUsage.used}/{campaignUsage.limit} campaigns · {resultUsage.used}/{resultUsage.limit} results
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-4 flex-1 max-w-md">
                <div className="flex-1">
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-muted-foreground">Campaigns</span>
                    <span className="font-medium">{campaignUsage.remaining} left</span>
                  </div>
                  <Progress value={campaignUsage.percent} className="h-2" />
                </div>
                <div className="flex-1">
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-muted-foreground">Results</span>
                    <span className="font-medium">{resultUsage.remaining} left</span>
                  </div>
                  <Progress value={resultUsage.percent} className="h-2" />
                </div>
              </div>
              {isCampaignLimitReached && (
                <Button asChild size="sm" className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] hover:opacity-90 text-white shrink-0">
                  <Link to="/pricing">Upgrade</Link>
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Campaigns</h1>
          <p className="text-muted-foreground mt-1">
            Plan, launch, and track your marketing campaigns.
          </p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button
              className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] hover:opacity-90"
              disabled={isCampaignLimitReached}
            >
              <Plus className="w-4 h-4 mr-2" />
              New Campaign
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Create Campaign</DialogTitle>
            </DialogHeader>
            {isCampaignLimitReached ? (
              <div className="py-8 text-center space-y-4">
                <AlertCircle className="w-12 h-12 text-[#7C3AED] mx-auto" />
                <div>
                  <p className="text-lg font-semibold text-[#0F172A]">Campaign Limit Reached</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    You've used all {campaignUsage.limit} campaigns on your free plan.
                  </p>
                </div>
                <Button asChild className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] hover:opacity-90 text-white">
                  <Link to="/pricing" onClick={() => setCreateOpen(false)}>
                    Upgrade to Create More
                  </Link>
                </Button>
              </div>
            ) : (
              <form onSubmit={handleCreate} className="space-y-4 mt-4">
                <div>
                  <Label>Campaign Name</Label>
                  <Input name="name" placeholder="Summer Sale 2025" required />
                </div>
                <div>
                  <Label>Goal</Label>
                  <Input name="goal" placeholder="Increase walk-ins by 30%" required />
                </div>
                <div>
                  <Label>Target Audience</Label>
                  <Textarea name="targetAudience" placeholder="Young professionals aged 25-40..." />
                </div>
                <div>
                  <Label>Platforms</Label>
                  <Input name="platforms" placeholder="Instagram, TikTok, Facebook" />
                </div>
                <div>
                  <Label>Budget ($)</Label>
                  <Input name="budget" type="number" placeholder="5000" />
                </div>
                <div>
                  <Label>Core Message</Label>
                  <Textarea name="coreMessage" placeholder="Your main value proposition..." />
                </div>
                <Button
                  type="submit"
                  className="w-full bg-gradient-to-r from-[#00D4FF] to-[#7C3AED]"
                  disabled={createMutation.isPending}
                >
                  {createMutation.isPending ? "Creating..." : "Create Campaign"}
                </Button>
              </form>
            )}
          </DialogContent>
        </Dialog>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          className="pl-9"
          placeholder="Search campaigns..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Campaigns Grid */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="p-6 h-40" />
            </Card>
          ))}
        </div>
      ) : (filtered ?? []).length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Megaphone className="w-12 h-12 text-muted-foreground mb-4" />
            <p className="text-lg font-medium">No campaigns yet</p>
            <p className="text-sm text-muted-foreground mt-1 mb-4">
              Create your first marketing campaign to get started.
            </p>
            <Button onClick={() => setCreateOpen(true)} disabled={isCampaignLimitReached}>
              <Plus className="w-4 h-4 mr-2" />
              Create Campaign
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {(filtered ?? []).map((camp) => (
            <Card key={camp.id} className="group hover:shadow-lg transition-all">
              <CardContent className="p-5">
                <div className="flex items-start justify-between mb-3">
                  <Badge
                    variant="secondary"
                    className={statusColors[camp.status] || "bg-muted"}
                  >
                    {camp.status}
                  </Badge>
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => setViewCampaign(camp)}
                    >
                      <Eye className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-red-500 hover:text-red-600"
                      onClick={() => deleteMutation.mutate({ id: camp.id })}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
                <h3 className="font-semibold text-base mb-1">{camp.name}</h3>
                <p className="text-sm text-muted-foreground line-clamp-2 mb-3">
                  {camp.goal}
                </p>
                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                  {camp.platforms && (
                    <span className="flex items-center gap-1">
                      <Target className="w-3 h-3" />
                      {camp.platforms}
                    </span>
                  )}
                  {camp.budget && (
                    <span className="flex items-center gap-1">
                      <DollarSign className="w-3 h-3" />
                      {camp.budget.toLocaleString()}
                    </span>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* View Campaign Dialog */}
      {viewCampaign && (
        <Dialog open={!!viewCampaign} onOpenChange={() => setViewCampaign(null)}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{viewCampaign.name}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 mt-4">
              <div className="flex items-center gap-2">
                <Badge className={statusColors[viewCampaign.status] || "bg-muted"}>
                  {viewCampaign.status}
                </Badge>
                {viewCampaign.aiGenerated && (
                  <Badge variant="outline" className="flex items-center gap-1">
                    <Sparkles className="w-3 h-3" />
                    AI Generated
                  </Badge>
                )}
              </div>
              <div>
                <h4 className="text-sm font-semibold mb-1">Goal</h4>
                <p className="text-sm text-muted-foreground">{viewCampaign.goal}</p>
              </div>
              {viewCampaign.targetAudience && (
                <div>
                  <h4 className="text-sm font-semibold mb-1">Target Audience</h4>
                  <p className="text-sm text-muted-foreground">{viewCampaign.targetAudience}</p>
                </div>
              )}
              {viewCampaign.coreMessage && (
                <div>
                  <h4 className="text-sm font-semibold mb-1">Core Message</h4>
                  <p className="text-sm text-muted-foreground">{viewCampaign.coreMessage}</p>
                </div>
              )}
              {viewCampaign.strategy && (
                <div>
                  <h4 className="text-sm font-semibold mb-1">Strategy</h4>
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap">{viewCampaign.strategy}</p>
                </div>
              )}
              {viewCampaign.personas && (
                <div>
                  <h4 className="text-sm font-semibold mb-1">Personas</h4>
                  <pre className="text-xs text-muted-foreground bg-muted p-3 rounded-lg overflow-auto">
                    {JSON.stringify(viewCampaign.personas, null, 2)}
                  </pre>
                </div>
              )}
              <div className="flex gap-3 pt-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    const newStatus =
                      viewCampaign.status === "active" ? "paused" : "active";
                    trpc.campaign.update.useMutation().mutate({
                      id: viewCampaign.id,
                      status: newStatus as any,
                    });
                    setViewCampaign({ ...viewCampaign, status: newStatus });
                  }}
                >
                  {viewCampaign.status === "active" ? "Pause" : "Activate"}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
