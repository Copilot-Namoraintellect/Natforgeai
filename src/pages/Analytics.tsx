import { useMemo } from "react";
import { trpc } from "@/providers/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  BarChart3,
  Users,
  Megaphone,
  PenTool,
  DollarSign,
  Eye,
  MousePointer,
} from "lucide-react";

export default function Analytics() {
  const { data: summary, isLoading } = trpc.analytics.summary.useQuery();

  const stats = useMemo(() => {
    if (!summary) return [];

    const totalCampaigns = summary.campaigns?.length ?? 0;
    const activeCampaigns = summary.campaigns?.filter((c: any) => c.status === "active").length ?? 0;
    const totalLeads = summary.leads?.length ?? 0;
    const wonLeads = summary.leads?.filter((l: any) => l.status === "won").length ?? 0;
    const totalContent = summary.content?.length ?? 0;

    return [
      {
        label: "Total Campaigns",
        value: totalCampaigns,
        change: `${activeCampaigns} active`,
        icon: Megaphone,
        color: "text-indigo-500",
        bg: "bg-indigo-500/10",
      },
      {
        label: "Total Leads",
        value: totalLeads,
        change: `${wonLeads} won`,
        icon: Users,
        color: "text-emerald-500",
        bg: "bg-emerald-500/10",
      },
      {
        label: "Content Pieces",
        value: totalContent,
        change: "All time",
        icon: PenTool,
        color: "text-amber-500",
        bg: "bg-amber-500/10",
      },
      {
        label: "Conversion Rate",
        value: totalLeads > 0 ? `${Math.round((wonLeads / totalLeads) * 100)}%` : "0%",
        change: wonLeads > 0 ? "+ Growing" : "Start converting",
        icon: BarChart3,
        color: "text-purple-500",
        bg: "bg-purple-500/10",
      },
    ];
  }, [summary]);

  // Campaign status breakdown
  const campaignStatusData = useMemo(() => {
    if (!summary?.campaigns) return [];
    const counts: Record<string, number> = {};
    summary.campaigns.forEach((c: any) => {
      counts[c.status] = (counts[c.status] || 0) + 1;
    });
    return Object.entries(counts).map(([status, count]) => ({
      status,
      count,
      percentage: Math.round((count / summary.campaigns.length) * 100),
    }));
  }, [summary]);

  // Lead status breakdown
  const leadStatusData = useMemo(() => {
    if (!summary?.leads) return [];
    const counts: Record<string, number> = {};
    summary.leads.forEach((l: any) => {
      counts[l.status] = (counts[l.status] || 0) + 1;
    });
    const total = summary.leads.length;
    return Object.entries(counts).map(([status, count]) => ({
      status,
      count,
      percentage: Math.round((count / total) * 100),
    }));
  }, [summary]);

  const statusColors: Record<string, string> = {
    draft: "bg-amber-500",
    active: "bg-emerald-500",
    paused: "bg-orange-500",
    completed: "bg-blue-500",
    new: "bg-blue-500",
    contacted: "bg-amber-500",
    qualified: "bg-indigo-500",
    proposal: "bg-purple-500",
    negotiation: "bg-orange-500",
    won: "bg-emerald-500",
    lost: "bg-red-500",
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="p-6 h-24" />
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Analytics</h1>
        <p className="text-muted-foreground mt-1">
          Track your marketing performance and growth.
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((stat) => (
          <Card key={stat.label}>
            <CardContent className="p-5">
              <div className="flex items-start justify-between">
                <div className={`p-2.5 rounded-lg ${stat.bg}`}>
                  <stat.icon className={`w-5 h-5 ${stat.color}`} />
                </div>
                <span className="text-xs text-muted-foreground">{stat.change}</span>
              </div>
              <div className="mt-4">
                <p className="text-2xl font-bold">{stat.value}</p>
                <p className="text-sm text-muted-foreground">{stat.label}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Campaign Performance */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Megaphone className="w-4 h-4 text-indigo-500" />
              Campaign Status Breakdown
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {campaignStatusData.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">
                No campaigns yet. Create your first campaign to see analytics.
              </p>
            ) : (
              campaignStatusData.map((item) => (
                <div key={item.status}>
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2">
                      <div
                        className={`w-2.5 h-2.5 rounded-full ${
                          statusColors[item.status] || "bg-gray-400"
                        }`}
                      />
                      <span className="text-sm font-medium capitalize">
                        {item.status}
                      </span>
                    </div>
                    <span className="text-sm text-muted-foreground">
                      {item.count} ({item.percentage}%)
                    </span>
                  </div>
                  <Progress
                    value={item.percentage}
                    className="h-2"
                  />
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Users className="w-4 h-4 text-emerald-500" />
              Lead Pipeline
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {leadStatusData.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">
                No leads yet. Start adding leads to track your pipeline.
              </p>
            ) : (
              leadStatusData.map((item) => (
                <div key={item.status}>
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2">
                      <div
                        className={`w-2.5 h-2.5 rounded-full ${
                          statusColors[item.status] || "bg-gray-400"
                        }`}
                      />
                      <span className="text-sm font-medium capitalize">
                        {item.status}
                      </span>
                    </div>
                    <span className="text-sm text-muted-foreground">
                      {item.count} ({item.percentage}%)
                    </span>
                  </div>
                  <Progress
                    value={item.percentage}
                    className="h-2"
                  />
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {/* Content Performance */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <PenTool className="w-4 h-4 text-amber-500" />
            Content Distribution
          </CardTitle>
        </CardHeader>
        <CardContent>
          {(!summary?.content || summary.content.length === 0) ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              No content created yet. Start generating content to see distribution.
            </p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
              {(() => {
                const counts: Record<string, number> = {};
                summary.content.forEach((c: any) => {
                  counts[c.type] = (counts[c.type] || 0) + 1;
                });
                return Object.entries(counts).map(([type, count]) => {
                  const total = summary.content.length;
                  const pct = Math.round((count / total) * 100);
                  return (
                    <div key={type} className="text-center">
                      <div className="relative w-16 h-16 mx-auto mb-2">
                        <svg className="w-16 h-16 -rotate-90" viewBox="0 0 36 36">
                          <path
                            className="text-muted"
                            d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="3"
                          />
                          <path
                            className="text-indigo-500"
                            d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="3"
                            strokeDasharray={`${pct}, 100`}
                          />
                        </svg>
                        <span className="absolute inset-0 flex items-center justify-center text-sm font-bold">
                          {count}
                        </span>
                      </div>
                      <p className="text-xs font-medium capitalize">{type.replace("_", " ")}</p>
                      <p className="text-xs text-muted-foreground">{pct}%</p>
                    </div>
                  );
                });
              })()}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Quick Tips */}
      <Card className="bg-gradient-to-br from-indigo-500/5 to-purple-600/5 border-indigo-500/20">
        <CardHeader>
          <CardTitle className="text-base">Performance Tips</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg bg-indigo-500/10">
                <Eye className="w-4 h-4 text-indigo-500" />
              </div>
              <div>
                <p className="text-sm font-medium">Increase Visibility</p>
                <p className="text-xs text-muted-foreground">
                  Post consistently across platforms to maximize reach.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg bg-emerald-500/10">
                <MousePointer className="w-4 h-4 text-emerald-500" />
              </div>
              <div>
                <p className="text-sm font-medium">Boost Conversions</p>
                <p className="text-xs text-muted-foreground">
                  Use clear CTAs and urgency in your content.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg bg-amber-500/10">
                <DollarSign className="w-4 h-4 text-amber-500" />
              </div>
              <div>
                <p className="text-sm font-medium">Optimize Spend</p>
                <p className="text-xs text-muted-foreground">
                  Focus budget on top-performing campaigns and platforms.
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
