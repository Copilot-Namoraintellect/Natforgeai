import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Users,
  Plus,
  Search,
  Phone,
  Mail,
  Building2,
  Star,
  Trash2,
  Pencil,
  Check,
  Sparkles,
  Send,
  FileText,
  Calendar,
} from "lucide-react";
import { toast } from "sonner";

const statusColors: Record<string, string> = {
  new: "bg-blue-500/10 text-blue-600",
  contacted: "bg-amber-500/10 text-amber-600",
  qualified: "bg-[#00D4FF]/10 text-[#00D4FF]",
  proposal: "bg-purple-500/10 text-purple-600",
  negotiation: "bg-orange-500/10 text-orange-600",
  won: "bg-emerald-500/10 text-emerald-600",
  lost: "bg-red-500/10 text-red-600",
};

const statusStages = ["new", "contacted", "qualified", "proposal", "negotiation", "won", "lost"];

export default function Leads() {
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editLead, setEditLead] = useState<any>(null);
  const [activeTab, setActiveTab] = useState("all");
  const utils = trpc.useUtils();

  const { data: leads, isLoading } = trpc.lead.list.useQuery(
    activeTab === "all" ? undefined : { status: activeTab as any }
  );

  const createMutation = trpc.lead.create.useMutation({
    onSuccess: () => {
      utils.lead.list.invalidate();
      setCreateOpen(false);
      toast.success("Lead added!");
    },
  });

  const updateMutation = trpc.lead.update.useMutation({
    onSuccess: () => {
      utils.lead.list.invalidate();
      utils.subscription.myUsage.invalidate();
      setEditLead(null);
      toast.success("Lead updated!");
    },
    onError: (err) => {
      toast.error(err.message || "Failed to update lead");
    },
  });

  const deleteMutation = trpc.lead.delete.useMutation({
    onSuccess: () => {
      utils.lead.list.invalidate();
      toast.success("Lead removed!");
    },
  });
  const salesAgentMutation = trpc.agent.runSalesAgent.useMutation({
    onSuccess: () => {
      toast.success("AI sales action completed!");
    },
    onError: (err) => toast.error(err.message || "Sales agent failed"),
  });

  const filtered = leads?.filter((l) =>
    l.name.toLowerCase().includes(search.toLowerCase()) ||
    l.company?.toLowerCase().includes(search.toLowerCase()) ||
    l.email?.toLowerCase().includes(search.toLowerCase())
  );

  function handleCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    createMutation.mutate({
      name: form.get("name") as string,
      email: (form.get("email") as string) || undefined,
      phone: (form.get("phone") as string) || undefined,
      company: (form.get("company") as string) || undefined,
      jobTitle: (form.get("jobTitle") as string) || undefined,
      source: (form.get("source") as string) || undefined,
      notes: (form.get("notes") as string) || undefined,
      score: Number(form.get("score")) || 0,
    });
  }

  function handleUpdate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editLead) return;
    const form = new FormData(e.currentTarget);
    updateMutation.mutate({
      id: editLead.id,
      name: (form.get("name") as string) || undefined,
      email: (form.get("email") as string) || undefined,
      phone: (form.get("phone") as string) || undefined,
      company: (form.get("company") as string) || undefined,
      status: (form.get("status") as any) || undefined,
      notes: (form.get("notes") as string) || undefined,
      score: Number(form.get("score")) || undefined,
    });
  }

  const totalLeads = leads?.length ?? 0;
  const wonLeads = leads?.filter((l) => l.status === "won").length ?? 0;
  const avgScore = totalLeads > 0
    ? Math.round((leads?.reduce((sum, l) => sum + (l.score || 0), 0) ?? 0) / totalLeads)
    : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Lead Management</h1>
          <p className="text-muted-foreground mt-1">
            Track and nurture your sales pipeline.
          </p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] hover:opacity-90">
              <Plus className="w-4 h-4 mr-2" />
              Add Lead
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Add New Lead</DialogTitle>
              <DialogDescription>
                Enter the lead's contact information and details.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-4 mt-4">
              <div>
                <Label>Name *</Label>
                <Input name="name" placeholder="John Smith" required />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Email</Label>
                  <Input name="email" type="email" placeholder="john@example.com" />
                </div>
                <div>
                  <Label>Phone</Label>
                  <Input name="phone" placeholder="+27 12 345 6789" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Company</Label>
                  <Input name="company" placeholder="Acme Inc" />
                </div>
                <div>
                  <Label>Job Title</Label>
                  <Input name="jobTitle" placeholder="Marketing Manager" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Source</Label>
                  <Input name="source" placeholder="Instagram, Referral..." />
                </div>
                <div>
                  <Label>Score (0-100)</Label>
                  <Input name="score" type="number" min="0" max="100" defaultValue="50" />
                </div>
              </div>
              <div>
                <Label>Notes</Label>
                <Textarea name="notes" placeholder="Any notes about this lead..." />
              </div>
              <Button
                type="submit"
                className="w-full bg-gradient-to-r from-[#00D4FF] to-[#7C3AED]"
                disabled={createMutation.isPending}
              >
                {createMutation.isPending ? "Adding..." : "Add Lead"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-lg bg-blue-500/10">
                <Users className="w-5 h-5 text-blue-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{totalLeads}</p>
                <p className="text-sm text-muted-foreground">Total Leads</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-lg bg-emerald-500/10">
                <Check className="w-5 h-5 text-emerald-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{wonLeads}</p>
                <p className="text-sm text-muted-foreground">Won Deals</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-lg bg-amber-500/10">
                <Star className="w-5 h-5 text-amber-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{avgScore}</p>
                <p className="text-sm text-muted-foreground">Avg Score</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tabs & Search */}
      <div className="flex flex-col sm:flex-row gap-4">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1">
          <TabsList className="flex-wrap h-auto">
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="new">New</TabsTrigger>
            <TabsTrigger value="contacted">Contacted</TabsTrigger>
            <TabsTrigger value="qualified">Qualified</TabsTrigger>
            <TabsTrigger value="proposal">Proposal</TabsTrigger>
            <TabsTrigger value="won">Won</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search leads..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Pipeline View */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {isLoading ? (
          [1, 2, 3].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="p-6 h-32" />
            </Card>
          ))
        ) : (filtered ?? []).length === 0 ? (
          <Card className="col-span-full">
            <CardContent className="flex flex-col items-center justify-center py-16">
              <Users className="w-12 h-12 text-muted-foreground mb-4" />
              <p className="text-lg font-medium">No leads yet</p>
              <p className="text-sm text-muted-foreground mt-1 mb-4">
                Add your first lead to start tracking.
              </p>
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="w-4 h-4 mr-2" />
                Add Lead
              </Button>
            </CardContent>
          </Card>
        ) : (
          (filtered ?? []).map((lead) => (
            <Card key={lead.id} className="group hover:shadow-md transition-all">
              <CardContent className="p-5">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#00D4FF] to-[#7C3AED] flex items-center justify-center text-white text-xs font-bold">
                      {lead.name.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <p className="text-sm font-semibold">{lead.name}</p>
                      {lead.company && (
                        <p className="text-xs text-muted-foreground flex items-center gap-1">
                          <Building2 className="w-3 h-3" />
                          {lead.company}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => setEditLead(lead)}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-red-500"
                      onClick={() => deleteMutation.mutate({ id: lead.id })}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>

                <div className="space-y-1.5 mb-3">
                  {lead.email && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                      <Mail className="w-3 h-3" />
                      {lead.email}
                    </p>
                  )}
                  {lead.phone && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                      <Phone className="w-3 h-3" />
                      {lead.phone}
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Badge
                      variant="secondary"
                      className={statusColors[lead.status] || "bg-muted"}
                    >
                      {lead.status}
                    </Badge>
                    <div className="flex items-center gap-1">
                      <Star className="w-3 h-3 text-amber-500" />
                      <span className="text-xs font-medium">{lead.score}/100</span>
                    </div>
                  </div>
                  <div className="w-full bg-muted rounded-full h-1.5">
                    <div
                      className={`h-1.5 rounded-full ${
                        (lead.score || 0) >= 80
                          ? "bg-emerald-500"
                          : (lead.score || 0) >= 50
                          ? "bg-amber-500"
                          : "bg-red-500"
                      }`}
                      style={{ width: `${lead.score || 0}%` }}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      {/* Edit Lead Dialog */}
      {editLead && (
        <Dialog open={!!editLead} onOpenChange={() => setEditLead(null)}>
          <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Edit Lead</DialogTitle>
              <DialogDescription>
                Update the lead's information.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleUpdate} className="space-y-4 mt-4">
              <div>
                <Label>Name</Label>
                <Input name="name" defaultValue={editLead.name} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Email</Label>
                  <Input name="email" defaultValue={editLead.email || ""} />
                </div>
                <div>
                  <Label>Phone</Label>
                  <Input name="phone" defaultValue={editLead.phone || ""} />
                </div>
              </div>
              <div>
                <Label>Company</Label>
                <Input name="company" defaultValue={editLead.company || ""} />
              </div>
              <div>
                <Label>Status</Label>
                <Select name="status" defaultValue={editLead.status}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {statusStages.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s.charAt(0).toUpperCase() + s.slice(1)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Score</Label>
                <Input name="score" type="number" defaultValue={editLead.score || 0} />
              </div>
              <div>
                <Label>Notes</Label>
                <Textarea name="notes" defaultValue={editLead.notes || ""} />
              </div>
              <Button
                type="submit"
                className="w-full bg-gradient-to-r from-[#00D4FF] to-[#7C3AED]"
                disabled={updateMutation.isPending}
              >
                {updateMutation.isPending ? "Saving..." : "Update Lead"}
              </Button>
            </form>

            {/* AI Sales Actions */}
            <div className="mt-4 pt-4 border-t">
              <p className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-purple-400" />
                AI Sales Actions
              </p>
              <div className="grid grid-cols-3 gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="border-purple-500/30 text-purple-400 hover:bg-purple-500/10"
                  onClick={() =>
                    salesAgentMutation.mutate({
                      campaignId: editLead.campaignId || 0,
                      leadId: editLead.id,
                      action: "follow_up",
                    })
                  }
                  disabled={salesAgentMutation.isPending}
                >
                  <Send className="w-3.5 h-3.5 mr-1" />
                  Follow-up
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="border-purple-500/30 text-purple-400 hover:bg-purple-500/10"
                  onClick={() =>
                    salesAgentMutation.mutate({
                      campaignId: editLead.campaignId || 0,
                      leadId: editLead.id,
                      action: "proposal",
                    })
                  }
                  disabled={salesAgentMutation.isPending}
                >
                  <FileText className="w-3.5 h-3.5 mr-1" />
                  Proposal
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="border-purple-500/30 text-purple-400 hover:bg-purple-500/10"
                  onClick={() =>
                    salesAgentMutation.mutate({
                      campaignId: editLead.campaignId || 0,
                      leadId: editLead.id,
                      action: "meeting",
                    })
                  }
                  disabled={salesAgentMutation.isPending}
                >
                  <Calendar className="w-3.5 h-3.5 mr-1" />
                  Meeting
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
