import { useState } from "react";
import { useNavigate } from "react-router";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import {
  Building2,
  Target,
  Sparkles,
  Rocket,
  ChevronRight,
  ChevronLeft,
  Globe,
  MapPin,
  Users,
  Wallet,
  MessageSquare,
  Check,
} from "lucide-react";

const brandTones = [
  "friendly",
  "premium",
  "bold",
  "professional",
  "casual",
  "urgent",
  "playful",
  "authoritative",
];

const industries = [
  "Technology",
  "E-commerce",
  "Healthcare",
  "Finance",
  "Education",
  "Real Estate",
  "Hospitality",
  "Manufacturing",
  "Retail",
  "Services",
  "Other",
];

const platforms = [
  { value: "instagram", label: "Instagram" },
  { value: "facebook", label: "Facebook" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "tiktok", label: "TikTok" },
  { value: "twitter", label: "X/Twitter" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "email", label: "Email" },
];

export default function Onboarding() {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const [step, setStep] = useState(1);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [businessForm, setBusinessForm] = useState({
    name: "",
    website: "",
    industry: "",
    location: "",
    productOrService: "",
    targetCustomer: "",
    monthlyBudget: "",
    brandTone: "",
    mainGoal: "",
    whatsappNumber: "",
    preferredPlatforms: [] as string[],
  });

  const [strategyForm, setStrategyForm] = useState({
    mode: "generate" as "upload" | "paste" | "generate",
    strategyText: "",
  });

  const [automationForm, setAutomationForm] = useState({
    approvalMode: "assisted" as "assisted" | "autonomous",
    maxDailyAdSpend: "50",
    toneStrictness: "medium" as "low" | "medium" | "high",
    requireApprovalBeforePosting: true,
    requireApprovalBeforeReplying: true,
    requireApprovalForHighValueLeads: true,
  });

  const createBusiness = trpc.business.create.useMutation({
    onSuccess: () => {
      utils.business.list.invalidate();
    },
  });

  const updateUser = trpc.auth.updateMe.useMutation({
    onSuccess: () => {
      utils.auth.me.invalidate();
    },
  });

  const startWorkflow = trpc.autonomousWorkflow.startCampaignWorkflow.useMutation({
    onSuccess: (data) => {
      // Trigger strategy generation if requested
      if (strategyForm.mode === "generate" && data.id) {
        generateStrategy.mutate({
          campaignId: data.id,
          generate: true,
        });
      }
    },
  });

  const generateStrategy = trpc.agent.runStrategyAgent.useMutation({
    onSuccess: () => {
      toast.success("Strategy generated successfully!");
    },
    onError: (err) => {
      toast.error(err.message || "Failed to generate strategy");
    },
  });

  const togglePlatform = (platform: string) => {
    setBusinessForm((prev) => ({
      ...prev,
      preferredPlatforms: prev.preferredPlatforms.includes(platform)
        ? prev.preferredPlatforms.filter((p) => p !== platform)
        : [...prev.preferredPlatforms, platform],
    }));
  };

  const handleNext = () => {
    if (step === 1) {
      if (!businessForm.name || !businessForm.industry) {
        toast.error("Please fill in at least business name and industry");
        return;
      }
    }
    if (step === 2) {
      if (strategyForm.mode === "paste" && !strategyForm.strategyText.trim()) {
        toast.error("Please paste your strategy or choose another option");
        return;
      }
    }
    setStep((s) => Math.min(s + 1, 4));
  };

  const handleBack = () => setStep((s) => Math.max(s - 1, 1));

  const handleComplete = async () => {
    setIsSubmitting(true);
    try {
      // Create business
      const businessResult = await createBusiness.mutateAsync({
        name: businessForm.name,
        website: businessForm.website || undefined,
        industry: businessForm.industry || undefined,
        location: businessForm.location || undefined,
        productOrService: businessForm.productOrService || undefined,
        targetCustomer: businessForm.targetCustomer || undefined,
        monthlyBudget: businessForm.monthlyBudget ? Number(businessForm.monthlyBudget) : undefined,
        brandTone: businessForm.brandTone || undefined,
        mainGoal: businessForm.mainGoal || undefined,
        whatsappNumber: businessForm.whatsappNumber || undefined,
        preferredPlatforms: businessForm.preferredPlatforms.join(","),
      });

      const businessId = businessResult.id;

      // Start campaign workflow
      await startWorkflow.mutateAsync({
        businessId,
        name: `${businessForm.name} Marketing Campaign`,
        goal: businessForm.mainGoal || "Grow brand awareness and drive conversions",
        strategyText: strategyForm.mode === "paste" ? strategyForm.strategyText : undefined,
        approvalMode: automationForm.approvalMode,
        autoPublish: automationForm.approvalMode === "autonomous",
      });

      // Mark user onboarding as complete
      await updateUser.mutateAsync({ onboardingComplete: true });

      toast.success("Onboarding complete! Welcome to NatForge AI.");
      navigate("/mission-control");
    } catch (err: any) {
      toast.error(err.message || "Failed to complete onboarding");
    } finally {
      setIsSubmitting(false);
    }
  };

  const progress = (step / 4) * 100;

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#0F172A] via-[#1E293B] to-[#0F172A] flex items-center justify-center p-4">
      <div className="w-full max-w-3xl">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-[#00D4FF] to-[#7C3AED] mb-4">
            <Rocket className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-3xl font-bold text-white mb-2">Welcome to NatForge AI</h1>
          <p className="text-gray-400">Let&apos;s set up your autonomous marketing system in a few steps</p>
        </div>

        {/* Progress */}
        <div className="mb-8">
          <div className="flex justify-between text-sm text-gray-400 mb-2">
            <span>Business Info</span>
            <span>Strategy</span>
            <span>Preferences</span>
            <span>Review</span>
          </div>
          <Progress value={progress} className="h-2" />
        </div>

        {/* Step Content */}
        <Card className="border-[#334155] bg-[#1E293B]/80 backdrop-blur">
          <CardContent className="p-8">
            {step === 1 && (
              <div className="space-y-6">
                <div className="flex items-center gap-3 mb-6">
                  <Building2 className="w-6 h-6 text-[#00D4FF]" />
                  <h2 className="text-xl font-semibold text-white">Business Information</h2>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label className="text-gray-300">Business Name *</Label>
                    <Input
                      placeholder="Your business name"
                      value={businessForm.name}
                      onChange={(e) => setBusinessForm((p) => ({ ...p, name: e.target.value }))}
                      className="bg-[#0F172A] border-[#334155] text-white"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-gray-300">Website URL</Label>
                    <div className="relative">
                      <Globe className="absolute left-3 top-2.5 w-4 h-4 text-gray-500" />
                      <Input
                        placeholder="https://yourbusiness.com"
                        value={businessForm.website}
                        onChange={(e) => setBusinessForm((p) => ({ ...p, website: e.target.value }))}
                        className="bg-[#0F172A] border-[#334155] text-white pl-10"
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-gray-300">Industry *</Label>
                    <Select
                      value={businessForm.industry}
                      onValueChange={(v) => setBusinessForm((p) => ({ ...p, industry: v }))}
                    >
                      <SelectTrigger className="bg-[#0F172A] border-[#334155] text-white">
                        <SelectValue placeholder="Select industry" />
                      </SelectTrigger>
                      <SelectContent className="bg-[#1E293B] border-[#334155]">
                        {industries.map((i) => (
                          <SelectItem key={i} value={i.toLowerCase()} className="text-white">
                            {i}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-gray-300">Location</Label>
                    <div className="relative">
                      <MapPin className="absolute left-3 top-2.5 w-4 h-4 text-gray-500" />
                      <Input
                        placeholder="City, Country"
                        value={businessForm.location}
                        onChange={(e) => setBusinessForm((p) => ({ ...p, location: e.target.value }))}
                        className="bg-[#0F172A] border-[#334155] text-white pl-10"
                      />
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label className="text-gray-300">Product or Service</Label>
                  <Textarea
                    placeholder="What do you sell or offer?"
                    value={businessForm.productOrService}
                    onChange={(e) => setBusinessForm((p) => ({ ...p, productOrService: e.target.value }))}
                    className="bg-[#0F172A] border-[#334155] text-white"
                  />
                </div>

                <div className="space-y-2">
                  <Label className="text-gray-300">Target Customer</Label>
                  <div className="relative">
                    <Users className="absolute left-3 top-2.5 w-4 h-4 text-gray-500" />
                    <Input
                      placeholder="e.g. Young professionals aged 25-45"
                      value={businessForm.targetCustomer}
                      onChange={(e) => setBusinessForm((p) => ({ ...p, targetCustomer: e.target.value }))}
                      className="bg-[#0F172A] border-[#334155] text-white pl-10"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label className="text-gray-300">Monthly Marketing Budget (USD)</Label>
                    <div className="relative">
                      <Wallet className="absolute left-3 top-2.5 w-4 h-4 text-gray-500" />
                      <Input
                        type="number"
                        placeholder="5000"
                        value={businessForm.monthlyBudget}
                        onChange={(e) => setBusinessForm((p) => ({ ...p, monthlyBudget: e.target.value }))}
                        className="bg-[#0F172A] border-[#334155] text-white pl-10"
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-gray-300">Brand Tone</Label>
                    <Select
                      value={businessForm.brandTone}
                      onValueChange={(v) => setBusinessForm((p) => ({ ...p, brandTone: v }))}
                    >
                      <SelectTrigger className="bg-[#0F172A] border-[#334155] text-white">
                        <SelectValue placeholder="Select tone" />
                      </SelectTrigger>
                      <SelectContent className="bg-[#1E293B] border-[#334155]">
                        {brandTones.map((t) => (
                          <SelectItem key={t} value={t} className="text-white">
                            {t.charAt(0).toUpperCase() + t.slice(1)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label className="text-gray-300">Main Goal</Label>
                  <div className="relative">
                    <Target className="absolute left-3 top-2.5 w-4 h-4 text-gray-500" />
                    <Input
                      placeholder="e.g. Increase sales by 30% in Q4"
                      value={businessForm.mainGoal}
                      onChange={(e) => setBusinessForm((p) => ({ ...p, mainGoal: e.target.value }))}
                      className="bg-[#0F172A] border-[#334155] text-white pl-10"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label className="text-gray-300">WhatsApp Number</Label>
                  <div className="relative">
                    <MessageSquare className="absolute left-3 top-2.5 w-4 h-4 text-gray-500" />
                    <Input
                      placeholder="+1 234 567 8900"
                      value={businessForm.whatsappNumber}
                      onChange={(e) => setBusinessForm((p) => ({ ...p, whatsappNumber: e.target.value }))}
                      className="bg-[#0F172A] border-[#334155] text-white pl-10"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label className="text-gray-300">Preferred Platforms</Label>
                  <div className="flex flex-wrap gap-2">
                    {platforms.map((p) => (
                      <button
                        key={p.value}
                        onClick={() => togglePlatform(p.value)}
                        className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                          businessForm.preferredPlatforms.includes(p.value)
                            ? "bg-[#00D4FF]/20 text-[#00D4FF] border border-[#00D4FF]/30"
                            : "bg-[#0F172A] text-gray-400 border border-[#334155] hover:text-white"
                        }`}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-6">
                <div className="flex items-center gap-3 mb-6">
                  <Sparkles className="w-6 h-6 text-[#00D4FF]" />
                  <h2 className="text-xl font-semibold text-white">Marketing Strategy</h2>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {[
                    { key: "upload" as const, label: "Upload Strategy", desc: "Upload a PDF or document" },
                    { key: "paste" as const, label: "Paste Strategy", desc: "Copy and paste your strategy" },
                    { key: "generate" as const, label: "Generate for Me", desc: "AI creates your strategy" },
                  ].map((option) => (
                    <button
                      key={option.key}
                      onClick={() => setStrategyForm((p) => ({ ...p, mode: option.key }))}
                      className={`p-4 rounded-xl border text-left transition-all ${
                        strategyForm.mode === option.key
                          ? "border-[#00D4FF] bg-[#00D4FF]/10"
                          : "border-[#334155] bg-[#0F172A] hover:border-gray-500"
                      }`}
                    >
                      <p className="font-semibold text-white mb-1">{option.label}</p>
                      <p className="text-sm text-gray-400">{option.desc}</p>
                    </button>
                  ))}
                </div>

                {strategyForm.mode === "upload" && (
                  <div className="p-8 rounded-xl border border-dashed border-[#334155] bg-[#0F172A] text-center">
                    <p className="text-gray-400 mb-2">Drag and drop your strategy document here</p>
                    <p className="text-sm text-gray-500">PDF, Word, or TXT (max 10MB)</p>
                    <Button variant="outline" className="mt-4 border-[#334155] text-white" disabled>
                      Coming Soon
                    </Button>
                  </div>
                )}

                {strategyForm.mode === "paste" && (
                  <div className="space-y-2">
                    <Label className="text-gray-300">Paste Your Strategy</Label>
                    <Textarea
                      placeholder="Paste your marketing strategy here..."
                      value={strategyForm.strategyText}
                      onChange={(e) => setStrategyForm((p) => ({ ...p, strategyText: e.target.value }))}
                      className="bg-[#0F172A] border-[#334155] text-white min-h-[200px]"
                    />
                  </div>
                )}

                {strategyForm.mode === "generate" && (
                  <div className="p-6 rounded-xl bg-gradient-to-br from-[#00D4FF]/10 to-[#7C3AED]/10 border border-[#00D4FF]/20">
                    <div className="flex items-center gap-3 mb-3">
                      <Sparkles className="w-5 h-5 text-[#00D4FF]" />
                      <h3 className="font-semibold text-white">AI Strategy Generation</h3>
                    </div>
                    <p className="text-gray-300 text-sm">
                      Our Strategy Agent will analyze your business profile and generate a complete marketing
                      strategy including target personas, positioning, funnel stages, offers, and CTAs.
                    </p>
                    <div className="mt-4 flex items-center gap-2 text-sm text-gray-400">
                      <Check className="w-4 h-4 text-emerald-400" />
                      <span>Personas &amp; targeting</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-gray-400">
                      <Check className="w-4 h-4 text-emerald-400" />
                      <span>Platform strategy</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-gray-400">
                      <Check className="w-4 h-4 text-emerald-400" />
                      <span>Budget recommendations</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {step === 3 && (
              <div className="space-y-6">
                <div className="flex items-center gap-3 mb-6">
                  <Target className="w-6 h-6 text-[#00D4FF]" />
                  <h2 className="text-xl font-semibold text-white">Automation Preferences</h2>
                </div>

                <div className="space-y-4">
                  <div className="p-4 rounded-xl bg-[#0F172A] border border-[#334155]">
                    <Label className="text-white mb-3 block">Approval Mode</Label>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <button
                        onClick={() => setAutomationForm((p) => ({ ...p, approvalMode: "assisted" }))}
                        className={`p-4 rounded-lg border text-left transition-all ${
                          automationForm.approvalMode === "assisted"
                            ? "border-[#00D4FF] bg-[#00D4FF]/10"
                            : "border-[#334155] hover:border-gray-500"
                        }`}
                      >
                        <p className="font-semibold text-white">Assisted</p>
                        <p className="text-sm text-gray-400 mt-1">
                          AI creates everything but asks for approval before major actions
                        </p>
                      </button>
                      <button
                        onClick={() => setAutomationForm((p) => ({ ...p, approvalMode: "autonomous" }))}
                        className={`p-4 rounded-lg border text-left transition-all ${
                          automationForm.approvalMode === "autonomous"
                            ? "border-[#00D4FF] bg-[#00D4FF]/10"
                            : "border-[#334155] hover:border-gray-500"
                        }`}
                      >
                        <p className="font-semibold text-white">Autonomous</p>
                        <p className="text-sm text-gray-400 mt-1">
                          AI operates within your rules with minimal intervention
                        </p>
                      </button>
                    </div>
                  </div>

                  <div className="p-4 rounded-xl bg-[#0F172A] border border-[#334155] space-y-4">
                    <div className="space-y-2">
                      <Label className="text-gray-300">Maximum Daily Ad Spend (USD)</Label>
                      <Input
                        type="number"
                        value={automationForm.maxDailyAdSpend}
                        onChange={(e) =>
                          setAutomationForm((p) => ({ ...p, maxDailyAdSpend: e.target.value }))
                        }
                        className="bg-[#1E293B] border-[#334155] text-white"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label className="text-gray-300">Tone Strictness</Label>
                      <Select
                        value={automationForm.toneStrictness}
                        onValueChange={(v) =>
                          setAutomationForm((p) => ({ ...p, toneStrictness: v as any }))
                        }
                      >
                        <SelectTrigger className="bg-[#1E293B] border-[#334155] text-white">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-[#1E293B] border-[#334155]">
                          <SelectItem value="low" className="text-white">Low — Allow creative freedom</SelectItem>
                          <SelectItem value="medium" className="text-white">Medium — Balance creativity and brand</SelectItem>
                          <SelectItem value="high" className="text-white">High — Strict brand adherence</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="p-4 rounded-xl bg-[#0F172A] border border-[#334155] space-y-3">
                    <Label className="text-white block mb-2">Approval Requirements</Label>
                    {[
                      {
                        key: "requireApprovalBeforePosting" as const,
                        label: "Require approval before publishing posts",
                      },
                      {
                        key: "requireApprovalBeforeReplying" as const,
                        label: "Require approval before public replies",
                      },
                      {
                        key: "requireApprovalForHighValueLeads" as const,
                        label: "Require approval for high-value lead actions",
                      },
                    ].map((item) => (
                      <label key={item.key} className="flex items-center gap-3 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={automationForm[item.key]}
                          onChange={(e) =>
                            setAutomationForm((p) => ({ ...p, [item.key]: e.target.checked }))
                          }
                          className="w-4 h-4 rounded border-[#334155] bg-[#1E293B] text-[#00D4FF]"
                        />
                        <span className="text-gray-300 text-sm">{item.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {step === 4 && (
              <div className="space-y-6">
                <div className="flex items-center gap-3 mb-6">
                  <Check className="w-6 h-6 text-emerald-400" />
                  <h2 className="text-xl font-semibold text-white">Review & Launch</h2>
                </div>

                <div className="space-y-4">
                  <div className="p-4 rounded-xl bg-[#0F172A] border border-[#334155]">
                    <h3 className="font-semibold text-white mb-3">Business Profile</h3>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <span className="text-gray-500">Name</span>
                      <span className="text-gray-300">{businessForm.name}</span>
                      <span className="text-gray-500">Industry</span>
                      <span className="text-gray-300 capitalize">{businessForm.industry}</span>
                      <span className="text-gray-500">Brand Tone</span>
                      <span className="text-gray-300 capitalize">{businessForm.brandTone || "Professional"}</span>
                      <span className="text-gray-500">Platforms</span>
                      <span className="text-gray-300">
                        {businessForm.preferredPlatforms.join(", ") || "All platforms"}
                      </span>
                    </div>
                  </div>

                  <div className="p-4 rounded-xl bg-[#0F172A] border border-[#334155]">
                    <h3 className="font-semibold text-white mb-3">Strategy</h3>
                    <p className="text-sm text-gray-300">
                      {strategyForm.mode === "generate"
                        ? "AI will generate your marketing strategy automatically."
                        : strategyForm.mode === "paste"
                        ? "Your provided strategy will be used as the foundation."
                        : "Your uploaded strategy document will be analyzed."}
                    </p>
                  </div>

                  <div className="p-4 rounded-xl bg-[#0F172A] border border-[#334155]">
                    <h3 className="font-semibold text-white mb-3">Automation Settings</h3>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <span className="text-gray-500">Mode</span>
                      <span className="text-gray-300 capitalize">{automationForm.approvalMode}</span>
                      <span className="text-gray-500">Max Daily Spend</span>
                      <span className="text-gray-300">${automationForm.maxDailyAdSpend}</span>
                      <span className="text-gray-500">Tone Strictness</span>
                      <span className="text-gray-300 capitalize">{automationForm.toneStrictness}</span>
                    </div>
                  </div>
                </div>

                <div className="p-4 rounded-xl bg-gradient-to-r from-[#00D4FF]/10 to-[#7C3AED]/10 border border-[#00D4FF]/20">
                  <p className="text-sm text-gray-300">
                    By launching, you agree to let NatForge AI agents create and manage your marketing
                    campaign. You will be notified of any actions requiring your approval.
                  </p>
                </div>
              </div>
            )}

            {/* Navigation */}
            <div className="flex justify-between mt-8 pt-6 border-t border-[#334155]">
              <Button
                variant="outline"
                onClick={handleBack}
                disabled={step === 1}
                className="border-[#334155] text-white hover:bg-[#1E293B]"
              >
                <ChevronLeft className="w-4 h-4 mr-1" />
                Back
              </Button>

              {step < 4 ? (
                <Button
                  onClick={handleNext}
                  className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] text-white hover:opacity-90"
                >
                  Next
                  <ChevronRight className="w-4 h-4 ml-1" />
                </Button>
              ) : (
                <Button
                  onClick={handleComplete}
                  disabled={isSubmitting}
                  className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] text-white hover:opacity-90"
                >
                  {isSubmitting ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin mr-2" />
                      Launching...
                    </>
                  ) : (
                    <>
                      <Rocket className="w-4 h-4 mr-2" />
                      Launch Campaign
                    </>
                  )}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
