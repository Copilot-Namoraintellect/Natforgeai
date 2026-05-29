import { trpc } from "@/providers/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Link } from "react-router";
import {
  Megaphone,
  PenTool,
  Users,
  Zap,
  ArrowRight,
  BarChart3,
  Calendar,
  Sparkles,
} from "lucide-react";

export default function Dashboard() {
  const { data: summary } = trpc.analytics.summary.useQuery();

  const campaignCounts = {
    total: summary?.campaigns?.length ?? 0,
    active: summary?.campaigns?.filter((c: any) => c.status === "active").length ?? 0,
    draft: summary?.campaigns?.filter((c: any) => c.status === "draft").length ?? 0,
  };

  const leadCounts = {
    total: summary?.leads?.length ?? 0,
    new: summary?.leads?.filter((l: any) => l.status === "new").length ?? 0,
    won: summary?.leads?.filter((l: any) => l.status === "won").length ?? 0,
  };

  const contentCounts = {
    total: summary?.content?.length ?? 0,
    social: summary?.content?.filter((c: any) => c.type === "social_post").length ?? 0,
    ads: summary?.content?.filter((c: any) => c.type === "ad_copy").length ?? 0,
  };

  const stats = [
    {
      title: "Campaigns",
      value: campaignCounts.total,
      active: campaignCounts.active,
      icon: Megaphone,
      color: "text-indigo-500",
      bg: "bg-indigo-500/10",
      link: "/campaigns",
    },
    {
      title: "Leads",
      value: leadCounts.total,
      active: leadCounts.new,
      icon: Users,
      color: "text-emerald-500",
      bg: "bg-emerald-500/10",
      link: "/leads",
    },
    {
      title: "Content",
      value: contentCounts.total,
      active: contentCounts.social,
      icon: PenTool,
      color: "text-amber-500",
      bg: "bg-amber-500/10",
      link: "/content",
    },
    {
      title: "Automations",
      value: "0",
      active: "0 running",
      icon: Zap,
      color: "text-purple-500",
      bg: "bg-purple-500/10",
      link: "/automations",
    },
  ];

  const quickActions = [
    { label: "New Campaign", icon: Megaphone, link: "/campaigns", color: "from-indigo-500 to-blue-600" },
    { label: "Create Content", icon: PenTool, link: "/content", color: "from-amber-500 to-orange-600" },
    { label: "Add Lead", icon: Users, link: "/leads", color: "from-emerald-500 to-green-600" },
    { label: "View Calendar", icon: Calendar, link: "/calendar", color: "from-purple-500 to-pink-600" },
  ];

  const recentCampaigns = summary?.campaigns?.slice(0, 4) ?? [];
  const recentLeads = summary?.leads?.slice(0, 4) ?? [];

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground mt-1">
            Welcome back! Here's your marketing overview.
          </p>
        </div>
        <Button asChild className="bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700">
          <Link to="/campaigns">
            <Sparkles className="w-4 h-4 mr-2" />
            New Campaign
          </Link>
        </Button>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((stat) => (
          <Link key={stat.title} to={stat.link}>
            <Card className="hover:shadow-md transition-shadow cursor-pointer group">
              <CardContent className="p-5">
                <div className="flex items-start justify-between">
                  <div className={`p-2.5 rounded-lg ${stat.bg}`}>
                    <stat.icon className={`w-5 h-5 ${stat.color}`} />
                  </div>
                  <ArrowRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
                <div className="mt-4">
                  <p className="text-2xl font-bold">{stat.value}</p>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    {stat.active} active
                  </p>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      {/* Quick Actions */}
      <div>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
          Quick Actions
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {quickActions.map((action) => (
            <Link key={action.label} to={action.link}>
              <Button
                variant="outline"
                className="w-full h-auto py-4 flex flex-col items-center gap-2 hover:border-primary/50 transition-colors"
              >
                <div className={`p-2 rounded-lg bg-gradient-to-br ${action.color}`}>
                  <action.icon className="w-4 h-4 text-white" />
                </div>
                <span className="text-sm font-medium">{action.label}</span>
              </Button>
            </Link>
          ))}
        </div>
      </div>

      {/* Recent Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Campaigns */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <CardTitle className="text-base font-semibold">Recent Campaigns</CardTitle>
            <Button variant="ghost" size="sm" asChild>
              <Link to="/campaigns">View all</Link>
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            {recentCampaigns.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-6">
                No campaigns yet. Create your first one!
              </p>
            )}
            {recentCampaigns.map((camp: any) => (
              <div
                key={camp.id}
                className="flex items-center justify-between p-3 rounded-lg bg-muted/50"
              >
                <div className="flex items-center gap-3">
                  <div className="w-2 h-2 rounded-full bg-indigo-500" />
                  <div>
                    <p className="text-sm font-medium">{camp.name}</p>
                    <p className="text-xs text-muted-foreground">{camp.goal}</p>
                  </div>
                </div>
                <span
                  className={`text-xs px-2 py-0.5 rounded-full ${
                    camp.status === "active"
                      ? "bg-emerald-500/10 text-emerald-600"
                      : camp.status === "draft"
                      ? "bg-amber-500/10 text-amber-600"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {camp.status}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Recent Leads */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <CardTitle className="text-base font-semibold">Recent Leads</CardTitle>
            <Button variant="ghost" size="sm" asChild>
              <Link to="/leads">View all</Link>
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            {recentLeads.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-6">
                No leads yet. Start generating them!
              </p>
            )}
            {recentLeads.map((lead: any) => (
              <div
                key={lead.id}
                className="flex items-center justify-between p-3 rounded-lg bg-muted/50"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-white text-xs font-bold">
                    {lead.name?.charAt(0)?.toUpperCase() || "?"}
                  </div>
                  <div>
                    <p className="text-sm font-medium">{lead.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {lead.company || "No company"}
                    </p>
                  </div>
                </div>
                <span
                  className={`text-xs px-2 py-0.5 rounded-full ${
                    lead.status === "new"
                      ? "bg-blue-500/10 text-blue-600"
                      : lead.status === "won"
                      ? "bg-emerald-500/10 text-emerald-600"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {lead.status}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* Performance Overview */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="text-base font-semibold">Performance Overview</CardTitle>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/analytics">
              <BarChart3 className="w-4 h-4 mr-1" />
              Analytics
            </Link>
          </Button>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-muted-foreground">Lead Conversion</span>
                <span className="text-sm font-medium">
                  {leadCounts.total > 0
                    ? Math.round((leadCounts.won / leadCounts.total) * 100)
                    : 0}
                  %
                </span>
              </div>
              <Progress
                value={
                  leadCounts.total > 0
                    ? (leadCounts.won / leadCounts.total) * 100
                    : 0
                }
                className="h-2"
              />
            </div>
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-muted-foreground">Campaign Progress</span>
                <span className="text-sm font-medium">
                  {campaignCounts.total > 0
                    ? Math.round(
                        (campaignCounts.active / campaignCounts.total) * 100
                      )
                    : 0}
                  %
                </span>
              </div>
              <Progress
                value={
                  campaignCounts.total > 0
                    ? (campaignCounts.active / campaignCounts.total) * 100
                    : 0
                }
                className="h-2"
              />
            </div>
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-muted-foreground">Content Published</span>
                <span className="text-sm font-medium">
                  {contentCounts.total > 0 ? contentCounts.social : 0}
                </span>
              </div>
              <Progress
                value={contentCounts.total > 0 ? (contentCounts.social / contentCounts.total) * 100 : 0}
                className="h-2"
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
