import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { Plus, ChevronLeft, ChevronRight, Clock, Trash2, Sparkles, Shield, RotateCcw, XCircle } from "lucide-react";
import { toast } from "sonner";

const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const contentTypeColors: Record<string, string> = {
  educational: "bg-blue-500",
  promotional: "bg-amber-500",
  engagement: "bg-emerald-500",
  awareness: "bg-purple-500",
  conversion: "bg-red-500",
};

export default function CalendarPage() {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const utils = trpc.useUtils();

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const monthStr = `${year}-${String(month + 1).padStart(2, "0")}`;

  const { data: schedules, isLoading } = trpc.schedule.list.useQuery({
    month: monthStr,
  });
  const { data: publishingQueue } = trpc.publishing.getPublishingQueue.useQuery();

  const createMutation = trpc.schedule.create.useMutation({
    onSuccess: () => {
      utils.schedule.list.invalidate();
      setCreateOpen(false);
      toast.success("Scheduled successfully!");
    },
  });

  const deleteMutation = trpc.schedule.delete.useMutation({
    onSuccess: () => {
      utils.schedule.list.invalidate();
      toast.success("Schedule removed!");
    },
  });

  // Calendar grid
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();
  const isToday = (d: number) =>
    today.getDate() === d &&
    today.getMonth() === month &&
    today.getFullYear() === year;

  const getSchedulesForDate = (day: number) => {
    const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return schedules?.filter((s) => {
      const sDate = s.scheduledDate instanceof Date
        ? s.scheduledDate.toISOString().slice(0, 10)
        : String(s.scheduledDate).slice(0, 10);
      return sDate === dateStr;
    }) ?? [];
  };

  const getQueueForDate = (day: number) => {
    const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return publishingQueue?.filter((q) => {
      if (!q.scheduledAt) return false;
      const qDate = q.scheduledAt instanceof Date
        ? q.scheduledAt.toISOString().slice(0, 10)
        : String(q.scheduledAt).slice(0, 10);
      return qDate === dateStr;
    }) ?? [];
  };

  function prevMonth() {
    setCurrentDate(new Date(year, month - 1, 1));
  }

  function nextMonth() {
    setCurrentDate(new Date(year, month + 1, 1));
  }

  function handleDateClick(day: number) {
    const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    setSelectedDate(dateStr);
    setCreateOpen(true);
  }

  function handleCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    createMutation.mutate({
      title: form.get("title") as string,
      platform: form.get("platform") as string,
      scheduledDate: selectedDate || (form.get("scheduledDate") as string),
      scheduledTime: (form.get("scheduledTime") as string) || undefined,
      contentType: (form.get("contentType") as any) || undefined,
      notes: (form.get("notes") as string) || undefined,
    });
  }

  const monthLabel = currentDate.toLocaleString("default", {
    month: "long",
    year: "numeric",
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Content Calendar</h1>
          <p className="text-muted-foreground mt-1">
            Schedule and manage your content across all platforms.
          </p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] hover:opacity-90">
              <Plus className="w-4 h-4 mr-2" />
              Schedule Post
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Schedule Content</DialogTitle>
              <DialogDescription>
                Choose a date and time to publish your content.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-4 mt-4">
              <div>
                <Label>Title</Label>
                <Input name="title" placeholder="Summer sale post" required />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Platform</Label>
                  <Select name="platform" defaultValue="instagram">
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="instagram">Instagram</SelectItem>
                      <SelectItem value="tiktok">TikTok</SelectItem>
                      <SelectItem value="linkedin">LinkedIn</SelectItem>
                      <SelectItem value="facebook">Facebook</SelectItem>
                      <SelectItem value="twitter">Twitter</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Content Type</Label>
                  <Select name="contentType" defaultValue="educational">
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="educational">Educational</SelectItem>
                      <SelectItem value="promotional">Promotional</SelectItem>
                      <SelectItem value="engagement">Engagement</SelectItem>
                      <SelectItem value="awareness">Awareness</SelectItem>
                      <SelectItem value="conversion">Conversion</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {!selectedDate && (
                <div>
                  <Label>Date</Label>
                  <Input name="scheduledDate" type="date" required />
                </div>
              )}
              <div>
                <Label>Time</Label>
                <Input name="scheduledTime" type="time" defaultValue="09:00" />
              </div>
              <div>
                <Label>Notes</Label>
                <Input name="notes" placeholder="Any additional notes..." />
              </div>
              <Button
                type="submit"
                className="w-full bg-gradient-to-r from-[#00D4FF] to-[#7C3AED]"
                disabled={createMutation.isPending}
              >
                {createMutation.isPending ? "Scheduling..." : "Schedule"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Calendar */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <div className="flex items-center gap-4">
            <CardTitle>{monthLabel}</CardTitle>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon" onClick={prevMonth}>
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <Button variant="ghost" size="icon" onClick={nextMonth}>
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
          <div className="flex items-center gap-3 text-xs">
            {Object.entries(contentTypeColors).map(([type, color]) => (
              <div key={type} className="flex items-center gap-1">
                <div className={`w-2 h-2 rounded-full ${color}`} />
                <span className="capitalize">{type}</span>
              </div>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {/* Day headers */}
          <div className="grid grid-cols-7 gap-1 mb-2">
            {days.map((d) => (
              <div
                key={d}
                className="text-center text-xs font-medium text-muted-foreground py-2"
              >
                {d}
              </div>
            ))}
          </div>

          {/* Calendar grid */}
          <div className="grid grid-cols-7 gap-1">
            {/* Empty cells */}
            {Array.from({ length: firstDay }).map((_, i) => (
              <div key={`empty-${i}`} className="h-24 rounded-lg" />
            ))}

            {/* Days */}
            {Array.from({ length: daysInMonth }).map((_, i) => {
              const day = i + 1;
              const daySchedules = getSchedulesForDate(day);
              const dayQueue = getQueueForDate(day);
              const todayClass = isToday(day)
                ? "ring-2 ring-[#00D4FF] ring-offset-1"
                : "";

              return (
                <div
                  key={day}
                  className={`h-24 rounded-lg border border-border/50 hover:border-primary/50 transition-colors cursor-pointer bg-card ${todayClass}`}
                  onClick={() => handleDateClick(day)}
                >
                  <div className="p-1.5">
                    <span
                      className={`text-xs font-medium ${
                        isToday(day) ? "text-[#00D4FF]" : "text-muted-foreground"
                      }`}
                    >
                      {day}
                    </span>
                    <div className="mt-0.5 space-y-0.5">
                      {daySchedules.slice(0, 2).map((s) => (
                        <div
                          key={s.id}
                          className={`h-1.5 rounded-full ${
                            contentTypeColors[s.contentType || "educational"] ||
                            "bg-gray-300"
                          }`}
                          title={s.title}
                        />
                      ))}
                      {dayQueue.slice(0, 2).map((q) => (
                        <div
                          key={`q-${q.id}`}
                          className={`h-1.5 rounded-full ${
                            q.status === "published"
                              ? "bg-emerald-400"
                              : q.status === "approved"
                              ? "bg-purple-400"
                              : "bg-amber-400"
                          }`}
                          title={`AI Scheduled: ${q.platform}`}
                        />
                      ))}
                      {(daySchedules.length + dayQueue.length) > 3 && (
                        <p className="text-[9px] text-muted-foreground">
                          +{(daySchedules.length + dayQueue.length) - 3} more
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Upcoming Schedule */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Upcoming Posts</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading ? (
            <div className="animate-pulse space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-12 bg-muted rounded" />
              ))}
            </div>
          ) : schedules?.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              No scheduled posts yet. Click on a date to schedule content.
            </p>
          ) : (
            schedules?.slice(0, 10).map((s) => (
              <div
                key={s.id}
                className="flex items-center justify-between p-3 rounded-lg bg-muted/50 hover:bg-muted transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`w-3 h-3 rounded-full ${
                      contentTypeColors[s.contentType || "educational"] || "bg-gray-300"
                    }`}
                  />
                  <div>
                    <p className="text-sm font-medium">{s.title}</p>
                    <p className="text-xs text-muted-foreground capitalize">
                      {s.platform} • {s.contentType}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {s.scheduledTime || "09:00"}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-red-500"
                    onClick={() => deleteMutation.mutate({ id: s.id })}
                  >
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* AI Scheduled Posts */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-purple-400" />
            AI Scheduled Posts
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {!publishingQueue || publishingQueue.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              No AI-scheduled posts yet. Approve a campaign launch to generate a publishing schedule.
            </p>
          ) : (
            publishingQueue
              .filter((q) => q.status !== "published")
              .sort((a, b) => {
                const dateA = a.scheduledAt ? new Date(a.scheduledAt).getTime() : 0;
                const dateB = b.scheduledAt ? new Date(b.scheduledAt).getTime() : 0;
                return dateA - dateB;
              })
              .slice(0, 10)
              .map((q) => {
                const statusColor =
                  q.status === "approved" ? "bg-purple-400" :
                  q.status === "pending_approval" ? "bg-amber-400" :
                  q.status === "safety_blocked" ? "bg-red-400" :
                  q.status === "retrying" ? "bg-blue-400" :
                  q.status === "failed" ? "bg-red-500" :
                  "bg-gray-300";
                return (
                  <div
                    key={q.id}
                    className="flex items-center justify-between p-3 rounded-lg bg-muted/50 hover:bg-muted transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <div className={`w-3 h-3 rounded-full ${statusColor}`} />
                      <div>
                        <p className="text-sm font-medium">{q.platform}</p>
                        <p className="text-xs text-muted-foreground capitalize">
                          {q.status.replace(/_/g, " ")}
                        </p>
                        {q.safetyStatus && q.safetyStatus !== "low" && (
                          <p className={`text-[10px] flex items-center gap-0.5 mt-0.5 ${
                            q.safetyStatus === "high" ? "text-red-400" : "text-amber-400"
                          }`}>
                            <Shield className="w-2.5 h-2.5" />
                            Safety: {q.safetyStatus}
                          </p>
                        )}
                        {q.retryCount > 0 && q.status === "retrying" && (
                          <p className="text-[10px] text-blue-400 flex items-center gap-0.5 mt-0.5">
                            <RotateCcw className="w-2.5 h-2.5" />
                            Retry {q.retryCount}/{q.maxRetries}
                          </p>
                        )}
                        {q.lastError && q.status === "failed" && (
                          <p className="text-[10px] text-red-400 flex items-center gap-0.5 mt-0.5">
                            <XCircle className="w-2.5 h-2.5" />
                            {q.lastError.substring(0, 60)}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {q.scheduledAt
                          ? new Date(q.scheduledAt).toLocaleDateString()
                          : "Not scheduled"}
                      </span>
                    </div>
                  </div>
                );
              })
          )}
        </CardContent>
      </Card>
    </div>
  );
}
