import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Coins,
  TrendingDown,
  TrendingUp,
  Calendar,
  Activity,
  Zap,
  AlertTriangle,
  Loader2,
} from "lucide-react";
import { Link } from "react-router";

export default function Credits() {
  const [activeTab, setActiveTab] = useState("overview");

  const { data: wallet, isLoading: walletLoading } = trpc.billing.myWallet.useQuery();
  const { data: transactions, isLoading: txLoading } = trpc.billing.myTransactions.useQuery({ limit: 50 });
  const { data: usageSummary, isLoading: usageLoading } = trpc.billing.myUsageSummary.useQuery();
  const { data: usageDetails } = trpc.billing.myUsage.useQuery();

  const isLoading = walletLoading || txLoading || usageLoading;

  if (isLoading) {
    return (
      <div className="flex h-full w-full items-center justify-center min-h-[60vh]">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-[#00D4FF]" />
          <p className="text-sm text-muted-foreground">Loading credits...</p>
        </div>
      </div>
    );
  }

  const balance = wallet?.balance ?? 0;
  const monthlyAllocation = wallet?.monthlyAllocation ?? 0;
  const spentThisMonth = wallet?.spentThisMonth ?? 0;
  const remainingThisMonth = wallet?.remainingThisMonth ?? 0;
  const lifetimeEarned = wallet?.lifetimeEarned ?? 0;
  const spendLimit = wallet?.spendLimit;

  const monthlyPercent = monthlyAllocation > 0
    ? Math.min(100, Math.round((spentThisMonth / monthlyAllocation) * 100))
    : 0;

  const statCards = [
    {
      label: "Current Balance",
      value: balance.toLocaleString(),
      icon: Coins,
      color: "text-[#00D4FF]",
      bg: "bg-[#00D4FF]/10",
      sub: "credits available",
    },
    {
      label: "Monthly Allocation",
      value: monthlyAllocation.toLocaleString(),
      icon: Calendar,
      color: "text-emerald-500",
      bg: "bg-emerald-500/10",
      sub: "credits this period",
    },
    {
      label: "Spent This Month",
      value: spentThisMonth.toLocaleString(),
      icon: TrendingDown,
      color: "text-amber-500",
      bg: "bg-amber-500/10",
      sub: `${monthlyPercent}% of allocation`,
    },
    {
      label: "Lifetime Earned",
      value: lifetimeEarned.toLocaleString(),
      icon: TrendingUp,
      color: "text-purple-500",
      bg: "bg-purple-500/10",
      sub: "total credits received",
    },
  ];

  const transactionTypeLabel: Record<string, string> = {
    subscription_allocation: "Subscription",
    purchase: "Purchase",
    agent_deduction: "AI Agent",
    publishing_deduction: "Publishing",
    image_generation: "Image Gen",
    video_generation: "Video Gen",
    refund: "Refund",
    admin_adjustment: "Admin",
    rollover: "Rollover",
  };

  const transactionTypeColor: Record<string, string> = {
    subscription_allocation: "bg-emerald-500/10 text-emerald-600",
    purchase: "bg-blue-500/10 text-blue-600",
    agent_deduction: "bg-amber-500/10 text-amber-600",
    publishing_deduction: "bg-amber-500/10 text-amber-600",
    image_generation: "bg-purple-500/10 text-purple-600",
    video_generation: "bg-purple-500/10 text-purple-600",
    refund: "bg-emerald-500/10 text-emerald-600",
    admin_adjustment: "bg-gray-500/10 text-gray-600",
    rollover: "bg-blue-500/10 text-blue-600",
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Coins className="w-6 h-6 text-[#00D4FF]" />
            Credit Center
          </h1>
          <p className="text-muted-foreground mt-1">
            Track your AI usage, credit balance, and spending.
          </p>
        </div>
        <Link to="/pricing">
          <Button className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED]">
            <Zap className="w-4 h-4 mr-2" />
            Upgrade Plan
          </Button>
        </Link>
      </div>

      {/* Low balance alert */}
      {balance < 10 && balance > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0" />
          <div>
            <p className="text-sm font-medium text-amber-600">Low Credit Balance</p>
            <p className="text-xs text-amber-600/80">
              You have {balance} credits remaining. Upgrade your plan to continue using AI features.
            </p>
          </div>
          <Link to="/pricing" className="ml-auto">
            <Button size="sm" variant="outline" className="border-amber-500/30 text-amber-600 hover:bg-amber-500/10">
              Get Credits
            </Button>
          </Link>
        </div>
      )}

      {balance === 0 && monthlyAllocation > 0 && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-red-500 shrink-0" />
          <div>
            <p className="text-sm font-medium text-red-600">Out of Credits</p>
            <p className="text-xs text-red-600/80">
              Your credit balance is depleted. Upgrade your plan or wait for your next monthly allocation.
            </p>
          </div>
          <Link to="/pricing" className="ml-auto">
            <Button size="sm" variant="outline" className="border-red-500/30 text-red-600 hover:bg-red-500/10">
              Get Credits
            </Button>
          </Link>
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map((s) => (
          <Card key={s.label}>
            <CardContent className="p-4">
              <div className={`p-2 rounded-lg ${s.bg} w-fit mb-2`}>
                <s.icon className={`w-4 h-4 ${s.color}`} />
              </div>
              <p className="text-xl font-bold">{s.value}</p>
              <p className="text-xs text-muted-foreground">{s.label}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">{s.sub}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Monthly Usage Bar */}
      {monthlyAllocation > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Activity className="w-4 h-4 text-[#00D4FF]" />
              Monthly Usage
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-muted-foreground">
                {spentThisMonth.toLocaleString()} / {monthlyAllocation.toLocaleString()} credits used
              </span>
              <span className="text-sm font-medium">{monthlyPercent}%</span>
            </div>
            <div className="h-3 bg-muted rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  monthlyPercent > 90 ? "bg-red-500" : monthlyPercent > 70 ? "bg-amber-500" : "bg-gradient-to-r from-[#00D4FF] to-[#7C3AED]"
                }`}
                style={{ width: `${monthlyPercent}%` }}
              />
            </div>
            <div className="flex items-center justify-between mt-2">
              <span className="text-xs text-muted-foreground">
                {remainingThisMonth.toLocaleString()} credits remaining this month
              </span>
              {spendLimit && (
                <span className="text-xs text-muted-foreground">
                  Spend limit: {spendLimit.toLocaleString()} credits
                </span>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Usage Summary */}
      {usageSummary && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">This Month</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">AI Calls</span>
                <span className="text-sm font-medium">{usageSummary.monthly?.totalCalls ?? 0}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Total Tokens</span>
                <span className="text-sm font-medium">{(usageSummary.monthly?.totalTokens ?? 0).toLocaleString()}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Credits Used</span>
                <span className="text-sm font-medium">{(usageSummary.monthly?.totalCredits ?? 0).toLocaleString()}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Est. Cost</span>
                <span className="text-sm font-medium">${usageSummary.monthly?.estimatedCostUsd ?? "0.00"}</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">All Time</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">AI Calls</span>
                <span className="text-sm font-medium">{usageSummary.allTime?.totalCalls ?? 0}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Total Tokens</span>
                <span className="text-sm font-medium">{(usageSummary.allTime?.totalTokens ?? 0).toLocaleString()}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Credits Used</span>
                <span className="text-sm font-medium">{(usageSummary.allTime?.totalCredits ?? 0).toLocaleString()}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Est. Cost</span>
                <span className="text-sm font-medium">${usageSummary.allTime?.estimatedCostUsd ?? "0.00"}</span>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="overview">Transactions</TabsTrigger>
          <TabsTrigger value="usage">Usage Details</TabsTrigger>
        </TabsList>

        <div className="mt-4">
          {activeTab === "overview" && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Recent Transactions</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Type</TableHead>
                        <TableHead>Amount</TableHead>
                        <TableHead>Balance After</TableHead>
                        <TableHead>Description</TableHead>
                        <TableHead>Date</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {transactions?.map((t) => (
                        <TableRow key={t.id}>
                          <TableCell>
                            <Badge variant="outline" className={transactionTypeColor[t.type] || ""}>
                              {transactionTypeLabel[t.type] || t.type}
                            </Badge>
                          </TableCell>
                          <TableCell className={`font-medium ${t.amount > 0 ? "text-emerald-600" : "text-red-600"}`}>
                            {t.amount > 0 ? "+" : ""}{t.amount.toLocaleString()}
                          </TableCell>
                          <TableCell className="text-sm">{t.balanceAfter.toLocaleString()}</TableCell>
                          <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">
                            {t.description || "-"}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {t.createdAt ? new Date(t.createdAt).toLocaleDateString() : "-"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  {(!transactions || transactions.length === 0) && (
                    <p className="text-sm text-muted-foreground text-center py-8">No transactions yet.</p>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {activeTab === "usage" && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">AI Usage Details</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Agent</TableHead>
                        <TableHead>Model</TableHead>
                        <TableHead>Tokens</TableHead>
                        <TableHead>Credits</TableHead>
                        <TableHead>Cost (USD)</TableHead>
                        <TableHead>Date</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {usageDetails?.map((u) => (
                        <TableRow key={u.id}>
                          <TableCell>
                            <Badge variant="outline" className="text-xs capitalize">
                              {u.agentType.replace(/_/g, " ")}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs font-mono">{u.model}</TableCell>
                          <TableCell className="text-sm">{(u.totalTokens ?? 0).toLocaleString()}</TableCell>
                          <TableCell className="text-sm">{u.creditsDeducted.toLocaleString()}</TableCell>
                          <TableCell className="text-sm">${((u.estimatedCostUsd ?? 0) / 1_000_000).toFixed(4)}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {u.createdAt ? new Date(u.createdAt).toLocaleDateString() : "-"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  {(!usageDetails || usageDetails.length === 0) && (
                    <p className="text-sm text-muted-foreground text-center py-8">No AI usage recorded yet.</p>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </Tabs>
    </div>
  );
}
