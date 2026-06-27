import { trpc } from "@/providers/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Loader2, Database, Link2, Layers, AlertCircle } from "lucide-react";

export function DiagnosticsPanel() {
  const { data, isLoading, error } = trpc.admin.diagnostics.useQuery();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-[#00D4FF]" />
        <span className="ml-2 text-sm text-muted-foreground">Loading diagnostics…</span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        Failed to load diagnostics: {error?.message || "Unknown error"}
      </div>
    );
  }

  const integrationPlatforms = Object.entries(data.integrations);
  const queueStatuses = Object.entries(data.queue);

  return (
    <div className="space-y-6">
      {/* Database connectivity */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="p-2 rounded-lg bg-blue-500/10 w-fit mb-2">
              <Database className="w-4 h-4 text-blue-500" />
            </div>
            <div className="flex items-center gap-2">
              <p className="text-lg font-bold">{data.db.connected ? "Connected" : "Disconnected"}</p>
              <Badge variant={data.db.connected ? "default" : "destructive"}>
                {data.db.connected ? "OK" : "FAIL"}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">Database</p>
            <p className="text-xs text-muted-foreground mt-1">Latency: {data.db.latencyMs}ms</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="p-2 rounded-lg bg-purple-500/10 w-fit mb-2">
              <Link2 className="w-4 h-4 text-purple-500" />
            </div>
            <p className="text-lg font-bold">{integrationPlatforms.length}</p>
            <p className="text-xs text-muted-foreground">Connected Platforms</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="p-2 rounded-lg bg-amber-500/10 w-fit mb-2">
              <Layers className="w-4 h-4 text-amber-500" />
            </div>
            <p className="text-lg font-bold">
              {queueStatuses.reduce((sum, [, count]) => sum + count, 0)}
            </p>
            <p className="text-xs text-muted-foreground">Queue Items</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="p-2 rounded-lg bg-red-500/10 w-fit mb-2">
              <AlertCircle className="w-4 h-4 text-red-500" />
            </div>
            <p className="text-lg font-bold">{data.latestPublishErrors.length}</p>
            <p className="text-xs text-muted-foreground">Recent Publish Errors</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Integration status */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Link2 className="w-4 h-4" />
              Integration Status
            </CardTitle>
          </CardHeader>
          <CardContent>
            {integrationPlatforms.length === 0 ? (
              <p className="text-sm text-muted-foreground">No integrations found.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Platform</TableHead>
                    <TableHead>Connected</TableHead>
                    <TableHead>Expired</TableHead>
                    <TableHead>Disconnected</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {integrationPlatforms.map(([platform, statuses]) => (
                    <TableRow key={platform}>
                      <TableCell className="capitalize font-medium">{platform}</TableCell>
                      <TableCell>{statuses.connected ?? 0}</TableCell>
                      <TableCell>{statuses.expired ?? 0}</TableCell>
                      <TableCell>{statuses.disconnected ?? 0}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Queue status */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Layers className="w-4 h-4" />
              Publishing Queue Status
            </CardTitle>
          </CardHeader>
          <CardContent>
            {queueStatuses.length === 0 ? (
              <p className="text-sm text-muted-foreground">No queue items found.</p>
            ) : (
              <div className="space-y-2">
                {queueStatuses.map(([status, count]) => (
                  <div key={status} className="flex items-center justify-between text-sm">
                    <span className="capitalize">{status.replace(/_/g, " ")}</span>
                    <Badge variant="secondary">{count}</Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Latest publish errors */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <AlertCircle className="w-4 h-4" />
            Latest Publish Errors
          </CardTitle>
        </CardHeader>
        <CardContent>
          {data.latestPublishErrors.length === 0 ? (
            <p className="text-sm text-muted-foreground">No recent publish errors.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Queue ID</TableHead>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Platform</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Error</TableHead>
                  <TableHead>Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.latestPublishErrors.map((err) => (
                  <TableRow key={err.id}>
                    <TableCell>{err.id}</TableCell>
                    <TableCell>{err.campaignId}</TableCell>
                    <TableCell className="capitalize">{err.platform}</TableCell>
                    <TableCell className="capitalize">{err.status?.replace(/_/g, " ")}</TableCell>
                    <TableCell className="max-w-md truncate text-red-600" title={err.lastError || ""}>
                      {err.lastError}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {err.createdAt ? new Date(err.createdAt).toLocaleString() : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
