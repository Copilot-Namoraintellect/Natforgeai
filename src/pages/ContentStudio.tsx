import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import {
  PenTool,
  Plus,
  Sparkles,
  Copy,
  Check,
  Instagram,
  Linkedin,
  Facebook,
  Video,
  FileText,
  Mail,
  Trash2,
  Search,
} from "lucide-react";
import { toast } from "sonner";

const platforms = [
  { value: "instagram", label: "Instagram", icon: Instagram },
  { value: "tiktok", label: "TikTok", icon: Video },
  { value: "linkedin", label: "LinkedIn", icon: Linkedin },
  { value: "facebook", label: "Facebook", icon: Facebook },
  { value: "email", label: "Email", icon: Mail },
  { value: "blog", label: "Blog", icon: FileText },
];

const tones = ["friendly", "premium", "bold", "professional", "casual", "urgent"];

export default function ContentStudio() {
  const [activeTab, setActiveTab] = useState("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [aiForm, setAiForm] = useState({
    business: "",
    platform: "instagram",
    audience: "",
    tone: "friendly",
    type: "social_post" as "social_post" | "ad_copy" | "email",
    goal: "",
  });
  const [aiResult, setAiResult] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [search, setSearch] = useState("");

  const utils = trpc.useUtils();
  const { data: contents, isLoading } = trpc.content.list.useQuery(
    activeTab === "all" ? undefined : { type: activeTab as any }
  );

  const createMutation = trpc.content.create.useMutation({
    onSuccess: () => {
      utils.content.list.invalidate();
      setCreateOpen(false);
      toast.success("Content created!");
    },
  });

  const deleteMutation = trpc.content.delete.useMutation({
    onSuccess: () => {
      utils.content.list.invalidate();
      toast.success("Content deleted!");
    },
  });

  const filtered = contents?.filter((c) =>
    c.title.toLowerCase().includes(search.toLowerCase())
  );

  const typeColors: Record<string, string> = {
    social_post: "bg-[#00D4FF]/10 text-[#00D4FF]",
    ad_copy: "bg-amber-500/10 text-amber-600",
    email: "bg-emerald-500/10 text-emerald-600",
    script: "bg-purple-500/10 text-purple-600",
    blog: "bg-blue-500/10 text-blue-600",
    story: "bg-pink-500/10 text-pink-600",
  };

  async function generateWithAI() {
    setAiLoading(true);
    try {
      let prompt = "";
      if (aiForm.type === "social_post") {
        prompt = `Create 3 high-converting social media posts for ${aiForm.business}.
Platform: ${aiForm.platform}
Audience: ${aiForm.audience}
Tone: ${aiForm.tone}

For each post provide:
- Hook (attention-grabbing first line)
- Caption (main content)
- CTA (call-to-action)
- Relevant hashtags

Make them engaging and action-oriented.`;
      } else if (aiForm.type === "ad_copy") {
        prompt = `Create 3 high-converting ad copies for ${aiForm.business}.
Goal: ${aiForm.goal || "Conversions"}
Audience: ${aiForm.audience}
Tone: ${aiForm.tone}

For each ad provide:
- Scroll-stopping headline
- Pain point
- Solution
- Strong CTA

Keep them short, punchy, and conversion-focused.`;
      } else {
        prompt = `Create a professional email for ${aiForm.business}.
Goal: ${aiForm.goal || "Engagement"}
Audience: ${aiForm.audience}
Tone: ${aiForm.tone}

Include:
- Subject line
- Opening hook
- Body content
- Call-to-action
- Professional sign-off`;
      }

      const result = await generateText({
        model: openai("gpt-4o-mini"),
        prompt,
      });

      setAiResult(result.text);
    } catch (error) {
      toast.error("Failed to generate content. Try again.");
    } finally {
      setAiLoading(false);
    }
  }

  function copyToClipboard(text: string, id: number) {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
    toast.success("Copied to clipboard!");
  }

  function handleCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    createMutation.mutate({
      title: form.get("title") as string,
      type: (form.get("type") as any) || "social_post",
      platform: (form.get("platform") as string) || undefined,
      hook: (form.get("hook") as string) || undefined,
      caption: (form.get("caption") as string) || undefined,
      cta: (form.get("cta") as string) || undefined,
      body: (form.get("body") as string) || undefined,
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Content Studio</h1>
          <p className="text-muted-foreground mt-1">
            Create, generate, and manage your marketing content.
          </p>
        </div>
        <div className="flex gap-2">
          <Dialog open={aiOpen} onOpenChange={setAiOpen}>
            <DialogTrigger asChild>
              <Button
                variant="outline"
                className="border-[#00D4FF]/50 text-[#00D4FF] hover:bg-[#00D4FF]/10"
              >
                <Sparkles className="w-4 h-4 mr-2" />
                AI Generate
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>AI Content Generator</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 mt-4">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>Business</Label>
                    <Input
                      value={aiForm.business}
                      onChange={(e) =>
                        setAiForm({ ...aiForm, business: e.target.value })
                      }
                      placeholder="3@1 Newmarket"
                    />
                  </div>
                  <div>
                    <Label>Content Type</Label>
                    <Select
                      value={aiForm.type}
                      onValueChange={(v: any) =>
                        setAiForm({ ...aiForm, type: v })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="social_post">Social Post</SelectItem>
                        <SelectItem value="ad_copy">Ad Copy</SelectItem>
                        <SelectItem value="email">Email</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>Platform</Label>
                    <Select
                      value={aiForm.platform}
                      onValueChange={(v) =>
                        setAiForm({ ...aiForm, platform: v })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {platforms.map((p) => (
                          <SelectItem key={p.value} value={p.value}>
                            {p.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Tone</Label>
                    <Select
                      value={aiForm.tone}
                      onValueChange={(v) =>
                        setAiForm({ ...aiForm, tone: v })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {tones.map((t) => (
                          <SelectItem key={t} value={t}>
                            {t.charAt(0).toUpperCase() + t.slice(1)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div>
                  <Label>Target Audience</Label>
                  <Input
                    value={aiForm.audience}
                    onChange={(e) =>
                      setAiForm({ ...aiForm, audience: e.target.value })
                    }
                    placeholder="Young professionals aged 25-40 in Johannesburg"
                  />
                </div>
                <div>
                  <Label>Goal (optional)</Label>
                  <Input
                    value={aiForm.goal}
                    onChange={(e) =>
                      setAiForm({ ...aiForm, goal: e.target.value })
                    }
                    placeholder="Drive sales, increase awareness..."
                  />
                </div>
                <Button
                  onClick={generateWithAI}
                  disabled={aiLoading || !aiForm.business}
                  className="w-full bg-gradient-to-r from-[#00D4FF] to-[#7C3AED]"
                >
                  {aiLoading ? (
                    <>
                      <div className="w-4 h-4 mr-2 animate-spin rounded-full border-2 border-white border-t-transparent" />
                      Generating...
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4 mr-2" />
                      Generate Content
                    </>
                  )}
                </Button>

                {aiResult && (
                  <div className="mt-4">
                    <Label>Generated Content</Label>
                    <div className="relative mt-1">
                      <Textarea
                        value={aiResult}
                        onChange={(e) => setAiResult(e.target.value)}
                        className="min-h-[300px] font-mono text-sm"
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        className="absolute top-2 right-2"
                        onClick={() =>
                          copyToClipboard(aiResult, -1)
                        }
                      >
                        {copiedId === -1 ? (
                          <Check className="w-4 h-4" />
                        ) : (
                          <Copy className="w-4 h-4" />
                        )}
                      </Button>
                    </div>
                    <Button
                      className="w-full mt-3"
                      variant="outline"
                      onClick={() => {
                        createMutation.mutate({
                          title: `AI Generated - ${aiForm.type}`,
                          type: aiForm.type,
                          platform: aiForm.platform,
                          body: aiResult,
                          aiGenerated: true,
                        });
                        setAiOpen(false);
                        setAiResult("");
                      }}
                    >
                      Save to Library
                    </Button>
                  </div>
                )}
              </div>
            </DialogContent>
          </Dialog>

          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] hover:opacity-90">
                <Plus className="w-4 h-4 mr-2" />
                Add Content
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Add Content</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleCreate} className="space-y-4 mt-4">
                <div>
                  <Label>Title</Label>
                  <Input name="title" placeholder="Summer sale announcement" required />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>Type</Label>
                    <Select name="type" defaultValue="social_post">
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="social_post">Social Post</SelectItem>
                        <SelectItem value="ad_copy">Ad Copy</SelectItem>
                        <SelectItem value="email">Email</SelectItem>
                        <SelectItem value="script">Script</SelectItem>
                        <SelectItem value="blog">Blog</SelectItem>
                        <SelectItem value="story">Story</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Platform</Label>
                    <Select name="platform">
                      <SelectTrigger>
                        <SelectValue placeholder="Select" />
                      </SelectTrigger>
                      <SelectContent>
                        {platforms.map((p) => (
                          <SelectItem key={p.value} value={p.value}>
                            {p.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div>
                  <Label>Hook</Label>
                  <Input name="hook" placeholder="Attention-grabbing first line" />
                </div>
                <div>
                  <Label>Caption / Body</Label>
                  <Textarea name="caption" placeholder="Main content..." />
                </div>
                <div>
                  <Label>CTA</Label>
                  <Input name="cta" placeholder="Shop now!" />
                </div>
                <div>
                  <Label>Body / Notes</Label>
                  <Textarea name="body" placeholder="Additional content..." />
                </div>
                <Button
                  type="submit"
                  className="w-full bg-gradient-to-r from-[#00D4FF] to-[#7C3AED]"
                  disabled={createMutation.isPending}
                >
                  {createMutation.isPending ? "Saving..." : "Save Content"}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Tabs & Search */}
      <div className="flex flex-col sm:flex-row gap-4">
        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className="flex-1"
        >
          <TabsList className="flex-wrap h-auto">
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="social_post">Social</TabsTrigger>
            <TabsTrigger value="ad_copy">Ads</TabsTrigger>
            <TabsTrigger value="email">Email</TabsTrigger>
            <TabsTrigger value="script">Script</TabsTrigger>
            <TabsTrigger value="blog">Blog</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search content..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Content Grid */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[1, 2].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="p-6 h-32" />
            </Card>
          ))}
        </div>
      ) : (filtered ?? []).length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <PenTool className="w-12 h-12 text-muted-foreground mb-4" />
            <p className="text-lg font-medium">No content yet</p>
            <p className="text-sm text-muted-foreground mt-1 mb-4">
              Create content or use AI to generate it.
            </p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setAiOpen(true)}>
                <Sparkles className="w-4 h-4 mr-2" />
                AI Generate
              </Button>
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="w-4 h-4 mr-2" />
                Add Manually
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {(filtered ?? []).map((content) => (
            <Card key={content.id} className="group hover:shadow-md transition-all">
              <CardContent className="p-5">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="secondary"
                      className={typeColors[content.type] || "bg-muted"}
                    >
                      {content.type.replace("_", " ")}
                    </Badge>
                    {content.aiGenerated && (
                      <Badge variant="outline" className="flex items-center gap-1">
                        <Sparkles className="w-3 h-3" />
                        AI
                      </Badge>
                    )}
                  </div>
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() =>
                        copyToClipboard(
                          `${content.hook || ""}\n${content.caption || ""}\n${content.cta || ""}\n${content.body || ""}`,
                          content.id
                        )
                      }
                    >
                      {copiedId === content.id ? (
                        <Check className="w-3.5 h-3.5 text-emerald-500" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-red-500 hover:text-red-600"
                      onClick={() => deleteMutation.mutate({ id: content.id })}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
                <h3 className="font-semibold text-sm mb-2">{content.title}</h3>
                {content.hook && (
                  <p className="text-sm text-muted-foreground line-clamp-1 mb-1">
                    <span className="font-medium text-foreground">Hook:</span>{" "}
                    {content.hook}
                  </p>
                )}
                {content.caption && (
                  <p className="text-sm text-muted-foreground line-clamp-2 mb-1">
                    {content.caption}
                  </p>
                )}
                {content.cta && (
                  <p className="text-xs font-medium text-[#00D4FF] mt-1">
                    CTA: {content.cta}
                  </p>
                )}
                {content.platform && (
                  <p className="text-xs text-muted-foreground mt-2 capitalize">
                    Platform: {content.platform}
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
