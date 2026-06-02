import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertTriangle,
  CheckCircle,
  Info,
  XCircle,
  Shield,
  Loader2,
  Bell,
} from "lucide-react";
import { toast } from "sonner";

const severityConfig: Record<string, { icon: any; color: string; label: string }> = {
  critical: { icon: XCircle, color: "text-red-500", label: "Critical" },
  warning: { icon: AlertTriangle, color: "text-amber-500", label: "Warning" },
  info: { icon: Info, color: "text-blue-500", label: "Info" },
};

export default function AdminAlerts() {
  const [filter, setFilter] = useState<"all" | "unresolved">("unresolved");
  const utils = trpc.useUtils();

  const { data: summary } = trpc.health.getAlertSummary.useQuery();
  const { data: alerts, isLoading } = trpc.health.listAlerts.useQuery({
    unresolvedOnly: filter === "unresolved",
    limit: 200,
  });

  const acknowledge = trpc.health.acknowledgeAlert.useMutation({
    onSuccess: () => {
      utils.health.listAlerts.invalidate();
      utils.health.getAlertSummary.invalidate();
      toast.success("Alert acknowledged");
    },
  });

  const resolveCategory = trpc.health.resolveAlertCategory.useMutation({
    onSuccess: (data) => {
      utils.health.listAlerts.invalidate();
      utils.health.getAlertSummary.invalidate();
      toast.success(`Resolved ${data.resolved} alert(s)`);
    },
  });

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Bell className="w-6 h-6 text-[#00D4FF]" />
            System Alerts
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Monitor and manage production alerts.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={filter === "unresolved" ? "default" : "outline"}
            size="sm"
            onClick={() => setFilter("unresolved")}
          >
            Unresolved
          </Button>
          <Button
            variant={filter === "all" ? "default" : "outline"}
            size="sm"
            onClick={() => setFilter("all")}
          >
            All
          </Button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="bg-[#1E293B] border-[#334155]">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <XCircle className="w-5 h-5 text-red-500" />
              <div>
                <p className="text-xl font-bold text-white">{summary?.critical ?? 0}</p>
                <p className="text-xs text-muted-foreground">Critical</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-[#1E293B] border-[#334155]">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-500" />
              <div>
                <p className="text-xl font-bold text-white">{summary?.warning ?? 0}</p>
                <p className="text-xs text-muted-foreground">Warnings</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-[#1E293B] border-[#334155]">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <Info className="w-5 h-5 text-blue-500" />
              <div>
                <p className="text-xl font-bold text-white">{summary?.info ?? 0}</p>
                <p className="text-xs text-muted-foreground">Info</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-[#1E293B] border-[#334155]">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <Bell className="w-5 h-5 text-[#00D4FF]" />
              <div>
                <p className="text-xl font-bold text-white">{summary?.totalUnresolved ?? 0}</p>
                <p className="text-xs text-muted-foreground">Total Unresolved</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Alerts Table */}
      <Card className="bg-[#1E293B] border-[#334155]">
        <CardHeader className="pb-3">
          <CardTitle className="text-white text-base flex items-center gap-2">
            <Shield className="w-4 h-4 text-[#00D4FF]" />
            Alerts
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-[#00D4FF]" />
            </div>
          ) : !alerts || alerts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <CheckCircle className="w-10 h-10 text-emerald-500 mb-3" />
              <p className="text-sm">No alerts found. All systems operational.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-[#334155]">
                    <TableHead className="text-gray-400">Severity</TableHead>
                    <TableHead className="text-gray-400">Category</TableHead>
                    <TableHead className="text-gray-400">Message</TableHead>
                    <TableHead className="text-gray-400">Time</TableHead>
                    <TableHead className="text-gray-400">Status</TableHead>
                    <TableHead className="text-gray-400 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {alerts.map((alert) => {
                    const sev = severityConfig[alert.severity] ?? severityConfig.info;
                    const Icon = sev.icon;
                    const isResolved = !!alert.resolvedAt;
                    const isAcknowledged = !!alert.acknowledgedAt;
                    return (
                      <TableRow key={alert.id} className="border-[#334155]">
                        <TableCell>
                          <div className={`flex items-center gap-1.5 ${sev.color}`}>
                            <Icon className="w-4 h-4" />
                            <span className="text-xs font-medium capitalize">{sev.label}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs border-[#334155] text-gray-300">
                            {alert.category}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm text-white max-w-md truncate">
                          {alert.message}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                          {new Date(alert.createdAt).toLocaleString()}
                        </TableCell>
                        <TableCell>
                          {isResolved ? (
                            <Badge className="bg-emerald-500/10 text-emerald-400 text-xs">Resolved</Badge>
                          ) : isAcknowledged ? (
                            <Badge className="bg-blue-500/10 text-blue-400 text-xs">Acknowledged</Badge>
                          ) : (
                            <Badge className="bg-amber-500/10 text-amber-400 text-xs">Open</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-2">
                            {!isResolved && !isAcknowledged && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs"
                                onClick={() => acknowledge.mutate({ alertId: alert.id })}
                                disabled={acknowledge.isPending}
                              >
                                Ack
                              </Button>
                            )}
                            {!isResolved && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs"
                                onClick={() => resolveCategory.mutate({ category: alert.category })}
                                disabled={resolveCategory.isPending}
                              >
                                Resolve
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
