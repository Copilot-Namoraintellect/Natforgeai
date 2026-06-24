import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Brain,
  Users,
  Target,
  MessageSquare,
  TrendingUp,
  RefreshCw,
  Sparkles,
  AlertTriangle,
  CheckCircle,
  UserPlus,
  ExternalLink,
  Lock,
} from "lucide-react";
import { Link } from "react-router";

interface AudienceIntelligenceOutput {
  executiveSummary?: string;
  discoveredProfiles?: Array<{
    handle?: string;
    platform?: string;
    displayName?: string | null;
    followerCount?: number | null;
    relevanceScore?: number;
    whyRelevant?: string;
    suggestedAngle?: string;
  }>;
  scoredLeads?: unknown[];
  contentResonance?: Array<{
    theme?: string;
    engagementLevel?: "low" | "medium" | "high";
    insight?: string;
  }>;
  nextSteps?: string[];
}

export default function AudienceIntelligence() {
  const [selectedCampaignId, setSelectedCampaignId] = useState<string>("");
  const [activeTab, setActiveTab] = useState("overview");

  const campaignsQuery = trpc.campaign.list.useQuery();
  const usageQuery = trpc.subscription.myUsage.useQuery();
  const utils = trpc.useUtils();

  const isEligible =
    usageQuery.data?.tier?.audienceAgent || usageQuery.data?.tier?.slug === "admin";

  const intelligenceQuery = trpc.agent.getAudienceIntelligence.useQuery(
    { campaignId: Number(selectedCampaignId) },
    { enabled: !!selectedCampaignId }
  );

  const runMutation = trpc.agent.runAudienceIntelligence.useMutation({
    onSuccess: (data) => {
      toast.success("Audience intelligence complete", {
        description: `Discovered ${data.output?.scoredLeads?.length || 0} scored leads.`,
      });
      utils.agent.getAudienceIntelligence.invalidate({ campaignId: Number(selectedCampaignId) });
      utils.lead.list.invalidate();
    },
    onError: (error) => {
      toast.error("Audience intelligence failed", { description: error.message });
    },
  });

  const acceptMutation = trpc.agent.acceptRecommendation.useMutation({
    onSuccess: (data) => {
      toast.success("Lead accepted", { description: `Lead #${data.leadId} created.` });
      utils.agent.getAudienceIntelligence.invalidate({ campaignId: Number(selectedCampaignId) });
      utils.lead.list.invalidate();
    },
    onError: (error) => {
      toast.error("Could not accept lead", { description: error.message });
    },
  });

  const campaigns = campaignsQuery.data || [];
  const isRunning = intelligenceQuery.data?.latestRun?.status === "running" || runMutation.isPending;

  function handleRun() {
    if (!selectedCampaignId) {
      toast.error("Select a campaign first");
      return;
    }
    runMutation.mutate({
      campaignId: Number(selectedCampaignId),
      ingest: true,
      autoCreateLeads: false,
    });
  }

  const scores = intelligenceQuery.data?.scores || [];
  const recommendations = intelligenceQuery.data?.recommendations || [];
  const profiles = intelligenceQuery.data?.profiles || [];
  const signals = intelligenceQuery.data?.signals || [];
  const output = (intelligenceQuery.data?.latestRun?.output || {}) as AudienceIntelligenceOutput;
  const warnings = runMutation.data?.ingestionSummary?.warnings || [];

  const reachOutLeads = scores.filter((s) => s.recommendedAction === "reach_out");
  const nurtureLeads = scores.filter((s) => s.recommendedAction === "nurture");

  function scoreColor(score: number) {
    if (score >= 70) return "bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
    if (score >= 40) return "bg-amber-500/10 text-amber-400 border-amber-500/20";
    return "bg-slate-500/10 text-slate-400 border-slate-500/20";
  }

  function confidenceColor(confidence: string) {
    if (confidence === "high") return "bg-emerald-500/10 text-emerald-400";
    if (confidence === "medium") return "bg-amber-500/10 text-amber-400";
    return "bg-red-500/10 text-red-400";
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Brain className="w-6 h-6 text-[#00D4FF]" />
            Audience Intelligence
          </h1>
          <p className="text-sm text-gray-400 mt-1">
            Discover and score leads from your connected social accounts.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Select value={selectedCampaignId} onValueChange={setSelectedCampaignId}>
            <SelectTrigger className="w-[260px] bg-[#0F172A] border-[#1E293B] text-white">
              <SelectValue placeholder="Select a campaign" />
            </SelectTrigger>
            <SelectContent className="bg-[#0F172A] border-[#1E293B]">
              {campaigns.map((campaign) => (
                <SelectItem key={campaign.id} value={String(campaign.id)}>
                  {campaign.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            onClick={handleRun}
            disabled={!selectedCampaignId || isRunning || !isEligible}
            className="bg-[#00D4FF] hover:bg-[#00D4FF]/90 text-[#0F172A] font-semibold"
          >
            {isRunning ? (
              <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
            ) : !isEligible ? (
              <Lock className="w-4 h-4 mr-2" />
            ) : (
              <Sparkles className="w-4 h-4 mr-2" />
            )}
            {!isEligible ? "Upgrade required" : isRunning ? "Analysing..." : "Discover Leads"}
          </Button>
        </div>
      </div>

      {/* Locked upgrade card */}
      {usageQuery.data && !isEligible && (
        <Card className="bg-gradient-to-r from-[#0F172A] to-[#1E293B] border-[#334155]">
          <CardContent className="p-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div className="flex items-start gap-4">
              <div className="p-3 rounded-xl bg-[#00D4FF]/10">
                <Lock className="w-6 h-6 text-[#00D4FF]" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-white">Audience Intelligence is locked</h3>
                <p className="text-sm text-gray-400 mt-1 max-w-lg">
                  Discover and score leads from your connected social accounts. This feature is
                  available on the Growth and Enterprise plans.
                </p>
              </div>
            </div>
            <Link to="/pricing">
              <Button className="bg-[#00D4FF] hover:bg-[#00D4FF]/90 text-[#0F172A] font-semibold whitespace-nowrap">
                Upgrade plan
              </Button>
            </Link>
          </CardContent>
        </Card>
      )}

      {/* Empty state */}
      {!selectedCampaignId && (
        <Card className="bg-[#0F172A] border-[#1E293B]">
          <CardContent className="py-16 flex flex-col items-center text-center">
            <Target className="w-12 h-12 text-gray-600 mb-4" />
            <h3 className="text-lg font-semibold text-white">Select a campaign</h3>
            <p className="text-sm text-gray-400 max-w-md mt-2">
              Choose a campaign to analyse its audience signals and discover high-fit leads from
              your connected social accounts.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Loading state */}
      {selectedCampaignId && intelligenceQuery.isLoading && (
        <div className="space-y-4">
          <Skeleton className="h-32 w-full bg-[#1E293B]" />
          <Skeleton className="h-64 w-full bg-[#1E293B]" />
        </div>
      )}

      {/* Warnings */}
      {warnings.length > 0 && (
        <Alert className="bg-amber-500/10 border-amber-500/20 text-amber-200">
          <AlertTriangle className="w-4 h-4 text-amber-400" />
          <AlertTitle>Data source notice</AlertTitle>
          <AlertDescription>
            <ul className="list-disc list-inside text-sm mt-1 space-y-1">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {/* Results */}
      {selectedCampaignId && intelligenceQuery.data && (
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="bg-[#0F172A] border border-[#1E293B]">
            <TabsTrigger value="overview" className="data-[state=active]:bg-[#1E293B]">
              Overview
            </TabsTrigger>
            <TabsTrigger value="profiles" className="data-[state=active]:bg-[#1E293B]">
              Profiles
            </TabsTrigger>
            <TabsTrigger value="leads" className="data-[state=active]:bg-[#1E293B]">
              Scored Leads
            </TabsTrigger>
            <TabsTrigger value="outreach" className="data-[state=active]:bg-[#1E293B]">
              Outreach
            </TabsTrigger>
            <TabsTrigger value="resonance" className="data-[state=active]:bg-[#1E293B]">
              Resonance
            </TabsTrigger>
          </TabsList>

          {/* Overview */}
          <TabsContent value="overview" className="space-y-4 mt-4">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <Card className="bg-[#0F172A] border-[#1E293B]">
                <CardContent className="pt-6">
                  <p className="text-sm text-gray-400">Profiles Synced</p>
                  <p className="text-2xl font-bold text-white mt-1">{profiles.length}</p>
                </CardContent>
              </Card>
              <Card className="bg-[#0F172A] border-[#1E293B]">
                <CardContent className="pt-6">
                  <p className="text-sm text-gray-400">Signals</p>
                  <p className="text-2xl font-bold text-white mt-1">{signals.length}</p>
                </CardContent>
              </Card>
              <Card className="bg-[#0F172A] border-[#1E293B]">
                <CardContent className="pt-6">
                  <p className="text-sm text-gray-400">Reach Out</p>
                  <p className="text-2xl font-bold text-emerald-400 mt-1">{reachOutLeads.length}</p>
                </CardContent>
              </Card>
              <Card className="bg-[#0F172A] border-[#1E293B]">
                <CardContent className="pt-6">
                  <p className="text-sm text-gray-400">Nurture</p>
                  <p className="text-2xl font-bold text-amber-400 mt-1">{nurtureLeads.length}</p>
                </CardContent>
              </Card>
            </div>

            {output?.executiveSummary && (
              <Card className="bg-[#0F172A] border-[#1E293B]">
                <CardHeader>
                  <CardTitle className="text-white text-base flex items-center gap-2">
                    <Brain className="w-4 h-4 text-[#00D4FF]" />
                    Executive Summary
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-gray-300 whitespace-pre-line">
                    {output.executiveSummary}
                  </p>
                </CardContent>
              </Card>
            )}

            {output?.nextSteps && output.nextSteps.length > 0 && (
              <Card className="bg-[#0F172A] border-[#1E293B]">
                <CardHeader>
                  <CardTitle className="text-white text-base flex items-center gap-2">
                    <TrendingUp className="w-4 h-4 text-[#00D4FF]" />
                    Recommended Next Steps
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-2">
                    {output.nextSteps.map((step: string, i: number) => (
                      <li key={i} className="text-sm text-gray-300 flex items-start gap-2">
                        <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                        {step}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* Profiles */}
          <TabsContent value="profiles" className="mt-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {profiles.map((profile) => (
                <Card key={profile.id} className="bg-[#0F172A] border-[#1E293B]">
                  <CardHeader>
                    <CardTitle className="text-white text-base flex items-center gap-2">
                      <Users className="w-4 h-4 text-[#00D4FF]" />
                      {profile.displayName || profile.handle || "Unknown profile"}
                    </CardTitle>
                    <CardDescription className="text-gray-400">
                      {profile.platform.replace("_", " ")} • {" "}
                      {profile.followerCount?.toLocaleString() || "0"} followers
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {profile.handle && (
                      <p className="text-sm text-gray-300">@{profile.handle}</p>
                    )}
                    {profile.category && (
                      <Badge variant="outline" className="border-[#334155] text-gray-300">
                        {profile.category}
                      </Badge>
                    )}
                    {profile.url && (
                      <a
                        href={profile.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-[#00D4FF] flex items-center gap-1 hover:underline"
                      >
                        View profile <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </CardContent>
                </Card>
              ))}
              {profiles.length === 0 && (
                <p className="text-sm text-gray-400 col-span-full">
                  No profiles synced yet. Run discovery to ingest connected accounts.
                </p>
              )}
            </div>
          </TabsContent>

          {/* Scored Leads */}
          <TabsContent value="leads" className="mt-4">
            <div className="space-y-4">
              {scores.map((score) => {
                const recommendation = recommendations.find((r) => r.leadScoreId === score.id);
                const isAccepted = !!score.leadId || !!recommendation?.acceptedAt;
                return (
                  <Card key={score.id} className="bg-[#0F172A] border-[#1E293B]">
                    <CardContent className="p-5">
                      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
                        <div className="flex-1">
                          <div className="flex items-center gap-3 flex-wrap">
                            <h3 className="text-base font-semibold text-white">
                              {score.displayName || score.handle || "Unknown lead"}
                            </h3>
                            <Badge className={scoreColor(score.score)}>{score.score}/100</Badge>
                            <Badge className={confidenceColor(score.confidence)}>
                              {score.confidence}
                            </Badge>
                            <Badge variant="outline" className="border-[#334155] text-gray-300">
                              {score.platform}
                            </Badge>
                            {score.recommendedAction === "reach_out" && (
                              <Badge className="bg-emerald-500/10 text-emerald-400">reach out</Badge>
                            )}
                            {score.recommendedAction === "nurture" && (
                              <Badge className="bg-amber-500/10 text-amber-400">nurture</Badge>
                            )}
                          </div>
                          {score.handle && (
                            <p className="text-sm text-gray-400 mt-1">@{score.handle}</p>
                          )}
                          <p className="text-sm text-gray-300 mt-2">{score.explanation}</p>
                          {(() => {
                            const signals = score.signalsSummary as string[] | null | undefined;
                            if (!signals || !Array.isArray(signals)) return null;
                            return (
                              <div className="flex flex-wrap gap-1 mt-2">
                                {signals.map((signal, i) => (
                                  <Badge
                                    key={i}
                                    variant="outline"
                                    className="text-xs border-[#334155] text-gray-400"
                                  >
                                    {signal}
                                  </Badge>
                                ))}
                              </div>
                            );
                          })()}
                        </div>
                        <div className="flex items-start gap-2">
                          {score.recommendedAction === "reach_out" && !isAccepted && (
                            <Button
                              size="sm"
                              onClick={() =>
                                recommendation && acceptMutation.mutate({ recommendationId: recommendation.id })
                              }
                              disabled={acceptMutation.isPending || !recommendation}
                              className="bg-[#00D4FF] hover:bg-[#00D4FF]/90 text-[#0F172A]"
                            >
                              <UserPlus className="w-4 h-4 mr-1" />
                              Accept Lead
                            </Button>
                          )}
                          {isAccepted && (
                            <Badge className="bg-emerald-500/10 text-emerald-400">
                              <CheckCircle className="w-3 h-3 mr-1" />
                              Added to leads
                            </Badge>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
              {scores.length === 0 && (
                <p className="text-sm text-gray-400">
                  No scored leads yet. Run discovery to generate recommendations.
                </p>
              )}
            </div>
          </TabsContent>

          {/* Outreach */}
          <TabsContent value="outreach" className="mt-4">
            <div className="space-y-4">
              {recommendations.map((rec) => (
                <Card key={rec.id} className="bg-[#0F172A] border-[#1E293B]">
                  <CardContent className="p-5">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <div className="flex items-center gap-2">
                        <MessageSquare className="w-4 h-4 text-[#00D4FF]" />
                        <h3 className="text-base font-semibold text-white">
                          {rec.personalisedHook}
                        </h3>
                      </div>
                      <Badge variant="outline" className="border-[#334155] text-gray-300">
                        {rec.channel.replace("_", " ")}
                      </Badge>
                    </div>
                    {rec.angle && <p className="text-sm text-gray-300 mt-2">{rec.angle}</p>}
                    {rec.cta && (
                      <p className="text-sm text-gray-400 mt-1">
                        <span className="text-[#00D4FF]">CTA:</span> {rec.cta}
                      </p>
                    )}
                    {rec.expectedOutcome && (
                      <p className="text-sm text-gray-500 mt-1">Outcome: {rec.expectedOutcome}</p>
                    )}
                    {!rec.acceptedAt && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => acceptMutation.mutate({ recommendationId: rec.id })}
                        disabled={acceptMutation.isPending}
                        className="mt-3 border-[#334155] text-white hover:bg-[#1E293B]"
                      >
                        <UserPlus className="w-4 h-4 mr-1" />
                        Accept Recommendation
                      </Button>
                    )}
                  </CardContent>
                </Card>
              ))}
              {recommendations.length === 0 && (
                <p className="text-sm text-gray-400">
                  No outreach recommendations yet. Run discovery to generate them.
                </p>
              )}
            </div>
          </TabsContent>

          {/* Resonance */}
          <TabsContent value="resonance" className="mt-4">
            <div className="space-y-4">
              {output?.contentResonance?.map((item, i) => (
                <Card key={i} className="bg-[#0F172A] border-[#1E293B]">
                  <CardContent className="p-5">
                    <div className="flex items-center gap-2">
                      <TrendingUp className="w-4 h-4 text-[#00D4FF]" />
                      <h3 className="text-base font-semibold text-white">{item.theme}</h3>
                      <Badge
                        className={
                          item.engagementLevel === "high"
                            ? "bg-emerald-500/10 text-emerald-400"
                            : item.engagementLevel === "medium"
                            ? "bg-amber-500/10 text-amber-400"
                            : "bg-slate-500/10 text-slate-400"
                        }
                      >
                        {item.engagementLevel} engagement
                      </Badge>
                    </div>
                    <p className="text-sm text-gray-300 mt-2">{item.insight}</p>
                  </CardContent>
                </Card>
              ))}
              {(!output?.contentResonance || output.contentResonance.length === 0) && (
                <p className="text-sm text-gray-400">
                  No content resonance insights yet. Run discovery to generate them.
                </p>
              )}
            </div>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
