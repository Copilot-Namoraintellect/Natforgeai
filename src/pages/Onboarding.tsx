import { useState } from "react";
import { useNavigate, Link } from "react-router";
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
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { useUsage } from "@/hooks/useUsage";
import {
  Building2,
  Rocket,
  ChevronRight,
  ChevronLeft,
  Globe,
  MapPin,
  Users,
  Wallet,
  MessageSquare,
  Check,
  AlertTriangle,
  Megaphone,
  Package,
  Palette,
  Plug,
  TrendingUp,
  ExternalLink,
  AlertCircle,
  Sparkles,
  Lock,
  Info,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

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

const campaignGoals = [
  "Increase sales and revenue",
  "Generate more leads",
  "Build brand awareness",
  "Grow social media following",
  "Drive website traffic",
  "Launch a new product",
  "Retain existing customers",
  "Enter a new market",
];

const assetTypes = [
  { key: "logo", label: "Logo / Brand Assets" },
  { key: "product_images", label: "Product Photos" },
  { key: "testimonials", label: "Customer Testimonials" },
  { key: "past_ads", label: "Past Ads / Content" },
  { key: "brand_guide", label: "Brand Guidelines" },
];

const commonCities = [
  "Johannesburg, Gauteng, South Africa",
  "Cape Town, Western Cape, South Africa",
  "Durban, KwaZulu-Natal, South Africa",
  "Pretoria, Gauteng, South Africa",
  "Port Elizabeth, Eastern Cape, South Africa",
  "New York, NY, United States",
  "Los Angeles, CA, United States",
  "Chicago, IL, United States",
  "Houston, TX, United States",
  "San Francisco, CA, United States",
  "London, England, United Kingdom",
  "Manchester, England, United Kingdom",
  "Birmingham, England, United Kingdom",
  "Toronto, Ontario, Canada",
  "Vancouver, British Columbia, Canada",
  "Montreal, Quebec, Canada",
  "Sydney, New South Wales, Australia",
  "Melbourne, Victoria, Australia",
  "Brisbane, Queensland, Australia",
  "Dubai, Dubai, United Arab Emirates",
  "Abu Dhabi, Abu Dhabi, United Arab Emirates",
  "Lagos, Lagos State, Nigeria",
  "Abuja, Federal Capital Territory, Nigeria",
  "Nairobi, Nairobi County, Kenya",
  "Accra, Greater Accra, Ghana",
  "Kampala, Central Region, Uganda",
  "Mumbai, Maharashtra, India",
  "Delhi, Delhi, India",
  "Bangalore, Karnataka, India",
  "Singapore, Singapore",
  "Hong Kong, Hong Kong",
  "Tokyo, Tokyo, Japan",
  "Berlin, Berlin, Germany",
  "Paris, Île-de-France, France",
  "Amsterdam, North Holland, Netherlands",
  "Madrid, Madrid, Spain",
  "Rome, Lazio, Italy",
  "São Paulo, São Paulo, Brazil",
  "Mexico City, Mexico City, Mexico",
  "Buenos Aires, Buenos Aires, Argentina",
];

const countryCodes = [
  { code: "+27", country: "South Africa", flag: "🇿🇦" },
  { code: "+1", country: "United States", flag: "🇺🇸" },
  { code: "+44", country: "United Kingdom", flag: "🇬🇧" },
  { code: "+91", country: "India", flag: "🇮🇳" },
  { code: "+234", country: "Nigeria", flag: "🇳🇬" },
  { code: "+254", country: "Kenya", flag: "🇰🇪" },
  { code: "+233", country: "Ghana", flag: "🇬🇭" },
  { code: "+256", country: "Uganda", flag: "🇺🇬" },
  { code: "+971", country: "UAE", flag: "🇦🇪" },
  { code: "+61", country: "Australia", flag: "🇦🇺" },
  { code: "+1", country: "Canada", flag: "🇨🇦" },
  { code: "+49", country: "Germany", flag: "🇩🇪" },
  { code: "+33", country: "France", flag: "🇫🇷" },
  { code: "+39", country: "Italy", flag: "🇮🇹" },
  { code: "+34", country: "Spain", flag: "🇪🇸" },
  { code: "+55", country: "Brazil", flag: "🇧🇷" },
  { code: "+52", country: "Mexico", flag: "🇲🇽" },
  { code: "+81", country: "Japan", flag: "🇯🇵" },
  { code: "+86", country: "China", flag: "🇨🇳" },
  { code: "+65", country: "Singapore", flag: "🇸🇬" },
];

export default function Onboarding() {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const [step, setStep] = useState(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [limitBlocked, setLimitBlocked] = useState(false);
  const { campaigns: campaignUsage } = useUsage();
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
  const [locationQuery, setLocationQuery] = useState("");
  const [locationSuggestions, setLocationSuggestions] = useState<string[]>([]);
  const [showLocationSuggestions, setShowLocationSuggestions] = useState(false);
  const [countryCode, setCountryCode] = useState("+27");
  const [whatsappLocal, setWhatsappLocal] = useState("");
  const [explainPlatform, setExplainPlatform] = useState<string | null>(null);
  const [aiAnalyzing, setAiAnalyzing] = useState(false);

  const [assetForm, setAssetForm] = useState({
    selectedAssets: [] as string[],
    productDescription: "",
    uniqueSellingPoint: "",
    pricePoint: "",
  });

  const [goalForm, setGoalForm] = useState({
    primaryGoal: "",
    secondaryGoal: "",
    successMetric: "",
    targetRevenue: "",
  });

  const [brandForm, setBrandForm] = useState({
    brandTone: "",
    visualStyle: "" as "modern" | "classic" | "minimal" | "bold" | "luxury" | "playful" | "",
    colorPalette: "",
    brandVoiceNotes: "",
    avoidWords: "",
  });

  const [integrationForm, setIntegrationForm] = useState({
    interestedPlatforms: [] as string[],
  });

  const [strategyForm] = useState({
    mode: "generate" as "upload" | "paste" | "generate",
    strategyText: "",
  });

  const [automationForm] = useState({
    approvalMode: "assisted" as "assisted" | "autonomous",
    maxDailyAdSpend: "50",
    toneStrictness: "medium" as "low" | "medium" | "high",
    requireApprovalBeforePosting: true,
    requireApprovalBeforeReplying: true,
    requireApprovalForHighValueLeads: true,
  });

  const { data: platformConfigStatus } = trpc.integration.getPlatformConfigStatus.useQuery();
  const { data: connectedIntegrations } = trpc.integration.getConnectedPlatforms.useQuery();

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

  const totalSteps = 6;
  const progress = (step / totalSteps) * 100;

  const stepLabels = [
    "Business Profile",
    "Product Assets",
    "Campaign Goal",
    "Brand Style",
    "Integrations",
    "Review/Launch",
  ];

  const stepIcons = [Building2, Package, TrendingUp, Palette, Plug, Check];

  function togglePlatform(platform: string) {
    setBusinessForm((prev) => ({
      ...prev,
      preferredPlatforms: prev.preferredPlatforms.includes(platform)
        ? prev.preferredPlatforms.filter((p) => p !== platform)
        : [...prev.preferredPlatforms, platform],
    }));
  }

  function toggleInterestedPlatform(platform: string) {
    setIntegrationForm((prev) => ({
      ...prev,
      interestedPlatforms: prev.interestedPlatforms.includes(platform)
        ? prev.interestedPlatforms.filter((p) => p !== platform)
        : [...prev.interestedPlatforms, platform],
    }));
  }

  function toggleAsset(assetKey: string) {
    setAssetForm((prev) => ({
      ...prev,
      selectedAssets: prev.selectedAssets.includes(assetKey)
        ? prev.selectedAssets.filter((a) => a !== assetKey)
        : [...prev.selectedAssets, assetKey],
    }));
  }

  function isPlatformConfigured(platform: string) {
    return platformConfigStatus?.find((p) => p.platform === platform)?.configured === true;
  }

  function handleLocationInput(value: string) {
    setLocationQuery(value);
    setBusinessForm((p) => ({ ...p, location: value }));
    if (value.length >= 2) {
      const matches = commonCities.filter((c) => c.toLowerCase().includes(value.toLowerCase())).slice(0, 6);
      setLocationSuggestions(matches);
      setShowLocationSuggestions(matches.length > 0);
    } else {
      setShowLocationSuggestions(false);
    }
  }

  function selectLocation(city: string) {
    setLocationQuery(city);
    setBusinessForm((p) => ({ ...p, location: city }));
    setShowLocationSuggestions(false);
  }

  function handleWhatsappInput(value: string) {
    const digits = value.replace(/\D/g, "");
    setWhatsappLocal(digits);
    const formatted = digits ? `${countryCode} ${digits.replace(/(\d{3})(?=(\d))/g, "$1 ")}` : "";
    setBusinessForm((p) => ({ ...p, whatsappNumber: formatted.trim() }));
  }

  function validateWhatsapp() {
    const full = businessForm.whatsappNumber;
    if (!full) return true;
    return /^\+[1-9]\d{0,3}\s?\d{6,14}$/.test(full.replace(/\s/g, ""));
  }

  function isPlatformConnected(platform: string) {
    return connectedIntegrations?.some(
      (i) => i.platform === platform && i.status === "connected"
    );
  }

  function getStepValidationError() {
    if (step === 1) {
      if (!businessForm.name || !businessForm.industry) {
        return "Please fill in at least business name and industry";
      }
    }
    if (step === 3) {
      if (!goalForm.primaryGoal) {
        return "Please select a primary campaign goal";
      }
    }
    if (step === 4) {
      if (!brandForm.brandTone) {
        return "Please select a brand tone";
      }
    }
    return null;
  }

  const handleNext = () => {
    const error = getStepValidationError();
    if (error) {
      toast.error(error);
      return;
    }
    if (step === 2 && strategyForm.mode === "paste" && !strategyForm.strategyText.trim()) {
      toast.error("Please paste your strategy or choose another option");
      return;
    }
    setStep((s) => Math.min(s + 1, totalSteps));
  };

  const handleBack = () => setStep((s) => Math.max(s - 1, 1));

  const handleComplete = async () => {
    setIsSubmitting(true);
    try {
      const atLimit = campaignUsage.atLimit;

      const businessResult = await createBusiness.mutateAsync({
        name: businessForm.name,
        website: businessForm.website || undefined,
        industry: businessForm.industry || undefined,
        location: businessForm.location || undefined,
        productOrService: businessForm.productOrService || assetForm.productDescription || undefined,
        targetCustomer: businessForm.targetCustomer || undefined,
        monthlyBudget: businessForm.monthlyBudget ? Number(businessForm.monthlyBudget) : undefined,
        brandTone: brandForm.brandTone || businessForm.brandTone || undefined,
        mainGoal: goalForm.primaryGoal || businessForm.mainGoal || undefined,
        whatsappNumber: businessForm.whatsappNumber || undefined,
        preferredPlatforms: businessForm.preferredPlatforms.join(","),
      });

      await updateUser.mutateAsync({ onboardingComplete: true });

      if (atLimit) {
        setLimitBlocked(true);
        toast.info("Your business profile is saved. Campaign launch is blocked because your plan limit has been reached.");
        return;
      }

      const businessId = businessResult.id;

      await startWorkflow.mutateAsync({
        businessId,
        name: `${businessForm.name} Marketing Campaign`,
        goal: goalForm.primaryGoal || businessForm.mainGoal || "Grow brand awareness and drive conversions",
        strategyText: strategyForm.mode === "paste" ? strategyForm.strategyText : undefined,
        approvalMode: automationForm.approvalMode,
        autoPublish: automationForm.approvalMode === "autonomous",
      });

      toast.success("Onboarding complete! Welcome to NatForge AI.");
      navigate("/mission-control");
    } catch (err: any) {
      toast.error(err.message || "Failed to complete onboarding");
    } finally {
      setIsSubmitting(false);
    }
  };

  function renderStepIndicator() {
    return (
      <div className="mb-8">
        <div className="flex justify-between text-xs sm:text-sm text-gray-400 mb-3">
          {stepLabels.map((label, idx) => {
            const s = idx + 1;
            const active = s === step;
            const completed = s < step;
            return (
              <div
                key={label}
                className={`hidden sm:flex flex-col items-center gap-1 min-w-[80px] ${
                  active ? "text-[#00D4FF]" : completed ? "text-emerald-400" : ""
                }`}
              >
                <span className="font-medium">{label}</span>
              </div>
            );
          })}
        </div>
        <div className="relative">
          <Progress value={progress} className="h-2" />
          <div className="absolute top-0 left-0 w-full h-full flex justify-between items-center px-0">
            {stepLabels.map((_, idx) => {
              const s = idx + 1;
              const active = s === step;
              const completed = s < step;
              const Icon = stepIcons[idx];
              return (
                <div
                  key={s}
                  className={`w-6 h-6 sm:w-7 sm:h-7 rounded-full flex items-center justify-center text-[10px] sm:text-xs border-2 -mt-2.5 ${
                    active
                      ? "bg-[#00D4FF] border-[#00D4FF] text-white"
                      : completed
                      ? "bg-emerald-500 border-emerald-500 text-white"
                      : "bg-[#1E293B] border-[#334155] text-gray-500"
                  }`}
                >
                  {completed ? <Check className="w-3.5 h-3.5" /> : <Icon className="w-3 h-3 sm:w-3.5 sm:h-3.5" />}
                </div>
              );
            })}
          </div>
        </div>
        <p className="text-center text-sm text-[#00D4FF] mt-3 font-medium sm:hidden">
          Step {step} of {totalSteps}: {stepLabels[step - 1]}
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#0F172A] via-[#1E293B] to-[#0F172A] flex items-center justify-center p-4">
      <div className="w-full max-w-4xl">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-[#00D4FF] to-[#7C3AED] mb-4">
            <Rocket className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-3xl font-bold text-white mb-2">Welcome to NatForge AI</h1>
          <p className="text-gray-400">Set up your autonomous marketing system in {totalSteps} steps</p>
        </div>

        {renderStepIndicator()}

        {/* Step Content */}
        <Card className="border-[#334155] bg-[#1E293B]/80 backdrop-blur">
          <CardContent className="p-6 sm:p-8">
            {step === 1 && (
              <div className="space-y-6">
                <div className="flex items-center gap-3 mb-2">
                  <Building2 className="w-6 h-6 text-[#00D4FF]" />
                  <h2 className="text-xl font-semibold text-white">Business Profile</h2>
                </div>
                <p className="text-sm text-gray-400 -mt-3">Tell us about your business so AI can market it accurately.</p>

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
                    <div className="relative flex gap-2">
                      <Globe className="absolute left-3 top-2.5 w-4 h-4 text-gray-500 z-10" />
                      <Input
                        placeholder="https://yourbusiness.com"
                        value={businessForm.website}
                        onChange={(e) => setBusinessForm((p) => ({ ...p, website: e.target.value }))}
                        className="bg-[#0F172A] border-[#334155] text-white pl-10 flex-1"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={aiAnalyzing || !businessForm.website}
                        onClick={() => {
                          if (!businessForm.website) {
                            toast.error("Please enter a website URL first");
                            return;
                          }
                          setAiAnalyzing(true);
                          setTimeout(() => {
                            setAiAnalyzing(false);
                            toast.info("Website analysis is not available yet. You can continue manually.");
                          }, 1500);
                        }}
                        className="border-[#334155] text-[#00D4FF] hover:bg-[#00D4FF]/10 h-10"
                      >
                        {aiAnalyzing ? (
                          <Sparkles className="w-4 h-4 mr-1 animate-spin" />
                        ) : (
                          <Sparkles className="w-4 h-4 mr-1" />
                        )}
                        AI Analyse
                      </Button>
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
                  <div className="space-y-2 relative">
                    <Label className="text-gray-300">Location</Label>
                    <div className="relative">
                      <MapPin className="absolute left-3 top-2.5 w-4 h-4 text-gray-500 z-10" />
                      <Input
                        placeholder="Start typing a city..."
                        value={locationQuery}
                        onChange={(e) => handleLocationInput(e.target.value)}
                        onFocus={() => locationQuery.length >= 2 && setShowLocationSuggestions(locationSuggestions.length > 0)}
                        onBlur={() => setTimeout(() => setShowLocationSuggestions(false), 200)}
                        className="bg-[#0F172A] border-[#334155] text-white pl-10"
                      />
                    </div>
                    {showLocationSuggestions && (
                      <div className="absolute z-20 w-full mt-1 bg-[#1E293B] border border-[#334155] rounded-lg shadow-xl max-h-48 overflow-y-auto">
                        {locationSuggestions.map((city) => (
                          <button
                            key={city}
                            type="button"
                            onMouseDown={(e) => { e.preventDefault(); selectLocation(city); }}
                            className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-[#0F172A] hover:text-white transition-colors"
                          >
                            {city}
                          </button>
                        ))}
                      </div>
                    )}
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

                <div className="space-y-2">
                  <Label className="text-gray-300">Estimated Monthly Marketing Spend</Label>
                  <p className="text-xs text-gray-500">
                    This guides the AI strategy for ads and campaign promotion. It is not charged by NatForgeAI.
                  </p>
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
                  <Label className="text-gray-300">WhatsApp Number</Label>
                  <p className="text-xs text-gray-500">
                    Example: +27 82 123 4567 or +1 415 555 0100
                  </p>
                  <div className="flex gap-2">
                    <Select value={countryCode} onValueChange={setCountryCode}>
                      <SelectTrigger className="w-[140px] bg-[#0F172A] border-[#334155] text-white">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="bg-[#1E293B] border-[#334155]">
                        {countryCodes.map((c) => (
                          <SelectItem key={`${c.code}-${c.country}`} value={c.code} className="text-white">
                            {c.flag} {c.code}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="relative flex-1">
                      <MessageSquare className="absolute left-3 top-2.5 w-4 h-4 text-gray-500" />
                      <Input
                        placeholder="82 123 4567"
                        value={whatsappLocal}
                        onChange={(e) => handleWhatsappInput(e.target.value)}
                        className={`bg-[#0F172A] border-[#334155] text-white pl-10 ${businessForm.whatsappNumber && !validateWhatsapp() ? "border-red-500" : ""}`}
                      />
                    </div>
                  </div>
                  {businessForm.whatsappNumber && !validateWhatsapp() && (
                    <p className="text-xs text-red-400">Please enter a valid phone number</p>
                  )}
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-6">
                <div className="flex items-center gap-3 mb-2">
                  <Package className="w-6 h-6 text-[#00D4FF]" />
                  <h2 className="text-xl font-semibold text-white">Product Assets</h2>
                </div>
                <p className="text-sm text-gray-400 -mt-3">
                  Help AI understand what you sell and why customers should buy it.
                </p>

                <div className="space-y-2">
                  <Label className="text-gray-300">Product or Service Description</Label>
                  <Textarea
                    placeholder="Describe your main product or service. What problem does it solve?"
                    value={assetForm.productDescription}
                    onChange={(e) => setAssetForm((p) => ({ ...p, productDescription: e.target.value }))}
                    className="bg-[#0F172A] border-[#334155] text-white min-h-[120px]"
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label className="text-gray-300">Unique Selling Point</Label>
                    <Input
                      placeholder="What makes you different from competitors?"
                      value={assetForm.uniqueSellingPoint}
                      onChange={(e) => setAssetForm((p) => ({ ...p, uniqueSellingPoint: e.target.value }))}
                      className="bg-[#0F172A] border-[#334155] text-white"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-gray-300">Price Point / Offer</Label>
                    <Input
                      placeholder="e.g. $29/month, $199 once-off, 20% launch discount"
                      value={assetForm.pricePoint}
                      onChange={(e) => setAssetForm((p) => ({ ...p, pricePoint: e.target.value }))}
                      className="bg-[#0F172A] border-[#334155] text-white"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label className="text-gray-300">Available Marketing Assets</Label>
                  <p className="text-xs text-gray-500">Select what you have. You can upload these later.</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
                    {assetTypes.map((asset) => (
                      <label
                        key={asset.key}
                        className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                          assetForm.selectedAssets.includes(asset.key)
                            ? "border-[#00D4FF] bg-[#00D4FF]/10"
                            : "border-[#334155] bg-[#0F172A] hover:border-gray-500"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={assetForm.selectedAssets.includes(asset.key)}
                          onChange={() => toggleAsset(asset.key)}
                          className="w-4 h-4 rounded border-[#334155] bg-[#1E293B] text-[#00D4FF]"
                        />
                        <span className="text-gray-300 text-sm">{asset.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {step === 3 && (
              <div className="space-y-6">
                <div className="flex items-center gap-3 mb-2">
                  <TrendingUp className="w-6 h-6 text-[#00D4FF]" />
                  <h2 className="text-xl font-semibold text-white">Campaign Goal</h2>
                </div>
                <p className="text-sm text-gray-400 -mt-3">Define what success looks like for this campaign.</p>

                <div className="space-y-2">
                  <Label className="text-gray-300">Primary Goal *</Label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {campaignGoals.map((goal) => (
                      <button
                        key={goal}
                        onClick={() => setGoalForm((p) => ({ ...p, primaryGoal: goal }))}
                        className={`p-3 rounded-lg border text-left text-sm transition-all ${
                          goalForm.primaryGoal === goal
                            ? "border-[#00D4FF] bg-[#00D4FF]/10 text-white"
                            : "border-[#334155] bg-[#0F172A] text-gray-400 hover:text-white"
                        }`}
                      >
                        {goal}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label className="text-gray-300">Secondary Goal (optional)</Label>
                  <Input
                    placeholder="e.g. Build our email list"
                    value={goalForm.secondaryGoal}
                    onChange={(e) => setGoalForm((p) => ({ ...p, secondaryGoal: e.target.value }))}
                    className="bg-[#0F172A] border-[#334155] text-white"
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label className="text-gray-300">Success Metric</Label>
                    <Select
                      value={goalForm.successMetric}
                      onValueChange={(v) => setGoalForm((p) => ({ ...p, successMetric: v }))}
                    >
                      <SelectTrigger className="bg-[#0F172A] border-[#334155] text-white">
                        <SelectValue placeholder="Select metric" />
                      </SelectTrigger>
                      <SelectContent className="bg-[#1E293B] border-[#334155]">
                        <SelectItem value="conversions" className="text-white">Sales / Conversions</SelectItem>
                        <SelectItem value="leads" className="text-white">Leads Generated</SelectItem>
                        <SelectItem value="traffic" className="text-white">Website Traffic</SelectItem>
                        <SelectItem value="engagement" className="text-white">Engagement Rate</SelectItem>
                        <SelectItem value="reach" className="text-white">Reach / Impressions</SelectItem>
                        <SelectItem value="followers" className="text-white">Follower Growth</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-gray-300">Target Revenue / Value (USD)</Label>
                    <Input
                      type="number"
                      placeholder="10000"
                      value={goalForm.targetRevenue}
                      onChange={(e) => setGoalForm((p) => ({ ...p, targetRevenue: e.target.value }))}
                      className="bg-[#0F172A] border-[#334155] text-white"
                    />
                  </div>
                </div>
              </div>
            )}

            {step === 4 && (
              <div className="space-y-6">
                <div className="flex items-center gap-3 mb-2">
                  <Palette className="w-6 h-6 text-[#00D4FF]" />
                  <h2 className="text-xl font-semibold text-white">Brand Style</h2>
                </div>
                <p className="text-sm text-gray-400 -mt-3">Shape how AI sounds and feels when marketing your brand.</p>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label className="text-gray-300">Brand Tone *</Label>
                    <Select
                      value={brandForm.brandTone}
                      onValueChange={(v) => {
                        setBrandForm((p) => ({ ...p, brandTone: v }));
                        setBusinessForm((p) => ({ ...p, brandTone: v }));
                      }}
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
                  <div className="space-y-2">
                    <Label className="text-gray-300">Visual Style</Label>
                    <Select
                      value={brandForm.visualStyle}
                      onValueChange={(v) => setBrandForm((p) => ({ ...p, visualStyle: v as any }))}
                    >
                      <SelectTrigger className="bg-[#0F172A] border-[#334155] text-white">
                        <SelectValue placeholder="Select style" />
                      </SelectTrigger>
                      <SelectContent className="bg-[#1E293B] border-[#334155]">
                        <SelectItem value="modern" className="text-white">Modern</SelectItem>
                        <SelectItem value="classic" className="text-white">Classic</SelectItem>
                        <SelectItem value="minimal" className="text-white">Minimal</SelectItem>
                        <SelectItem value="bold" className="text-white">Bold & Vibrant</SelectItem>
                        <SelectItem value="luxury" className="text-white">Luxury</SelectItem>
                        <SelectItem value="playful" className="text-white">Playful</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label className="text-gray-300">Color Palette (optional)</Label>
                  <Input
                    placeholder="e.g. Navy blue, gold, white"
                    value={brandForm.colorPalette}
                    onChange={(e) => setBrandForm((p) => ({ ...p, colorPalette: e.target.value }))}
                    className="bg-[#0F172A] border-[#334155] text-white"
                  />
                </div>

                <div className="space-y-2">
                  <Label className="text-gray-300">Brand Voice Notes</Label>
                  <Textarea
                    placeholder="e.g. We use short sentences. We never use slang. We always lead with benefits."
                    value={brandForm.brandVoiceNotes}
                    onChange={(e) => setBrandForm((p) => ({ ...p, brandVoiceNotes: e.target.value }))}
                    className="bg-[#0F172A] border-[#334155] text-white"
                  />
                </div>

                <div className="space-y-2">
                  <Label className="text-gray-300">Words or Phrases to Avoid</Label>
                  <Input
                    placeholder="e.g. cheap, discount, guaranteed"
                    value={brandForm.avoidWords}
                    onChange={(e) => setBrandForm((p) => ({ ...p, avoidWords: e.target.value }))}
                    className="bg-[#0F172A] border-[#334155] text-white"
                  />
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

            {step === 5 && (
              <div className="space-y-6">
                <div className="flex items-center gap-3 mb-2">
                  <Plug className="w-6 h-6 text-[#00D4FF]" />
                  <h2 className="text-xl font-semibold text-white">Publishing Integrations</h2>
                </div>
                <p className="text-sm text-gray-400 -mt-3">
                  Connect platforms to enable automatic publishing. You can skip this and connect later.
                </p>

                <div className="space-y-3">
                  {platforms
                    .filter((p) => ["facebook", "instagram", "linkedin", "tiktok", "twitter", "whatsapp", "email"].includes(p.value))
                    .map((p) => {
                      const configured = p.value === "email" ? true : isPlatformConfigured(p.value);
                      const connected = p.value === "email" ? false : isPlatformConnected(p.value);
                      const interested = integrationForm.interestedPlatforms.includes(p.value);
                      const unavailable = !configured && p.value !== "email";
                      return (
                        <div
                          key={p.value}
                          onClick={() => {
                            if (unavailable) setExplainPlatform(p.value);
                          }}
                          className={`flex items-center justify-between p-4 rounded-xl border transition-colors ${
                            connected
                              ? "border-emerald-500/30 bg-emerald-500/5"
                              : interested
                              ? "border-[#00D4FF]/30 bg-[#00D4FF]/5"
                              : unavailable
                              ? "border-[#334155]/60 bg-[#0F172A]/60 cursor-pointer hover:border-amber-500/30"
                              : "border-[#334155] bg-[#0F172A]"
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            {unavailable ? (
                              <div className="w-4 h-4 flex items-center justify-center">
                                <Lock className="w-3.5 h-3.5 text-gray-500" />
                              </div>
                            ) : (
                              <input
                                type="checkbox"
                                checked={interested}
                                onChange={() => toggleInterestedPlatform(p.value)}
                                className="w-4 h-4 rounded border-[#334155] bg-[#1E293B] text-[#00D4FF]"
                              />
                            )}
                            <div>
                              <p className="font-medium text-white">{p.label}</p>
                              {connected ? (
                                <Badge variant="outline" className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-[10px]">
                                  Connected
                                </Badge>
                              ) : configured ? (
                                <span className="text-xs text-gray-500">Available to connect</span>
                              ) : p.value === "email" ? (
                                <span className="text-xs text-blue-400/80">SMTP setup required</span>
                              ) : (
                                <span className="text-xs text-amber-500/80">Automatic publishing is not available for this platform yet</span>
                              )}
                            </div>
                          </div>
                          {interested && !connected && p.value !== "email" && configured && (
                            <Link to="/integrations">
                              <Button size="sm" variant="outline" className="h-8 text-xs" onClick={(e) => e.stopPropagation()}>
                                <ExternalLink className="w-3 h-3 mr-1" />
                                Connect
                              </Button>
                            </Link>
                          )}
                          {unavailable && p.value === "whatsapp" && (
                            <Badge variant="outline" className="text-[10px] text-gray-500 border-gray-500/20">
                              Not configured
                            </Badge>
                          )}
                        </div>
                      );
                    })}
                </div>

                <Dialog open={!!explainPlatform} onOpenChange={() => setExplainPlatform(null)}>
                  <DialogContent className="bg-[#1E293B] border-[#334155] text-white">
                    <DialogHeader>
                      <DialogTitle className="flex items-center gap-2">
                        <Info className="w-5 h-5 text-[#00D4FF]" />
                        {explainPlatform ? platforms.find((p) => p.value === explainPlatform)?.label : ""}
                      </DialogTitle>
                      <DialogDescription className="text-gray-400">
                        Automatic publishing is not available for this platform yet.
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-3 text-sm text-gray-300">
                      <p>
                        Platform setup is not enabled for this workspace yet. You can still generate content and publish manually.
                      </p>
                      <p className="text-gray-500">
                        Integrations are only required for automatic publishing and inbox management.
                      </p>
                    </div>
                  </DialogContent>
                </Dialog>

                <div className="p-3 rounded-lg bg-[#0F172A] border border-[#334155] text-xs text-gray-400 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-[#00D4FF] shrink-0 mt-0.5" />
                  <p>
                    Integrations are only required for automatic publishing and inbox management.
                    You can still generate content, approve posts, and publish manually without connecting anything.
                    Unavailable platforms are shown with a lock icon and can be connected once workspace setup is complete.
                  </p>
                </div>
              </div>
            )}

            {step === 6 && (
              <div className="space-y-6">
                <div className="flex items-center gap-3 mb-2">
                  <Check className="w-6 h-6 text-emerald-400" />
                  <h2 className="text-xl font-semibold text-white">Review & Launch</h2>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="p-4 rounded-xl bg-[#0F172A] border border-[#334155]">
                    <h3 className="font-semibold text-white mb-3">Business Profile</h3>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <span className="text-gray-500">Name</span>
                      <span className="text-gray-300">{businessForm.name || "—"}</span>
                      <span className="text-gray-500">Industry</span>
                      <span className="text-gray-300 capitalize">{businessForm.industry || "—"}</span>
                      <span className="text-gray-500">Location</span>
                      <span className="text-gray-300">{businessForm.location || "—"}</span>
                    </div>
                  </div>

                  <div className="p-4 rounded-xl bg-[#0F172A] border border-[#334155]">
                    <h3 className="font-semibold text-white mb-3">Product & Goal</h3>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <span className="text-gray-500">Primary Goal</span>
                      <span className="text-gray-300">{goalForm.primaryGoal || "—"}</span>
                      <span className="text-gray-500">Success Metric</span>
                      <span className="text-gray-300">{goalForm.successMetric || "—"}</span>
                      <span className="text-gray-500">USP</span>
                      <span className="text-gray-300 line-clamp-2">{assetForm.uniqueSellingPoint || "—"}</span>
                    </div>
                  </div>

                  <div className="p-4 rounded-xl bg-[#0F172A] border border-[#334155]">
                    <h3 className="font-semibold text-white mb-3">Brand Style</h3>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <span className="text-gray-500">Tone</span>
                      <span className="text-gray-300 capitalize">{brandForm.brandTone || "—"}</span>
                      <span className="text-gray-500">Visual Style</span>
                      <span className="text-gray-300 capitalize">{brandForm.visualStyle || "—"}</span>
                      <span className="text-gray-500">Platforms</span>
                      <span className="text-gray-300">{businessForm.preferredPlatforms.join(", ") || "—"}</span>
                    </div>
                  </div>

                  <div className="p-4 rounded-xl bg-[#0F172A] border border-[#334155]">
                    <h3 className="font-semibold text-white mb-3">Automation</h3>
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

                {limitBlocked && (
                  <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20">
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="w-5 h-5 text-amber-500 mt-0.5 shrink-0" />
                      <div>
                        <p className="text-sm font-medium text-amber-200">
                          Campaign Launch Blocked
                        </p>
                        <p className="text-xs text-amber-200/70 mt-1">
                          You have used the campaign allowance included in your current plan.
                          Upgrade your plan to create additional campaigns.
                        </p>
                        <div className="flex gap-2 mt-3">
                          <Link to="/pricing">
                            <Button size="sm" className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] text-white">
                              View Plans
                            </Button>
                          </Link>
                          <Link to="/campaigns">
                            <Button size="sm" variant="outline" className="border-amber-500/30 text-amber-400 hover:bg-amber-500/10">
                              <Megaphone className="w-3.5 h-3.5 mr-1" />
                              Go to Campaigns
                            </Button>
                          </Link>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Navigation */}
            <div className="flex justify-between mt-8 pt-6 border-t border-[#334155]">
              <Button
                variant="outline"
                onClick={handleBack}
                disabled={step === 1}
                className={`h-10 px-5 rounded-xl transition-all ${
                  step === 1
                    ? "opacity-40 cursor-not-allowed border-[#334155]/40 text-gray-500 bg-transparent"
                    : "border-[#334155] text-white hover:bg-[#1E293B] hover:border-gray-400"
                }`}
              >
                <ChevronLeft className="w-4 h-4 mr-1" />
                Back
              </Button>

              {step < totalSteps ? (
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
