import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import {
  Settings2,
  Shield,
  Megaphone,
  MessageSquare,
  DollarSign,
  Save,
} from "lucide-react";

const platforms = [
  { id: "instagram", label: "Instagram" },
  { id: "facebook", label: "Facebook" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "tiktok", label: "TikTok" },
  { id: "twitter", label: "X / Twitter" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "email", label: "Email" },
];

export default function AutonomousSettings() {
  const [settings, setSettings] = useState({
    maxDailyAdSpend: "50",
    approvalMode: "assisted" as "assisted" | "autonomous",
    toneStrictness: "medium" as "low" | "medium" | "high",
    requireApprovalBeforePosting: true,
    requireApprovalBeforeReplying: true,
    requireApprovalForHighValueLeads: true,
    highValueLeadThreshold: "1000",
    enabledPlatforms: ["instagram", "facebook", "linkedin"],
    escalationRules: {
      sensitiveTopics: true,
      pricingDisputes: true,
      competitorMentions: false,
      negativeSentiment: true,
    },
  });

  const togglePlatform = (platform: string) => {
    setSettings((prev) => ({
      ...prev,
      enabledPlatforms: prev.enabledPlatforms.includes(platform)
        ? prev.enabledPlatforms.filter((p) => p !== platform)
        : [...prev.enabledPlatforms, platform],
    }));
  };

  const handleSave = () => {
    toast.success("Settings saved successfully");
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <Settings2 className="w-6 h-6 text-[#00D4FF]" />
          Autonomous Settings
        </h1>
        <p className="text-gray-400 mt-1">
          Define your AI automation boundaries and approval rules
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Approval Mode */}
        <Card className="bg-[#1E293B] border-[#334155]">
          <CardHeader className="pb-3">
            <CardTitle className="text-white text-base flex items-center gap-2">
              <Shield className="w-4 h-4 text-[#00D4FF]" />
              Approval Mode
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => setSettings((p) => ({ ...p, approvalMode: "assisted" }))}
                className={`p-4 rounded-xl border text-left transition-all ${
                  settings.approvalMode === "assisted"
                    ? "border-[#00D4FF] bg-[#00D4FF]/10"
                    : "border-[#334155] bg-[#0F172A] hover:border-gray-500"
                }`}
              >
                <p className="font-semibold text-white text-sm">Assisted</p>
                <p className="text-xs text-gray-400 mt-1">
                  AI asks before major actions
                </p>
              </button>
              <button
                onClick={() => setSettings((p) => ({ ...p, approvalMode: "autonomous" }))}
                className={`p-4 rounded-xl border text-left transition-all ${
                  settings.approvalMode === "autonomous"
                    ? "border-[#00D4FF] bg-[#00D4FF]/10"
                    : "border-[#334155] bg-[#0F172A] hover:border-gray-500"
                }`}
              >
                <p className="font-semibold text-white text-sm">Autonomous</p>
                <p className="text-xs text-gray-400 mt-1">
                  AI operates within your rules
                </p>
              </button>
            </div>
          </CardContent>
        </Card>

        {/* Budget Controls */}
        <Card className="bg-[#1E293B] border-[#334155]">
          <CardHeader className="pb-3">
            <CardTitle className="text-white text-base flex items-center gap-2">
              <DollarSign className="w-4 h-4 text-emerald-400" />
              Budget Controls
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label className="text-gray-300">Maximum Daily Ad Spend (USD)</Label>
              <Input
                type="number"
                value={settings.maxDailyAdSpend}
                onChange={(e) =>
                  setSettings((p) => ({ ...p, maxDailyAdSpend: e.target.value }))
                }
                className="bg-[#0F172A] border-[#334155] text-white"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-gray-300">High-Value Lead Threshold (USD)</Label>
              <Input
                type="number"
                value={settings.highValueLeadThreshold}
                onChange={(e) =>
                  setSettings((p) => ({ ...p, highValueLeadThreshold: e.target.value }))
                }
                className="bg-[#0F172A] border-[#334155] text-white"
              />
            </div>
          </CardContent>
        </Card>

        {/* Content Approval */}
        <Card className="bg-[#1E293B] border-[#334155]">
          <CardHeader className="pb-3">
            <CardTitle className="text-white text-base flex items-center gap-2">
              <Megaphone className="w-4 h-4 text-purple-400" />
              Content Approval
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label className="text-gray-300">Tone Strictness</Label>
              <Select
                value={settings.toneStrictness}
                onValueChange={(v) =>
                  setSettings((p) => ({ ...p, toneStrictness: v as any }))
                }
              >
                <SelectTrigger className="bg-[#0F172A] border-[#334155] text-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[#1E293B] border-[#334155]">
                  <SelectItem value="low" className="text-white">Low — Creative freedom</SelectItem>
                  <SelectItem value="medium" className="text-white">Medium — Balanced</SelectItem>
                  <SelectItem value="high" className="text-white">High — Strict brand</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-3 pt-2">
              <div className="flex items-center justify-between">
                <Label className="text-gray-300 text-sm">Require approval before posting</Label>
                <Switch
                  checked={settings.requireApprovalBeforePosting}
                  onCheckedChange={(v) =>
                    setSettings((p) => ({ ...p, requireApprovalBeforePosting: v }))
                  }
                />
              </div>
              <div className="flex items-center justify-between">
                <Label className="text-gray-300 text-sm">Require approval before public replies</Label>
                <Switch
                  checked={settings.requireApprovalBeforeReplying}
                  onCheckedChange={(v) =>
                    setSettings((p) => ({ ...p, requireApprovalBeforeReplying: v }))
                  }
                />
              </div>
              <div className="flex items-center justify-between">
                <Label className="text-gray-300 text-sm">Require approval for high-value leads</Label>
                <Switch
                  checked={settings.requireApprovalForHighValueLeads}
                  onCheckedChange={(v) =>
                    setSettings((p) => ({ ...p, requireApprovalForHighValueLeads: v }))
                  }
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Platforms */}
        <Card className="bg-[#1E293B] border-[#334155]">
          <CardHeader className="pb-3">
            <CardTitle className="text-white text-base flex items-center gap-2">
              <Megaphone className="w-4 h-4 text-cyan-400" />
              Enabled Platforms
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {platforms.map((p) => (
                <button
                  key={p.id}
                  onClick={() => togglePlatform(p.id)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                    settings.enabledPlatforms.includes(p.id)
                      ? "bg-[#00D4FF]/20 text-[#00D4FF] border border-[#00D4FF]/30"
                      : "bg-[#0F172A] text-gray-400 border border-[#334155] hover:text-white"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Escalation Rules */}
        <Card className="bg-[#1E293B] border-[#334155] lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-white text-base flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-amber-400" />
              Escalation Rules
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {[
                { key: "sensitiveTopics", label: "Sensitive topics" },
                { key: "pricingDisputes", label: "Pricing disputes" },
                { key: "competitorMentions", label: "Competitor mentions" },
                { key: "negativeSentiment", label: "Negative sentiment" },
              ].map((rule) => (
                <div key={rule.key} className="flex items-center justify-between p-3 rounded-lg bg-[#0F172A] border border-[#334155]">
                  <span className="text-gray-300 text-sm">{rule.label}</span>
                  <Switch
                    checked={settings.escalationRules[rule.key as keyof typeof settings.escalationRules]}
                    onCheckedChange={(v) =>
                      setSettings((p) => ({
                        ...p,
                        escalationRules: { ...p.escalationRules, [rule.key]: v },
                      }))
                    }
                  />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Save Button */}
      <div className="flex justify-end">
        <Button
          onClick={handleSave}
          className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] text-white hover:opacity-90"
        >
          <Save className="w-4 h-4 mr-2" />
          Save Settings
        </Button>
      </div>
    </div>
  );
}
