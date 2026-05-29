import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Users,
  DollarSign,
  TrendingUp,
  CreditCard,
  Shield,
  Search,
  Crown,
  User,
  Loader2,
  BarChart3,
} from "lucide-react";
import { toast } from "sonner";

export default function Admin() {
  const [activeTab, setActiveTab] = useState("overview");
  const [searchUsers, setSearchUsers] = useState("");
  const [recordPaymentOpen, setRecordPaymentOpen] = useState(false);

  const { data: stats } = trpc.admin.stats.useQuery();
  const { data: allUsers } = trpc.admin.users.useQuery(
    searchUsers ? { search: searchUsers } : undefined
  );
  const { data: allPayments } = trpc.admin.payments.useQuery();
  const { data: allSubs } = trpc.admin.subscriptions.useQuery();
  const { data: revenueByMonth } = trpc.admin.revenueByMonth.useQuery();
  const { data: subsByTier } = trpc.admin.subscriptionsByTier.useQuery();

  const utils = trpc.useUtils();

  const updateRole = trpc.admin.updateUserRole.useMutation({
    onSuccess: () => {
      utils.admin.users.invalidate();
      utils.admin.stats.invalidate();
      toast.success("User role updated!");
    },
  });

  const recordPayment = trpc.admin.recordPayment.useMutation({
    onSuccess: () => {
      utils.admin.payments.invalidate();
      utils.admin.stats.invalidate();
      setRecordPaymentOpen(false);
      toast.success("Payment recorded!");
    },
  });

  const statCards = [
    {
      label: "Total Users",
      value: stats?.totalUsers ?? 0,
      icon: Users,
      color: "text-blue-500",
      bg: "bg-blue-500/10",
    },
    {
      label: "Active Subs",
      value: stats?.activeSubscriptions ?? 0,
      icon: CreditCard,
      color: "text-indigo-500",
      bg: "bg-indigo-500/10",
    },
    {
      label: "Total Revenue",
      value: `$${((stats?.totalRevenue ?? 0) / 100).toFixed(2)}`,
      icon: DollarSign,
      color: "text-emerald-500",
      bg: "bg-emerald-500/10",
    },
    {
      label: "Campaigns",
      value: stats?.totalCampaigns ?? 0,
      icon: TrendingUp,
      color: "text-amber-500",
      bg: "bg-amber-500/10",
    },
    {
      label: "Leads",
      value: stats?.totalLeads ?? 0,
      icon: Users,
      color: "text-purple-500",
      bg: "bg-purple-500/10",
    },
    {
      label: "Content",
      value: stats?.totalContent ?? 0,
      icon: BarChart3,
      color: "text-cyan-500",
      bg: "bg-cyan-500/10",
    },
  ];

  function handleRecordPayment(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    recordPayment.mutate({
      userId: Number(form.get("userId")),
      amount: Math.round(Number(form.get("amount")) * 100),
      currency: "USD",
      description: (form.get("description") as string) || undefined,
      paymentMethod: (form.get("paymentMethod") as any) || "manual",
      paymentReference: (form.get("reference") as string) || undefined,
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Shield className="w-6 h-6 text-indigo-500" />
            Admin Dashboard
          </h1>
          <p className="text-muted-foreground mt-1">
            Manage users, payments, subscriptions, and system performance.
          </p>
        </div>
        <Dialog open={recordPaymentOpen} onOpenChange={setRecordPaymentOpen}>
          <DialogTrigger asChild>
            <Button className="bg-gradient-to-r from-emerald-500 to-green-600">
              <DollarSign className="w-4 h-4 mr-2" />
              Record Payment
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Record Manual Payment</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleRecordPayment} className="space-y-4 mt-4">
              <div>
                <Label>User ID</Label>
                <Input name="userId" type="number" placeholder="123" required />
              </div>
              <div>
                <Label>Amount (USD)</Label>
                <Input name="amount" type="number" step="0.01" placeholder="20.00" required />
              </div>
              <div>
                <Label>Payment Method</Label>
                <select name="paymentMethod" className="w-full p-2 rounded-md border border-border bg-background text-sm" required>
                  <option value="manual">Manual/Bank Transfer</option>
                  <option value="stripe">Stripe</option>
                  <option value="paypal">PayPal</option>
                  <option value="crypto">Crypto</option>
                </select>
              </div>
              <div>
                <Label>Reference</Label>
                <Input name="reference" placeholder="Transaction ID or reference" />
              </div>
              <div>
                <Label>Description</Label>
                <Input name="description" placeholder="Startup plan - Monthly" />
              </div>
              <Button type="submit" className="w-full" disabled={recordPayment.isPending}>
                {recordPayment.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                Record Payment
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        {statCards.map((s) => (
          <Card key={s.label}>
            <CardContent className="p-4">
              <div className={`p-2 rounded-lg ${s.bg} w-fit mb-2`}>
                <s.icon className={`w-4 h-4 ${s.color}`} />
              </div>
              <p className="text-xl font-bold">{s.value}</p>
              <p className="text-xs text-muted-foreground">{s.label}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="payments">Payments</TabsTrigger>
          <TabsTrigger value="subscriptions">Subscriptions</TabsTrigger>
        </TabsList>

        {/* OVERVIEW TAB */}
        <div className="mt-4">
          {activeTab === "overview" && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Revenue Chart */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Revenue (Last 12 Months)</CardTitle>
                </CardHeader>
                <CardContent>
                  {(!revenueByMonth || revenueByMonth.length === 0) ? (
                    <p className="text-sm text-muted-foreground text-center py-8">No payment data yet.</p>
                  ) : (
                    <div className="space-y-3">
                      {revenueByMonth.map((r) => (
                        <div key={r.month} className="flex items-center gap-3">
                          <span className="text-xs text-muted-foreground w-16 shrink-0">{r.month}</span>
                          <div className="flex-1 h-6 bg-muted rounded-full overflow-hidden">
                            <div
                              className="h-full bg-gradient-to-r from-indigo-500 to-purple-600 rounded-full transition-all"
                              style={{
                                width: `${Math.min(100, (r.amount / Math.max(...revenueByMonth.map(x => x.amount))) * 100)}%`,
                              }}
                            />
                          </div>
                          <span className="text-xs font-medium w-16 text-right">
                            ${(r.amount / 100).toFixed(2)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Subscriptions by Tier */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Active Subscriptions by Tier</CardTitle>
                </CardHeader>
                <CardContent>
                  {(!subsByTier || subsByTier.length === 0) ? (
                    <p className="text-sm text-muted-foreground text-center py-8">No active subscriptions yet.</p>
                  ) : (
                    <div className="space-y-4">
                      {subsByTier.map((s) => (
                        <div key={s.tierId}>
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-sm font-medium">{s.tierName}</span>
                            <span className="text-sm text-muted-foreground">{s.count} users</span>
                          </div>
                          <div className="h-2 bg-muted rounded-full overflow-hidden">
                            <div
                              className="h-full bg-gradient-to-r from-emerald-500 to-teal-500 rounded-full"
                              style={{
                                width: `${Math.min(100, (s.count / Math.max(...subsByTier.map(x => x.count))) * 100)}%`,
                              }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          )}

          {/* USERS TAB */}
          {activeTab === "users" && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-3">
                <CardTitle className="text-base">All Users ({allUsers?.length ?? 0})</CardTitle>
                <div className="relative w-64">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    className="pl-9 h-8 text-sm"
                    placeholder="Search users..."
                    value={searchUsers}
                    onChange={(e) => setSearchUsers(e.target.value)}
                  />
                </div>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>User</TableHead>
                        <TableHead>Email</TableHead>
                        <TableHead>Role</TableHead>
                        <TableHead>Auth</TableHead>
                        <TableHead>Joined</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {allUsers?.map((u) => (
                        <TableRow key={u.id}>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <div className="w-7 h-7 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white text-xs font-bold">
                                {u.name?.charAt(0)?.toUpperCase() || "?"}
                              </div>
                              <span className="text-sm font-medium">{u.name || "Unnamed"}</span>
                            </div>
                          </TableCell>
                          <TableCell className="text-sm">{u.email || "-"}</TableCell>
                          <TableCell>
                            <Badge
                              variant={u.role === "admin" ? "default" : "secondary"}
                              className={u.role === "admin" ? "bg-indigo-500/10 text-indigo-600" : ""}
                            >
                              {u.role === "admin" ? (
                                <Crown className="w-3 h-3 mr-1" />
                              ) : (
                                <User className="w-3 h-3 mr-1" />
                              )}
                              {u.role}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground capitalize">
                            {u.authType}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {u.createdAt ? new Date(u.createdAt).toLocaleDateString() : "-"}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                updateRole.mutate({
                                  userId: u.id,
                                  role: u.role === "admin" ? "user" : "admin",
                                })
                              }
                            >
                              {u.role === "admin" ? "Demote" : "Make Admin"}
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          )}

          {/* PAYMENTS TAB */}
          {activeTab === "payments" && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">All Payments</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>ID</TableHead>
                        <TableHead>User</TableHead>
                        <TableHead>Amount</TableHead>
                        <TableHead>Method</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Date</TableHead>
                        <TableHead>Reference</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {allPayments?.map((p) => (
                        <TableRow key={p.id}>
                          <TableCell className="text-xs font-mono">#{p.id}</TableCell>
                          <TableCell className="text-sm">User #{p.userId}</TableCell>
                          <TableCell className="font-medium">
                            ${p.currency} {(p.amount / 100).toFixed(2)}
                          </TableCell>
                          <TableCell className="text-xs capitalize">{p.paymentMethod}</TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className={
                                p.status === "completed"
                                  ? "bg-emerald-500/10 text-emerald-600"
                                  : p.status === "pending"
                                  ? "bg-amber-500/10 text-amber-600"
                                  : "bg-red-500/10 text-red-600"
                              }
                            >
                              {p.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs">
                            {p.paidAt ? new Date(p.paidAt).toLocaleDateString() : "-"}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {p.paymentReference || "-"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  {(!allPayments || allPayments.length === 0) && (
                    <p className="text-sm text-muted-foreground text-center py-8">No payments recorded yet.</p>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {/* SUBSCRIPTIONS TAB */}
          {activeTab === "subscriptions" && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">All Subscriptions</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>User</TableHead>
                        <TableHead>Tier</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Period Start</TableHead>
                        <TableHead>Period End</TableHead>
                        <TableHead>Payment</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {allSubs?.map((s) => (
                        <TableRow key={s.id}>
                          <TableCell className="text-sm">{s.user?.name || `User #${s.userId}`}</TableCell>
                          <TableCell>
                            <Badge variant="outline">{s.tier?.name || "-"}</Badge>
                          </TableCell>
                          <TableCell>
                            <Badge
                              className={
                                s.status === "active"
                                  ? "bg-emerald-500/10 text-emerald-600"
                                  : s.status === "trialing"
                                  ? "bg-blue-500/10 text-blue-600"
                                  : "bg-red-500/10 text-red-600"
                              }
                            >
                              {s.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs">
                            {s.currentPeriodStart ? new Date(s.currentPeriodStart).toLocaleDateString() : "-"}
                          </TableCell>
                          <TableCell className="text-xs">
                            {s.currentPeriodEnd ? new Date(s.currentPeriodEnd).toLocaleDateString() : "-"}
                          </TableCell>
                          <TableCell className="text-xs capitalize">{s.paymentMethod || "-"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  {(!allSubs || allSubs.length === 0) && (
                    <p className="text-sm text-muted-foreground text-center py-8">No subscriptions yet.</p>
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
