import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  FileText,
  Copy,
  Check,
  Search,
  Megaphone,
  Target,
  Video,
  Palette,
  Calendar,
  Bot,
  Users,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

const categoryIcons: Record<string, any> = {
  strategy: Megaphone,
  content: FileText,
  ads: Target,
  design: Palette,
  video: Video,
  targeting: Target,
  scheduling: Calendar,
  chatbot: Bot,
  crm: Users,
  automation: Zap,
};

const categoryColors: Record<string, string> = {
  strategy: "bg-[#00D4FF]/10 text-[#00D4FF]",
  content: "bg-blue-500/10 text-blue-600",
  ads: "bg-amber-500/10 text-amber-600",
  design: "bg-pink-500/10 text-pink-600",
  video: "bg-purple-500/10 text-purple-600",
  targeting: "bg-emerald-500/10 text-emerald-600",
  scheduling: "bg-cyan-500/10 text-cyan-600",
  chatbot: "bg-violet-500/10 text-violet-600",
  crm: "bg-teal-500/10 text-teal-600",
  automation: "bg-orange-500/10 text-orange-600",
};

export default function Templates() {
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState("all");
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const { data: templates, isLoading } = trpc.template.list.useQuery(
    activeTab === "all" ? undefined : { category: activeTab as any }
  );

  const filtered = templates?.filter((t) =>
    t.name.toLowerCase().includes(search.toLowerCase()) ||
    t.description?.toLowerCase().includes(search.toLowerCase())
  );

  function copyPrompt(prompt: string, id: number) {
    navigator.clipboard.writeText(prompt);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
    toast.success("Prompt copied to clipboard!");
  }

  function getVariablePlaceholders(prompt: string): string[] {
    const matches = prompt.match(/\{\{(\w+)\}\}/g);
    return matches ? matches.map((m) => m.replace(/[{}]/g, "")) : [];
  }

  const categories = [
    "all",
    "strategy",
    "content",
    "ads",
    "design",
    "video",
    "targeting",
    "scheduling",
    "chatbot",
    "crm",
    "automation",
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Prompt Library</h1>
        <p className="text-muted-foreground mt-1">
          Your pre-built marketing prompts for AI tools. Copy and customize for your needs.
        </p>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          className="pl-9"
          placeholder="Search templates..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Category Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="flex-wrap h-auto gap-1">
          {categories.map((cat) => (
            <TabsTrigger key={cat} value={cat} className="capitalize text-xs">
              {cat}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* Templates Grid */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="p-6 h-32" />
            </Card>
          ))}
        </div>
      ) : (filtered ?? []).length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <FileText className="w-12 h-12 text-muted-foreground mb-4" />
            <p className="text-lg font-medium">No templates found</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {(filtered ?? []).map((template) => {
            const Icon = categoryIcons[template.category] || FileText;
            const vars = getVariablePlaceholders(template.prompt);
            const isExpanded = expandedId === template.id;

            return (
              <Card
                key={template.id}
                className="hover:shadow-md transition-all cursor-pointer"
                onClick={() => setExpandedId(isExpanded ? null : template.id)}
              >
                <CardContent className="p-5">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <div
                        className={`p-2 rounded-lg ${
                          categoryColors[template.category] || "bg-muted"
                        }`}
                      >
                        <Icon className="w-4 h-4" />
                      </div>
                      <div>
                        <h3 className="font-semibold text-sm">{template.name}</h3>
                        {template.description && (
                          <p className="text-xs text-muted-foreground line-clamp-1">
                            {template.description}
                          </p>
                        )}
                      </div>
                    </div>
                    <Badge
                      variant="secondary"
                      className={`capitalize text-xs ${
                        categoryColors[template.category] || "bg-muted"
                      }`}
                    >
                      {template.category}
                    </Badge>
                  </div>

                  {/* Variables */}
                  {vars.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-3">
                      {vars.map((v) => (
                        <span
                          key={v}
                          className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
                        >
                          {v}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Expanded view */}
                  {isExpanded && (
                    <div className="mt-3 space-y-3">
                      <div className="bg-muted rounded-lg p-3 relative group">
                        <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-mono leading-relaxed">
                          {template.prompt}
                        </pre>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={(e) => {
                            e.stopPropagation();
                            copyPrompt(template.prompt, template.id);
                          }}
                        >
                          {copiedId === template.id ? (
                            <Check className="w-3.5 h-3.5 text-emerald-500" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </Button>
                      </div>
                      <Button
                        size="sm"
                        className="w-full bg-gradient-to-r from-[#00D4FF] to-[#7C3AED]"
                        onClick={(e) => {
                          e.stopPropagation();
                          copyPrompt(template.prompt, template.id);
                        }}
                      >
                        <Copy className="w-3.5 h-3.5 mr-2" />
                        Copy Prompt
                      </Button>
                    </div>
                  )}

                  {!isExpanded && (
                    <p className="text-xs text-muted-foreground">
                      Click to expand and view prompt
                    </p>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
