import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  Activity,
  Database,
  Server,
  Wifi,
  AlertTriangle,
  CheckCircle,
  XCircle,
  BarChart3,
  Layers,
  Zap,
} from "lucide-react";

export default function SystemHealth() {
  const [activeTab, setActiveTab] = useState("overview");

  const { data: systemHealth } = trpc.health.getSystemHealth.useQuery();
  const { data: queueHealth } = trpc.health.getQueueHealth.useQuery();
  const { data: aiHealth } = trpc.health.getAIUsageHealth.useQuery();
  const { data: publishingHealth } = trpc.health.getPublishingHealth.useQuery();

  const isLoading = !systemHealth;

  if (isLoading) {
    return (
      <div className="flex h-full w-full items-center justify-center min-h-[60vh]">
        <div className="flex flex-col items-center gap-3">
          <Activity className="h-8 w-8 animate-spin text-[#00D4FF]" />
          <p className="text-sm text-muted-foreground">Loading system health...</p>
        </div>
      </div>
    );
  }

  const statusIcon = (status: string) => {
    if (status === "ok") return <CheckCircle className="w-4 h-4 text-emerald-500" />;
    if (status === "error") return <XCircle className="w-4 h-4 text-red-500" />;
    return <AlertTriangle className="w-4 h-4 text-amber-500" />;
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Activity className="w-6 h-6 text-[#00D4FF]" />
          System Health
        </h1>
        <p className="text-muted-foreground mt-1">
          Monitor API, database, queues, and AI usage.
        </p>
      </div>

      {/* System Status Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <Server className="w-5 h-5 text-[#00D4FF]" />
              {statusIcon(systemHealth.checks.api?.status || "ok")}
            </div>
            <p className="text-lg font-bold">API</p>
            <p className="text-xs text-muted-foreground">{systemHealth.checks.api?.latencyMs}ms</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <Database className="w-5 h-5 text-[#00D4FF]" />
              {statusIcon(systemHealth.checks.database?.status || "ok")}
            </div>
            <p className="text-lg font-bold">Database</p>
            <p className="text-xs text-muted-foreground">{systemHealth.checks.database?.latencyMs}ms</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <Wifi className="w-5 h-5 text-[#00D4FF]" />
              {statusIcon(systemHealth.checks.redis?.status || "ok")}
            </div>
            <p className="text-lg font-bold">Redis</p>
            <p className="text-xs text-muted-foreground">{systemHealth.checks.redis?.message || "Connected"}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <Layers className="w-5 h-5 text-[#00D4FF]" />
              <Badge variant="outline" className="text-xs">
                {queueHealth?.bullmq?.active ?? 0} active
              </Badge>
            </div>
            <p className="text-lg font-bold">Queue</p>
            <p className="text-xs text-muted-foreground">{queueHealth?.bullmq?.waiting ?? 0} waiting</p>
          </CardContent>
        </Card>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="ai">AI Usage</TabsTrigger>
          <TabsTrigger value="publishing">Publishing</TabsTrigger>
          <TabsTrigger value="queues">Queues</TabsTrigger>
        </TabsList>

        <div className="mt-4">
          {activeTab === "overview" && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Health Checks</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {Object.entries(systemHealth.checks).map(([name, check]) => (
                    <div key={name} className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {statusIcon(check.status)}
                        <span className="text-sm capitalize">{name}</span>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {check.status === "ok" ? `${check.latencyMs}ms` : check.message}
                      </span>
                    </div>
                  ))}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">System Status</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Overall Status</span>
                    <Badge className={systemHealth.status === "healthy" ? "bg-emerald-500/10 text-emerald-600" : "bg-amber-500/10 text-amber-600"}>
                      {systemHealth.status}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Last Checked</span>
                    <span className="text-sm">{new Date(systemHealth.timestamp).toLocaleString()}</span>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {activeTab === "ai" && aiHealth && (
            <div className="space-y-6">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <Card>
                  <CardContent className="p-4">
                    <Zap className="w-5 h-5 text-[#00D4FF] mb-2" />
                    <p className="text-xl font-bold">{aiHealth.monthly.totalCalls ?? 0}</p>
                    <p className="text-xs text-muted-foreground">AI Calls (Month)</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <BarChart3 className="w-5 h-5 text-purple-500 mb-2" />
                    <p className="text-xl font-bold">{(aiHealth.monthly.totalTokens ?? 0).toLocaleString()}</p>
                    <p className="text-xs text-muted-foreground">Tokens (Month)</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <Database className="w-5 h-5 text-emerald-500 mb-2" />
                    <p className="text-xl font-bold">${(aiHealth.monthly.actualCostUsd ?? 0).toFixed(2)}</p>
                    <p className="text-xs text-muted-foreground">AI Cost (Month)</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <Activity className="w-5 h-5 text-amber-500 mb-2" />
                    <p className="text-xl font-bold">{aiHealth.agentSuccessRate}%</p>
                    <p className="text-xs text-muted-foreground">Agent Success Rate</p>
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Daily AI Usage</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Calls Today</span>
                    <span className="text-sm font-medium">{aiHealth.daily.totalCalls ?? 0}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Tokens Today</span>
                    <span className="text-sm font-medium">{(aiHealth.daily.totalTokens ?? 0).toLocaleString()}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Cost Today</span>
                    <span className="text-sm font-medium">${(aiHealth.daily.actualCostUsd ?? 0).toFixed(4)}</span>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Agent Breakdown</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Total Runs</span>
                    <span className="text-sm font-medium">{aiHealth.agentBreakdown.total}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Completed</span>
                    <span className="text-sm font-medium text-emerald-600">{aiHealth.agentBreakdown.completed}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Failed</span>
                    <span className="text-sm font-medium text-red-600">{aiHealth.agentBreakdown.failed}</span>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {activeTab === "publishing" && publishingHealth && (
            <div className="space-y-6">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <Card>
                  <CardContent className="p-4">
                    <Layers className="w-5 h-5 text-[#00D4FF] mb-2" />
                    <p className="text-xl font-bold">{publishingHealth.monthly.total}</p>
                    <p className="text-xs text-muted-foreground">Total Posts</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <CheckCircle className="w-5 h-5 text-emerald-500 mb-2" />
                    <p className="text-xl font-bold">{publishingHealth.monthly.published}</p>
                    <p className="text-xs text-muted-foreground">Published</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <XCircle className="w-5 h-5 text-red-500 mb-2" />
                    <p className="text-xl font-bold">{publishingHealth.monthly.failed}</p>
                    <p className="text-xs text-muted-foreground">Failed</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <Activity className="w-5 h-5 text-amber-500 mb-2" />
                    <p className="text-xl font-bold">{publishingHealth.monthly.successRate}%</p>
                    <p className="text-xs text-muted-foreground">Success Rate</p>
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Recent Failures</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>ID</TableHead>
                          <TableHead>Platform</TableHead>
                          <TableHead>Error</TableHead>
                          <TableHead>Date</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {publishingHealth.recentFailures?.map((f) => (
                          <TableRow key={f.id}>
                            <TableCell className="text-xs font-mono">#{f.id}</TableCell>
                            <TableCell className="text-sm capitalize">{f.platform}</TableCell>
                            <TableCell className="text-sm text-red-600 max-w-[300px] truncate">{f.lastError || "Unknown"}</TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {f.createdAt ? new Date(f.createdAt).toLocaleDateString() : "-"}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    {(!publishingHealth.recentFailures || publishingHealth.recentFailures.length === 0) && (
                      <p className="text-sm text-muted-foreground text-center py-8">No recent failures.</p>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {activeTab === "queues" && queueHealth && (
            <div className="space-y-6">
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Publishing Queue (Database)</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Total Items</span>
                    <span className="text-sm font-medium">{queueHealth.publishing?.total ?? 0}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Published</span>
                    <span className="text-sm font-medium text-emerald-600">{queueHealth.publishing?.published ?? 0}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Failed</span>
                    <span className="text-sm font-medium text-red-600">{queueHealth.publishing?.failed ?? 0}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Pending Approval</span>
                    <span className="text-sm font-medium text-amber-600">{queueHealth.publishing?.pendingApproval ?? 0}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Approved / Ready</span>
                    <span className="text-sm font-medium text-blue-600">{queueHealth.publishing?.pending ?? 0}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Retrying</span>
                    <span className="text-sm font-medium text-purple-600">{queueHealth.publishing?.retrying ?? 0}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Safety Blocked</span>
                    <span className="text-sm font-medium text-gray-600">{queueHealth.publishing?.safetyBlocked ?? 0}</span>
                  </div>
                </CardContent>
              </Card>

              {queueHealth.bullmq && (
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">BullMQ Queue</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Waiting</span>
                      <span className="text-sm font-medium">{queueHealth.bullmq.waiting}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Active</span>
                      <span className="text-sm font-medium">{queueHealth.bullmq.active}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Delayed</span>
                      <span className="text-sm font-medium">{queueHealth.bullmq.delayed}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Completed</span>
                      <span className="text-sm font-medium text-emerald-600">{queueHealth.bullmq.completed}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Failed</span>
                      <span className="text-sm font-medium text-red-600">{queueHealth.bullmq.failed}</span>
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </div>
      </Tabs>
    </div>
  );
}
