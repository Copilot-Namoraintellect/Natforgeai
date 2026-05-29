import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Zap,
  Plus,
  Play,
  Pause,
  Trash2,
  ArrowRight,
  MessageSquare,
  UserPlus,
  ShoppingCart,
  FileText,
  Clock,
  MousePointer,
} from "lucide-react";
import { toast } from "sonner";

const triggerIcons: Record<string, any> = {
  new_lead: UserPlus,
  new_message: MessageSquare,
  new_purchase: ShoppingCart,
  form_submit: FileText,
  schedule: Clock,
  manual: MousePointer,
};

const triggerLabels: Record<string, string> = {
  new_lead: "New Lead",
  new_message: "New Message",
  new_purchase: "New Purchase",
  form_submit: "Form Submit",
  schedule: "Schedule",
  manual: "Manual",
};

export default function Automations() {
  const [createOpen, setCreateOpen] = useState(false);
  const utils = trpc.useUtils();

  const { data: automations, isLoading } = trpc.automation.list.useQuery();

  const createMutation = trpc.automation.create.useMutation({
    onSuccess: () => {
      utils.automation.list.invalidate();
      setCreateOpen(false);
      toast.success("Automation created!");
    },
  });

  const toggleMutation = trpc.automation.toggle.useMutation({
    onSuccess: (data) => {
      utils.automation.list.invalidate();
      toast.success(data.isActive ? "Automation activated!" : "Automation paused!");
    },
  });

  const deleteMutation = trpc.automation.delete.useMutation({
    onSuccess: () => {
      utils.automation.list.invalidate();
      toast.success("Automation deleted!");
    },
  });

  function handleCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const actions = [
      {
        type: (form.get("action1") as string) || "send_email",
        config: {},
      },
      {
        type: (form.get("action2") as string) || "add_to_crm",
        config: {},
      },
    ];
    createMutation.mutate({
      name: form.get("name") as string,
      description: (form.get("description") as string) || undefined,
      trigger: (form.get("trigger") as any) || "new_lead",
      actions,
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Automations</h1>
          <p className="text-muted-foreground mt-1">
            Build automated workflows to streamline your marketing.
          </p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button className="bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700">
              <Plus className="w-4 h-4 mr-2" />
              New Workflow
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Create Automation</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-4 mt-4">
              <div>
                <Label>Workflow Name</Label>
                <Input name="name" placeholder="Lead follow-up sequence" required />
              </div>
              <div>
                <Label>Description</Label>
                <Textarea name="description" placeholder="What this automation does..." />
              </div>
              <div>
                <Label>Trigger</Label>
                <Select name="trigger" defaultValue="new_lead">
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="new_lead">New Lead</SelectItem>
                    <SelectItem value="new_message">New Message</SelectItem>
                    <SelectItem value="new_purchase">New Purchase</SelectItem>
                    <SelectItem value="form_submit">Form Submit</SelectItem>
                    <SelectItem value="schedule">Schedule</SelectItem>
                    <SelectItem value="manual">Manual</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Action 1</Label>
                <Select name="action1" defaultValue="send_email">
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="send_email">Send Email</SelectItem>
                    <SelectItem value="send_whatsapp">Send WhatsApp</SelectItem>
                    <SelectItem value="add_to_crm">Add to CRM</SelectItem>
                    <SelectItem value="notify_team">Notify Team</SelectItem>
                    <SelectItem value="create_task">Create Task</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Action 2</Label>
                <Select name="action2" defaultValue="add_to_crm">
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="send_email">Send Email</SelectItem>
                    <SelectItem value="send_whatsapp">Send WhatsApp</SelectItem>
                    <SelectItem value="add_to_crm">Add to CRM</SelectItem>
                    <SelectItem value="notify_team">Notify Team</SelectItem>
                    <SelectItem value="create_task">Create Task</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="submit"
                className="w-full bg-gradient-to-r from-indigo-500 to-purple-600"
                disabled={createMutation.isPending}
              >
                {createMutation.isPending ? "Creating..." : "Create Workflow"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Automation List */}
      {isLoading ? (
        <div className="space-y-4">
          {[1, 2].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="p-6 h-24" />
            </Card>
          ))}
        </div>
      ) : automations?.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Zap className="w-12 h-12 text-muted-foreground mb-4" />
            <p className="text-lg font-medium">No automations yet</p>
            <p className="text-sm text-muted-foreground mt-1 mb-4">
              Create your first workflow to automate repetitive tasks.
            </p>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="w-4 h-4 mr-2" />
              Create Workflow
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {(automations ?? []).map((auto) => {
            const TriggerIcon = triggerIcons[auto.trigger] || Zap;
            return (
              <Card key={auto.id} className="hover:shadow-md transition-all">
                <CardContent className="p-5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <div
                        className={`p-3 rounded-lg ${
                          auto.isActive
                            ? "bg-emerald-500/10"
                            : "bg-muted"
                        }`}
                      >
                        <TriggerIcon
                          className={`w-5 h-5 ${
                            auto.isActive ? "text-emerald-600" : "text-muted-foreground"
                          }`}
                        />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="font-semibold">{auto.name}</h3>
                          <Badge
                            variant={auto.isActive ? "default" : "secondary"}
                            className={
                              auto.isActive
                                ? "bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20"
                                : ""
                            }
                          >
                            {auto.isActive ? "Active" : "Paused"}
                          </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground mt-0.5">
                          {auto.description || "No description"}
                        </p>
                        <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Zap className="w-3 h-3" />
                            {triggerLabels[auto.trigger] || auto.trigger}
                          </span>
                          <ArrowRight className="w-3 h-3" />
                          <span>
                            {Array.isArray(auto.actions)
                              ? auto.actions.length
                              : 0}{" "}
                            actions
                          </span>
                          {auto.runCount && auto.runCount > 0 && (
                            <span>• {auto.runCount} runs</span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => toggleMutation.mutate({ id: auto.id })}
                      >
                        {auto.isActive ? (
                          <Pause className="w-4 h-4 text-amber-500" />
                        ) : (
                          <Play className="w-4 h-4 text-emerald-500" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-red-500"
                        onClick={() => deleteMutation.mutate({ id: auto.id })}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
