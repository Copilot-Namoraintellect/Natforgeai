import { useState, useEffect, useRef, useMemo } from "react";
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
  MessageSquare,
  Check,
  AlertTriangle,
  Megaphone,
  Package,
  Palette,
  Plug,
  TrendingUp,
  AlertCircle,
  Sparkles,
  Lock,
  Info,
  Wand2,
  Upload,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { shouldScrollToTop, scrollToTop } from "@/lib/onboarding-navigation";
import {
  calculateOnboardingReadiness,
  isLiveOrLaterWorkflowState,
} from "@/lib/onboarding-readiness";

const ENABLE_PREMIUM_VIDEO = import.meta.env.VITE_ENABLE_PREMIUM_VIDEO === "true";
const ENABLE_BASIC_DRAFT_VIDEO = import.meta.env.VITE_ENABLE_BASIC_DRAFT_VIDEO === "true";

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

const tonePresets = [
  { label: "Professional", value: "professional" },
  { label: "Friendly", value: "friendly" },
  { label: "Premium", value: "premium" },
  { label: "Bold", value: "bold" },
  { label: "Playful", value: "playful" },
  { label: "Educational", value: "authoritative" },
];

function looksLikeDomain(value: string): boolean {
  return /\.[a-z]{2,}(\.[a-z]{2})?$/i.test(value.trim()) && value.includes(".");
}

function cleanBusinessNameFromDomain(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\.[a-z]{2,}.*$/i, "")
    .replace(/[-_]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

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
  ...(ENABLE_BASIC_DRAFT_VIDEO ? [{ key: "product_videos", label: "Product Videos" }] : []),
  { key: "testimonials", label: "Customer Testimonials" },
  { key: "past_ads", label: "Past Ads / Content" },
  { key: "brand_guide", label: "Brand Guidelines" },
];

const premiumContentTypes = [
  { key: "social_posts", label: "Social Media Posts" },
  ...(ENABLE_PREMIUM_VIDEO ? [{ key: "product_videos_reels", label: "Product Videos / Reels" }] : []),
  { key: "carousel_ads", label: "Carousel Ads" },
  { key: "whatsapp_promo", label: "WhatsApp Promo Messages" },
  { key: "email_campaigns", label: "Email Campaigns" },
  { key: "lead_gen_ads", label: "Lead Generation Ads" },
  { key: "launch_pack", label: "Launch Campaign Pack" },
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

const visualStyles = [
  { value: "modern", label: "Modern" },
  { value: "classic", label: "Classic" },
  { value: "minimal", label: "Minimal" },
  { value: "bold", label: "Bold & Vibrant" },
  { value: "luxury", label: "Luxury" },
  { value: "playful", label: "Playful" },
];

const successMetrics = [
  { value: "conversions", label: "Sales / Conversions" },
  { value: "leads", label: "Leads Generated" },
  { value: "traffic", label: "Website Traffic" },
  { value: "engagement", label: "Engagement Rate" },
  { value: "reach", label: "Reach / Impressions" },
  { value: "followers", label: "Follower Growth" },
];

function mapAiAssets(aiAssets: string[]): string[] {
  const map: Record<string, string> = {
    logo: "logo",
    "brand assets": "logo",
    "brand guidelines": "brand_guide",
    "product images": "product_images",
    "product photos": "product_images",
    "product images/photos": "product_images",
    testimonials: "testimonials",
    "customer testimonials": "testimonials",
    "past ads": "past_ads",
    "past content": "past_ads",
    "previous ads": "past_ads",
    "previous content": "past_ads",
  };
  const result: string[] = [];
  for (const a of aiAssets) {
    const key = a.toLowerCase().trim();
    if (map[key] && !result.includes(map[key])) result.push(map[key]);
    // Also try partial matches
    for (const [mk, mv] of Object.entries(map)) {
      if (key.includes(mk) && !result.includes(mv)) result.push(mv);
    }
  }
  return result;
}

function mapAiMetric(metric: string): string {
  const m = metric.toLowerCase();
  if (m.includes("sale") || m.includes("conversion") || m.includes("purchase")) return "conversions";
  if (m.includes("lead") || m.includes("enquiry") || m.includes("inquiry")) return "leads";
  if (m.includes("traffic") || m.includes("visit")) return "traffic";
  if (m.includes("engagement") || m.includes("like") || m.includes("comment")) return "engagement";
  if (m.includes("reach") || m.includes("impression") || m.includes("view")) return "reach";
  if (m.includes("follower") || m.includes("subscriber")) return "followers";
  return "leads";
}

function mapAiVisualStyle(style: string): string {
  const s = style.toLowerCase();
  if (s.includes("modern")) return "modern";
  if (s.includes("classic") || s.includes("traditional")) return "classic";
  if (s.includes("minimal") || s.includes("clean")) return "minimal";
  if (s.includes("bold") || s.includes("vibrant")) return "bold";
  if (s.includes("luxury") || s.includes("premium") || s.includes("elegant")) return "luxury";
  if (s.includes("playful") || s.includes("fun")) return "playful";
  return "modern";
}

function mapAiBrandTone(tone: string): string {
  const t = tone.toLowerCase();
  if (t.includes("friendly") || t.includes("warm")) return "friendly";
  if (t.includes("premium") || t.includes("luxury")) return "premium";
  if (t.includes("bold") || t.includes("strong")) return "bold";
  if (t.includes("professional") || t.includes("corporate")) return "professional";
  if (t.includes("casual") || t.includes("relaxed")) return "casual";
  if (t.includes("urgent") || t.includes("direct")) return "urgent";
  if (t.includes("playful") || t.includes("fun")) return "playful";
  if (t.includes("authoritative") || t.includes("educational") || t.includes("expert")) return "authoritative";
  return "professional";
}

function mapAiPlatforms(aiPlatforms: string[]): string[] {
  const result: string[] = [];
  for (const p of aiPlatforms) {
    const lower = p.toLowerCase();
    if (lower.includes("instagram") && !result.includes("instagram")) result.push("instagram");
    if (lower.includes("facebook") && !result.includes("facebook")) result.push("facebook");
    if (lower.includes("linkedin") && !result.includes("linkedin")) result.push("linkedin");
    if (lower.includes("tiktok") && !result.includes("tiktok")) result.push("tiktok");
    if ((lower.includes("twitter") || lower.includes("x/")) && !result.includes("twitter")) result.push("twitter");
    if (lower.includes("whatsapp") && !result.includes("whatsapp")) result.push("whatsapp");
    if (lower.includes("email") && !result.includes("email")) result.push("email");
  }
  return result;
}

interface AiSuggestions {
  shortDescription: string;
  businessDescription: string;
  productOrService: string;
  targetCustomer: string;
  productDescription: string;
  uniqueSellingPoint: string;
  pricePointOffer: string | null;
  primaryGoal: string;
  secondaryGoal: string | null;
  successMetric: string;
  targetRevenue: string | null;
  brandTone: string;
  visualStyle: string;
  colorPalette: string;
  brandVoiceNotes: string;
  wordsToAvoid: string;
  preferredPlatforms: string[];
  recommendedAssetTypes: string[];
  confidence: number;
  assumptions: string[];
}

export default function Onboarding() {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const [step, setStep] = useState(1);
  const previousStepRef = useRef(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [limitBlocked, setLimitBlocked] = useState(false);
  const [duplicateDialog, setDuplicateDialog] = useState<{ open: boolean; existingId: number | null }>({
    open: false,
    existingId: null,
  });
  const { campaigns: campaignUsage } = useUsage();

  const [businessForm, setBusinessForm] = useState({
    name: "",
    website: "",
    email: "",
    industry: "",
    location: "",
    productOrService: "",
    targetCustomer: "",
    targetAudience: "",
    monthlyBudget: "",
    brandTone: "",
    mainGoal: "",
    whatsappNumber: "",
    logo: "",
    description: "",
    shortDescription: "",
    premiumContentPreferences: "",
    preferredPlatforms: [] as string[],
  });

  const [locationQuery, setLocationQuery] = useState("");
  const [locationSuggestions, setLocationSuggestions] = useState<string[]>([]);
  const [showLocationSuggestions, setShowLocationSuggestions] = useState(false);
  const locationRef = useRef<HTMLDivElement>(null);

  const [countryCode, setCountryCode] = useState("+27");
  const [whatsappLocal, setWhatsappLocal] = useState("");
  const [explainPlatform, setExplainPlatform] = useState<string | null>(null);
  const [aiAnalyzing, setAiAnalyzing] = useState(false);

  const [assetForm, setAssetForm] = useState({
    selectedAssets: [] as string[],
    productDescription: "",
    uniqueSellingPoint: "",
    pricePoint: "",
    premiumContentPreferences: [] as string[],
  });

  const [goalForm, setGoalForm] = useState({
    primaryGoal: "",
    secondaryGoal: "",
    successMetric: "",
    targetRevenue: "",
  });

  const [brandForm, setBrandForm] = useState({
    brandTone: "" as string,
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

  const [aiSuggestions, setAiSuggestions] = useState<AiSuggestions | null>(null);
  const [aiSuggestedFields, setAiSuggestedFields] = useState<Record<string, boolean>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const { data: platformConfigStatus } = trpc.integration.getPlatformConfigStatus.useQuery();
  const { data: connectedPlatforms } = trpc.integration.getConnectedPlatforms.useQuery();
  const { data: campaigns } = trpc.campaign.list.useQuery();
  const { data: completedAudienceRuns } = trpc.agent.getAgentRuns.useQuery({
    agentType: "audience",
    status: "completed",
  });

  const connectedIntegrations = useMemo(
    () =>
      connectedPlatforms?.map((i) => ({
        platform: i.provider,
        accountName: i.providerAccountName,
        status: i.status,
      })) ?? [],
    [connectedPlatforms]
  );

  const createBusiness = trpc.business.create.useMutation({
    onSuccess: () => {
      utils.business.list.invalidate();
    },
  });

  const uploadAsset = trpc.business.uploadAsset.useMutation({
    onSuccess: (data) => {
      toast.success("Logo uploaded");
      return data;
    },
    onError: (err) => toast.error(err.message || "Logo upload failed"),
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

  const analyseWebsite = trpc.business.analyseWebsite.useMutation({
    onSuccess: (data) => {
      setAiAnalyzing(false);
      if (!data.success || !data.suggestions) {
        const message =
          data.message ||
          "We could not analyse this website automatically. You can complete your profile manually.";
        toast(message, { icon: "ℹ️" });
        return;
      }
      const sug = data.suggestions as AiSuggestions;
      setAiSuggestions(sug);
      toast.success("Website analysed. Please review the suggested details.");

      // Auto-fill empty fields across all forms
      const newAiSuggested: Record<string, boolean> = {};

      setBusinessForm((prev) => {
        const next = { ...prev };
        if (!next.shortDescription && sug.shortDescription) {
          next.shortDescription = sug.shortDescription;
          newAiSuggested["shortDescription"] = true;
        }
        if (!next.description && sug.businessDescription) {
          next.description = sug.businessDescription;
          newAiSuggested["description"] = true;
        }
        if (!next.productOrService && sug.productOrService) {
          next.productOrService = sug.productOrService;
          newAiSuggested["productOrService"] = true;
        }
        if (!next.targetCustomer && sug.targetCustomer) {
          next.targetCustomer = sug.targetCustomer;
          newAiSuggested["targetCustomer"] = true;
        }
        if (!next.brandTone && sug.brandTone) {
          next.brandTone = mapAiBrandTone(sug.brandTone);
          newAiSuggested["brandTone"] = true;
        }
        if (!next.mainGoal && sug.primaryGoal) {
          next.mainGoal = sug.primaryGoal;
          newAiSuggested["mainGoal"] = true;
        }
        if (next.preferredPlatforms.length === 0 && sug.preferredPlatforms?.length) {
          next.preferredPlatforms = mapAiPlatforms(sug.preferredPlatforms);
          newAiSuggested["preferredPlatforms"] = true;
        }
        return next;
      });

      setAssetForm((prev) => {
        const next = { ...prev };
        if (!next.productDescription && sug.productDescription) {
          next.productDescription = sug.productDescription;
          newAiSuggested["productDescription"] = true;
        }
        if (!next.uniqueSellingPoint && sug.uniqueSellingPoint) {
          next.uniqueSellingPoint = sug.uniqueSellingPoint;
          newAiSuggested["uniqueSellingPoint"] = true;
        }
        if (!next.pricePoint && sug.pricePointOffer) {
          next.pricePoint = sug.pricePointOffer;
          newAiSuggested["pricePoint"] = true;
        }
        if (next.selectedAssets.length === 0 && sug.recommendedAssetTypes?.length) {
          next.selectedAssets = mapAiAssets(sug.recommendedAssetTypes);
          newAiSuggested["selectedAssets"] = true;
        }
        return next;
      });

      setGoalForm((prev) => {
        const next = { ...prev };
        if (!next.primaryGoal && sug.primaryGoal) {
          next.primaryGoal = sug.primaryGoal;
          newAiSuggested["primaryGoal"] = true;
        }
        if (!next.secondaryGoal && sug.secondaryGoal) {
          next.secondaryGoal = sug.secondaryGoal;
          newAiSuggested["secondaryGoal"] = true;
        }
        if (!next.successMetric && sug.successMetric) {
          next.successMetric = mapAiMetric(sug.successMetric);
          newAiSuggested["successMetric"] = true;
        }
        if (!next.targetRevenue && sug.targetRevenue) {
          next.targetRevenue = sug.targetRevenue;
          newAiSuggested["targetRevenue"] = true;
        }
        return next;
      });

      setBrandForm((prev) => {
        const next = { ...prev };
        if (!next.brandTone && sug.brandTone) {
          next.brandTone = mapAiBrandTone(sug.brandTone);
          newAiSuggested["brandTone"] = true;
        }
        if (!next.visualStyle && sug.visualStyle) {
          next.visualStyle = mapAiVisualStyle(sug.visualStyle) as any;
          newAiSuggested["visualStyle"] = true;
        }
        if (!next.colorPalette && sug.colorPalette) {
          next.colorPalette = sug.colorPalette;
          newAiSuggested["colorPalette"] = true;
        }
        if (!next.brandVoiceNotes && sug.brandVoiceNotes) {
          next.brandVoiceNotes = sug.brandVoiceNotes;
          newAiSuggested["brandVoiceNotes"] = true;
        }
        if (!next.avoidWords && sug.wordsToAvoid) {
          next.avoidWords = sug.wordsToAvoid;
          newAiSuggested["avoidWords"] = true;
        }
        return next;
      });

      setIntegrationForm((prev) => {
        const next = { ...prev };
        if (next.interestedPlatforms.length === 0 && sug.preferredPlatforms?.length) {
          next.interestedPlatforms = mapAiPlatforms(sug.preferredPlatforms);
          newAiSuggested["interestedPlatforms"] = true;
        }
        return next;
      });

      setAiSuggestedFields((prev) => ({ ...prev, ...newAiSuggested }));
    },
    onError: (err) => {
      setAiAnalyzing(false);
      toast(err.message || "We could not analyse this website automatically. You can complete your profile manually.", { icon: "ℹ️" });
    },
  });

  const completeProfileWithAi = trpc.business.completeProfileWithAi.useMutation({
    onSuccess: (data) => {
      if (!data.success || !data.suggestions) {
        toast.error(data.message || "Could not complete your business profile with AI.");
        return;
      }
      const s = data.suggestions;
      setBusinessForm((prev) => ({
        ...prev,
        description: s.description ?? prev.description,
        industry: s.industry ?? prev.industry,
        targetAudience: s.targetAudience ?? prev.targetAudience,
        productOrService: s.productOrService ?? prev.productOrService,
        mainGoal: s.mainGoal ?? prev.mainGoal,
        premiumContentPreferences:
          typeof s.premiumContentPreferences === "string"
            ? s.premiumContentPreferences
            : prev.premiumContentPreferences,
      }));
      setBrandForm((prev) => ({
        ...prev,
        brandTone: s.brandTone ?? prev.brandTone,
        colorPalette: Array.isArray(s.brandColors)
          ? s.brandColors.join(", ")
          : prev.colorPalette,
        visualStyle: (s.visualStyle ?? prev.visualStyle) as any,
        brandVoiceNotes: s.brandVoiceNotes ?? prev.brandVoiceNotes,
        avoidWords: s.avoidWords ?? prev.avoidWords,
      }));
      setGoalForm((prev) => ({
        ...prev,
        primaryGoal: s.mainGoal ?? prev.primaryGoal,
      }));
      toast.success("AI completed your business profile. Review and continue.");
    },
    onError: (err) => {
      toast.error(err.message || "Failed to complete business profile with AI.");
    },
  });

  const totalSteps = 6;
  const progress = (step / totalSteps) * 100;

  const aiReadiness = useMemo(() => {
    const hasWebsiteAnalysis = !!aiSuggestions || (businessForm.website.trim().length > 0 && Object.keys(aiSuggestedFields).length > 0);
    const businessProfileBuilt =
      businessForm.name.trim().length > 0 &&
      (businessForm.description.trim().length > 0 || businessForm.shortDescription.trim().length > 0) &&
      businessForm.location.trim().length > 0;
    const brandVoiceDetected =
      brandForm.brandTone.trim().length > 0 ||
      businessForm.brandTone.trim().length > 0 ||
      brandForm.brandVoiceNotes.trim().length > 0;
    const productsServicesUnderstood =
      businessForm.productOrService.trim().length > 0 ||
      assetForm.productDescription.trim().length > 0 ||
      assetForm.uniqueSellingPoint.trim().length > 0;
    const campaignGoalSelected =
      goalForm.primaryGoal.trim().length > 0 || businessForm.mainGoal.trim().length > 0;
    const socialChannelsConnected = connectedIntegrations.some((integration) => integration.status === "connected");
    const audienceIntelligenceActive =
      (completedAudienceRuns?.length || 0) > 0 ||
      (campaigns || []).some((campaign) => ["audience_ready", "schedule_generated", "launch_approval_required"].includes(campaign.workflowState));
    const firstCampaignLaunched = (campaigns || []).some((campaign) => isLiveOrLaterWorkflowState(campaign.workflowState));

    return calculateOnboardingReadiness({
      websiteAnalysed: hasWebsiteAnalysis,
      businessProfileBuilt,
      brandVoiceDetected,
      productsServicesUnderstood,
      campaignGoalSelected,
      socialChannelsConnected,
      audienceIntelligenceActive,
      firstCampaignLaunched,
    });
  }, [
    aiSuggestions,
    aiSuggestedFields,
    businessForm,
    brandForm,
    assetForm,
    goalForm,
    connectedIntegrations,
    completedAudienceRuns,
    campaigns,
  ]);

  const stepLabels = [
    "Business Profile",
    "Product Assets",
    "Campaign Goal",
    "Brand Style",
    "Publishing & Platforms",
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

  function togglePremiumContent(key: string) {
    setAssetForm((prev) => ({
      ...prev,
      premiumContentPreferences: prev.premiumContentPreferences.includes(key)
        ? prev.premiumContentPreferences.filter((k) => k !== key)
        : [...prev.premiumContentPreferences, key],
    }));
  }

  function isPlatformConfigured(platform: string) {
    if (platform === "facebook" || platform === "instagram") {
      return platformConfigStatus?.metaConfigured === true;
    }
    if (platform === "linkedin") {
      return platformConfigStatus?.linkedinConfigured === true;
    }
    return false;
  }

  function isPlatformConnected(platform: string) {
    return connectedIntegrations.some(
      (i) => i.platform === platform && i.status === "connected"
    );
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

  function handleLogoUpload(file: File | null) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Please upload an image file");
      return;
    }
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      const base64 = result.split(",")[1] || "";
      uploadAsset.mutate(
        { base64, fileName: file.name, assetType: "logo" },
        {
          onSuccess: (data) => {
            setBusinessForm((p) => ({ ...p, logo: data.url }));
          },
        }
      );
    };
    reader.readAsDataURL(file);
  }

  function validateWhatsapp() {
    const full = businessForm.whatsappNumber;
    if (!full) return true;
    return /^\+[1-9]\d{0,3}\s?\d{6,14}$/.test(full.replace(/\s/g, ""));
  }

  function getStepValidationError() {
    const errors: Record<string, string> = {};
    if (step === 1) {
      if (!businessForm.name.trim()) errors["name"] = "Business name is required";
    }
    if (step === 3) {
      if (!goalForm.primaryGoal) errors["primaryGoal"] = "Please select a primary campaign goal";
    }
    if (step === 4) {
      if (!brandForm.brandTone) errors["brandTone"] = "Please select a brand tone";
    }
    return errors;
  }

  const handleNext = () => {
    const errors = getStepValidationError();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      const firstError = Object.values(errors)[0];
      toast.error(firstError);
      return;
    }
    if (step === 2 && strategyForm.mode === "paste" && !strategyForm.strategyText.trim()) {
      toast.error("Please paste your strategy or choose another option");
      return;
    }
    setFieldErrors({});
    setStep((s) => Math.min(s + 1, totalSteps));
  };

  const handleBack = () => {
    setFieldErrors({});
    setStep((s) => Math.max(s - 1, 1));
  };

  const buildBusinessPayload = (allowDuplicate = false) => ({
    name: businessForm.name,
    description: businessForm.description || businessForm.shortDescription || undefined,
    website: businessForm.website || undefined,
    email: businessForm.email || undefined,
    industry: businessForm.industry || undefined,
    location: businessForm.location || undefined,
    productOrService: businessForm.productOrService || assetForm.productDescription || undefined,
    targetAudience: businessForm.targetAudience || businessForm.targetCustomer || undefined,
    targetCustomer: businessForm.targetCustomer || undefined,
    monthlyBudget: businessForm.monthlyBudget ? Number(businessForm.monthlyBudget) : undefined,
    brandTone: brandForm.brandTone || businessForm.brandTone || undefined,
    brandColors: brandForm.colorPalette
      ? brandForm.colorPalette.split(",").map((c) => c.trim()).filter(Boolean)
      : undefined,
    visualStyle: brandForm.visualStyle || undefined,
    brandVoiceNotes: brandForm.brandVoiceNotes || undefined,
    avoidWords: brandForm.avoidWords || undefined,
    mainGoal: businessForm.mainGoal || goalForm.primaryGoal || undefined,
    whatsappNumber: businessForm.whatsappNumber || undefined,
    logo: businessForm.logo || undefined,
    preferredPlatforms: businessForm.preferredPlatforms.join(","),
    premiumContentPreferences: businessForm.premiumContentPreferences || assetForm.premiumContentPreferences.join(","),
    hasProductVideos: assetForm.selectedAssets.includes("product_videos"),
    allowDuplicate,
  });

  const finishOnboarding = async (businessId: number, atLimit: boolean) => {
    await updateUser.mutateAsync({ onboardingComplete: true });

    if (atLimit) {
      setLimitBlocked(true);
      toast.info("Your business profile is saved. Campaign launch is blocked because your plan limit has been reached.");
      return;
    }

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
  };

  const handleCreateAnyway = async () => {
    setDuplicateDialog({ open: false, existingId: null });
    setIsSubmitting(true);
    try {
      const atLimit = campaignUsage.atLimit;
      const businessResult = await createBusiness.mutateAsync(buildBusinessPayload(true));
      if (!businessResult.success) {
        toast.error(businessResult.message || "Could not create business profile.");
        return;
      }
      await finishOnboarding(businessResult.id, atLimit);
    } catch (err: any) {
      toast.error(err.message || "Failed to complete onboarding");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleComplete = async () => {
    setIsSubmitting(true);
    try {
      const atLimit = campaignUsage.atLimit;
      const businessResult = await createBusiness.mutateAsync(buildBusinessPayload(false));
      if (!businessResult.success) {
        if (businessResult.code === "DUPLICATE") {
          setDuplicateDialog({ open: true, existingId: businessResult.existingId ?? null });
        } else {
          toast.error(businessResult.message || "Could not create business profile.");
        }
        return;
      }
      await finishOnboarding(businessResult.id, atLimit);
    } catch (err: any) {
      toast.error(err.message || "Failed to complete onboarding");
    } finally {
      setIsSubmitting(false);
    }
  };

  function applyAiSuggestion(field: string, value: any) {
    if (field === "productOrService") {
      setBusinessForm((p) => ({ ...p, productOrService: value }));
    } else if (field === "targetCustomer") {
      setBusinessForm((p) => ({ ...p, targetCustomer: value }));
    } else if (field === "brandTone") {
      const mapped = mapAiBrandTone(value);
      setBusinessForm((p) => ({ ...p, brandTone: mapped }));
      setBrandForm((p) => ({ ...p, brandTone: mapped }));
    } else if (field === "mainGoal") {
      setBusinessForm((p) => ({ ...p, mainGoal: value }));
    } else if (field === "preferredPlatforms") {
      const mapped = mapAiPlatforms(value);
      setBusinessForm((p) => ({
        ...p,
        preferredPlatforms: Array.from(new Set([...p.preferredPlatforms, ...mapped])),
      }));
    } else if (field === "productDescription") {
      setAssetForm((p) => ({ ...p, productDescription: value }));
    } else if (field === "uniqueSellingPoint") {
      setAssetForm((p) => ({ ...p, uniqueSellingPoint: value }));
    } else if (field === "pricePoint") {
      setAssetForm((p) => ({ ...p, pricePoint: value }));
    } else if (field === "selectedAssets") {
      const mapped = mapAiAssets(value);
      setAssetForm((p) => ({ ...p, selectedAssets: mapped }));
    } else if (field === "primaryGoal") {
      setGoalForm((p) => ({ ...p, primaryGoal: value }));
    } else if (field === "secondaryGoal") {
      setGoalForm((p) => ({ ...p, secondaryGoal: value }));
    } else if (field === "successMetric") {
      setGoalForm((p) => ({ ...p, successMetric: mapAiMetric(value) }));
    } else if (field === "targetRevenue") {
      setGoalForm((p) => ({ ...p, targetRevenue: value }));
    } else if (field === "visualStyle") {
      setBrandForm((p) => ({ ...p, visualStyle: mapAiVisualStyle(value) as any }));
    } else if (field === "colorPalette") {
      setBrandForm((p) => ({ ...p, colorPalette: value }));
    } else if (field === "brandVoiceNotes") {
      setBrandForm((p) => ({ ...p, brandVoiceNotes: value }));
    } else if (field === "avoidWords") {
      setBrandForm((p) => ({ ...p, avoidWords: value }));
    } else if (field === "interestedPlatforms") {
      const mapped = mapAiPlatforms(value);
      setIntegrationForm((p) => ({
        ...p,
        interestedPlatforms: Array.from(new Set([...p.interestedPlatforms, ...mapped])),
      }));
    }
    setAiSuggestedFields((prev) => ({ ...prev, [field]: true }));
  }

  function applyAllSuggestions() {
    if (!aiSuggestions) return;
    const sug = aiSuggestions;
    applyAiSuggestion("productOrService", sug.productOrService);
    applyAiSuggestion("targetCustomer", sug.targetCustomer);
    applyAiSuggestion("brandTone", sug.brandTone);
    applyAiSuggestion("mainGoal", sug.primaryGoal);
    applyAiSuggestion("preferredPlatforms", sug.preferredPlatforms);
    applyAiSuggestion("productDescription", sug.productDescription);
    applyAiSuggestion("uniqueSellingPoint", sug.uniqueSellingPoint);
    applyAiSuggestion("pricePoint", sug.pricePointOffer);
    applyAiSuggestion("selectedAssets", sug.recommendedAssetTypes);
    applyAiSuggestion("primaryGoal", sug.primaryGoal);
    applyAiSuggestion("secondaryGoal", sug.secondaryGoal);
    applyAiSuggestion("successMetric", sug.successMetric);
    applyAiSuggestion("targetRevenue", sug.targetRevenue);
    applyAiSuggestion("visualStyle", sug.visualStyle);
    applyAiSuggestion("colorPalette", sug.colorPalette);
    applyAiSuggestion("brandVoiceNotes", sug.brandVoiceNotes);
    applyAiSuggestion("avoidWords", sug.wordsToAvoid);
    applyAiSuggestion("interestedPlatforms", sug.preferredPlatforms);
    toast.success("All AI suggestions applied.");
  }

  function handleAiAnalyse() {
    if (!businessForm.website) {
      toast.error("Please enter a website URL first");
      return;
    }
    let url = businessForm.website.trim();
    if (!/^https?:\/\//i.test(url)) {
      url = "https://" + url;
    }
    try {
      new URL(url);
    } catch {
      toast.error("Please enter a valid website URL");
      return;
    }
    setAiAnalyzing(true);
    analyseWebsite.mutate({
      websiteUrl: url,
      businessName: businessForm.name || undefined,
      industry: businessForm.industry || undefined,
      location: businessForm.location || undefined,
    });
  }

  function handleCompleteProfileWithAi() {
    completeProfileWithAi.mutate({
      name: businessForm.name,
      website: businessForm.website,
      location: businessForm.location,
      description: businessForm.shortDescription,
      logo: businessForm.logo,
    });
  }

  // Close location dropdown on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (locationRef.current && !locationRef.current.contains(e.target as Node)) {
        setShowLocationSuggestions(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    const previous = previousStepRef.current;
    if (shouldScrollToTop(previous, step)) {
      scrollToTop(typeof window !== "undefined" ? window.scrollTo.bind(window) : null);
    }
    previousStepRef.current = step;
  }, [step]);

  function renderAiBadge(field: string) {
    if (!aiSuggestedFields[field]) return null;
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-[#00D4FF] bg-[#00D4FF]/10 border border-[#00D4FF]/20 rounded-full px-2 py-0.5 ml-2">
        <Sparkles className="w-3 h-3" />
        AI suggested
      </span>
    );
  }

  function renderAiSuggestionChip(field: string, displayValue?: string) {
    if (!aiSuggestions) return null;
    const hasUserValue = (() => {
      if (field === "productOrService") return !!businessForm.productOrService;
      if (field === "targetCustomer") return !!businessForm.targetCustomer;
      if (field === "brandTone") return !!businessForm.brandTone;
      if (field === "mainGoal") return !!businessForm.mainGoal;
      if (field === "preferredPlatforms") return businessForm.preferredPlatforms.length > 0;
      if (field === "productDescription") return !!assetForm.productDescription;
      if (field === "uniqueSellingPoint") return !!assetForm.uniqueSellingPoint;
      if (field === "pricePoint") return !!assetForm.pricePoint;
      if (field === "selectedAssets") return assetForm.selectedAssets.length > 0;
      if (field === "primaryGoal") return !!goalForm.primaryGoal;
      if (field === "secondaryGoal") return !!goalForm.secondaryGoal;
      if (field === "successMetric") return !!goalForm.successMetric;
      if (field === "targetRevenue") return !!goalForm.targetRevenue;
      if (field === "visualStyle") return !!brandForm.visualStyle;
      if (field === "colorPalette") return !!brandForm.colorPalette;
      if (field === "brandVoiceNotes") return !!brandForm.brandVoiceNotes;
      if (field === "avoidWords") return !!brandForm.avoidWords;
      if (field === "interestedPlatforms") return integrationForm.interestedPlatforms.length > 0;
      return false;
    })();

    if (!hasUserValue || aiSuggestedFields[field]) return null;

    let suggestionValue: any;
    if (field === "productOrService") suggestionValue = aiSuggestions.productOrService;
    else if (field === "targetCustomer") suggestionValue = aiSuggestions.targetCustomer;
    else if (field === "brandTone") suggestionValue = aiSuggestions.brandTone;
    else if (field === "mainGoal") suggestionValue = aiSuggestions.primaryGoal;
    else if (field === "preferredPlatforms") suggestionValue = aiSuggestions.preferredPlatforms;
    else if (field === "productDescription") suggestionValue = aiSuggestions.productDescription;
    else if (field === "uniqueSellingPoint") suggestionValue = aiSuggestions.uniqueSellingPoint;
    else if (field === "pricePoint") suggestionValue = aiSuggestions.pricePointOffer;
    else if (field === "selectedAssets") suggestionValue = aiSuggestions.recommendedAssetTypes;
    else if (field === "primaryGoal") suggestionValue = aiSuggestions.primaryGoal;
    else if (field === "secondaryGoal") suggestionValue = aiSuggestions.secondaryGoal;
    else if (field === "successMetric") suggestionValue = aiSuggestions.successMetric;
    else if (field === "targetRevenue") suggestionValue = aiSuggestions.targetRevenue;
    else if (field === "visualStyle") suggestionValue = aiSuggestions.visualStyle;
    else if (field === "colorPalette") suggestionValue = aiSuggestions.colorPalette;
    else if (field === "brandVoiceNotes") suggestionValue = aiSuggestions.brandVoiceNotes;
    else if (field === "avoidWords") suggestionValue = aiSuggestions.wordsToAvoid;
    else if (field === "interestedPlatforms") suggestionValue = aiSuggestions.preferredPlatforms;

    if (!suggestionValue || (Array.isArray(suggestionValue) && suggestionValue.length === 0)) return null;

    return (
      <button
        type="button"
        onClick={() => applyAiSuggestion(field, suggestionValue)}
        className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-full px-2.5 py-0.5 mt-1 hover:bg-amber-500/20 transition-colors"
      >
        <Wand2 className="w-3 h-3" />
        AI suggestion: {displayValue || (Array.isArray(suggestionValue) ? suggestionValue.join(", ") : String(suggestionValue).slice(0, 40))}
      </button>
    );
  }

  function renderStepIndicator() {
    const checkpointIconMap: Record<string, any> = {
      website_analysed: Globe,
      business_profile_built: Building2,
      brand_voice_detected: MessageSquare,
      products_services_understood: Package,
      campaign_goal_selected: TrendingUp,
      social_channels_connected: Plug,
      audience_intelligence_active: Sparkles,
      first_campaign_launched: Rocket,
    };

    return (
      <div className="mb-8">
        <div className="mb-5 rounded-xl border border-[#334155] bg-[#0F172A]/80 p-4">
          <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2 mb-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-[#00D4FF] font-semibold">AI Readiness</p>
              <p className="text-sm text-gray-300">NatForgeAI business intelligence profile progress</p>
            </div>
            <p className="text-lg font-semibold text-white">{aiReadiness.percentage}% ready</p>
          </div>
          <Progress value={aiReadiness.percentage} className="h-2" />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 mt-3">
            {aiReadiness.checkpoints.map((checkpoint) => {
              const Icon = checkpointIconMap[checkpoint.key] || Info;
              return (
                <div
                  key={checkpoint.key}
                  className={`rounded-lg border p-2.5 flex items-center gap-2 ${
                    checkpoint.completed
                      ? "border-emerald-500/30 bg-emerald-500/10"
                      : "border-[#334155] bg-[#1E293B]/50"
                  }`}
                >
                  <div
                    className={`w-6 h-6 rounded-full flex items-center justify-center ${
                      checkpoint.completed ? "bg-emerald-500 text-white" : "bg-[#1E293B] text-gray-400"
                    }`}
                  >
                    {checkpoint.completed ? <Check className="w-3.5 h-3.5" /> : <Icon className="w-3.5 h-3.5" />}
                  </div>
                  <p className={`text-xs ${checkpoint.completed ? "text-emerald-100" : "text-gray-300"}`}>
                    {checkpoint.label}
                  </p>
                </div>
              );
            })}
          </div>
        </div>

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

  function renderStep1() {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <Building2 className="w-6 h-6 text-[#00D4FF]" />
          <h2 className="text-xl font-semibold text-white">Business Profile</h2>
        </div>
        <p className="text-sm text-gray-400 -mt-3">
          Add your logo and contact details. NatForgeAI can complete the rest of your business profile with AI.
        </p>

        {aiSuggestions && (
          <div className="flex items-center justify-between p-3 rounded-lg bg-[#00D4FF]/5 border border-[#00D4FF]/20">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-[#00D4FF]" />
              <span className="text-sm text-[#00D4FF]">AI analysis complete</span>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={applyAllSuggestions}
              className="h-8 text-xs border-[#00D4FF]/30 text-[#00D4FF] hover:bg-[#00D4FF]/10"
            >
              <Wand2 className="w-3 h-3 mr-1" />
              Apply all suggestions
            </Button>
          </div>
        )}

        {/* Section A: User-provided essentials */}
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-white">A. Your essentials</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-gray-300">Business Name *</Label>
              <Input
                placeholder="Your business name"
                value={businessForm.name}
                onChange={(e) => {
                  setBusinessForm((p) => ({ ...p, name: e.target.value }));
                  if (fieldErrors.name && e.target.value.trim()) setFieldErrors((prev) => { const n = { ...prev }; delete n.name; return n; });
                }}
                className={`bg-[#0F172A] border-[#334155] text-white ${fieldErrors.name ? "border-red-500" : ""}`}
              />
              {fieldErrors.name && <p className="text-xs text-red-400">{fieldErrors.name}</p>}
              {looksLikeDomain(businessForm.name) && (
                <p className="text-xs text-amber-300">
                  That looks like a website address. Did you mean{" "}
                  <strong>"{cleanBusinessNameFromDomain(businessForm.name)}"</strong>? Update the field above if so.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label className="text-gray-300">Logo</Label>
              <Input
                type="file"
                accept="image/*"
                disabled={uploadAsset.isPending}
                onChange={(e) => handleLogoUpload(e.target.files?.[0] ?? null)}
                className="bg-[#0F172A] border-[#334155] text-white file:text-white"
              />
              {uploadAsset.isPending && <p className="text-xs text-gray-500">Uploading logo…</p>}
              {businessForm.logo && (
                <div className="flex items-center gap-3 mt-2">
                  <img
                    src={businessForm.logo}
                    alt="Logo preview"
                    className="w-12 h-12 object-contain rounded border border-[#334155]"
                  />
                  <span className="text-xs text-gray-400">Logo uploaded</span>
                </div>
              )}
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
                  onClick={handleAiAnalyse}
                  className="border-[#334155] text-[#00D4FF] hover:bg-[#00D4FF]/10 h-10 whitespace-nowrap"
                >
                  {aiAnalyzing ? (
                    <>
                      <Sparkles className="w-4 h-4 mr-1 animate-spin" />
                      Analysing…
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4 mr-1" />
                      AI Analyse
                    </>
                  )}
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-gray-300">Email</Label>
              <Input
                type="email"
                placeholder="hello@yourbusiness.com"
                value={businessForm.email}
                onChange={(e) => setBusinessForm((p) => ({ ...p, email: e.target.value }))}
                className="bg-[#0F172A] border-[#334155] text-white"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-gray-300">WhatsApp Number</Label>
              <p className="text-xs text-gray-500">Example: +27 82 123 4567 or +1 415 555 0100</p>
              <div className="flex gap-2">
                <Select value={countryCode} onValueChange={setCountryCode}>
                  <SelectTrigger className="w-[150px] bg-[#0F172A] border-[#334155] text-white">
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
                    placeholder={countryCode === "+27" ? "82 123 4567" : "Phone number"}
                    value={whatsappLocal}
                    onChange={(e) => handleWhatsappInput(e.target.value)}
                    className={`bg-[#0F172A] border-[#334155] text-white pl-10 ${businessForm.whatsappNumber && !validateWhatsapp() ? "border-red-500" : ""}`}
                  />
                </div>
              </div>
              {businessForm.whatsappNumber && !validateWhatsapp() && (
                <p className="text-xs text-red-400">Enter a valid WhatsApp number including country code.</p>
              )}
            </div>

            <div className="space-y-2 relative" ref={locationRef}>
              <Label className="text-gray-300">Location</Label>
              <div className="relative">
                <MapPin className="absolute left-3 top-2.5 w-4 h-4 text-gray-500 z-10" />
                <Input
                  placeholder="Start typing a city…"
                  value={locationQuery}
                  onChange={(e) => handleLocationInput(e.target.value)}
                  onFocus={() => locationQuery.length >= 2 && setShowLocationSuggestions(locationSuggestions.length > 0)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setShowLocationSuggestions(false);
                  }}
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
            <Label className="text-gray-300">Short description (optional)</Label>
            <Textarea
              placeholder="1-2 lines for compact cards and quick previews"
              value={businessForm.shortDescription}
              onChange={(e) => setBusinessForm((p) => ({ ...p, shortDescription: e.target.value }))}
              className="bg-[#0F172A] border-[#334155] text-white"
            />
            <p className="text-xs text-gray-500">
              This appears in compact UI cards. Use the full profile below for campaign grounding.
            </p>
          </div>
        </div>

        {/* Section B: AI-completed business profile */}
        <div className="space-y-4 pt-6 border-t border-[#334155]">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <h3 className="text-sm font-semibold text-white">B. AI-completed business profile</h3>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={completeProfileWithAi.isPending}
              onClick={handleCompleteProfileWithAi}
              className="border-[#00D4FF]/30 text-[#00D4FF] hover:bg-[#00D4FF]/10 h-10"
            >
              {completeProfileWithAi.isPending ? (
                <>
                  <Sparkles className="w-4 h-4 mr-1 animate-spin" />
                  Completing…
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4 mr-1" />
                  Complete Business Profile with AI
                </>
              )}
            </Button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2 md:col-span-2">
              <Label className="text-gray-300">Full business profile</Label>
              <Textarea
                placeholder="AI will generate an 80-150 word profile grounded in your website evidence"
                value={businessForm.description}
                onChange={(e) => setBusinessForm((p) => ({ ...p, description: e.target.value }))}
                className="bg-[#0F172A] border-[#334155] text-white min-h-[100px]"
              />
              <p className="text-xs text-gray-500">
                Include what you do, who you serve, your key products/services, value proposition, service area, and tone.
              </p>
            </div>

            <div className="space-y-2">
              <Label className="text-gray-300">Industry</Label>
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
              <Label className="text-gray-300">Target Audience</Label>
              <Input
                placeholder="e.g. Young professionals aged 25-45"
                value={businessForm.targetAudience}
                onChange={(e) => setBusinessForm((p) => ({ ...p, targetAudience: e.target.value }))}
                className="bg-[#0F172A] border-[#334155] text-white"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-gray-300">Brand Tone</Label>
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
              <Label className="text-gray-300">Product or Service</Label>
              <Textarea
                placeholder="What do you sell or offer?"
                value={businessForm.productOrService}
                onChange={(e) => setBusinessForm((p) => ({ ...p, productOrService: e.target.value }))}
                className="bg-[#0F172A] border-[#334155] text-white"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-gray-300">Brand Colors</Label>
              <Input
                placeholder="e.g. Navy blue, gold, white"
                value={brandForm.colorPalette}
                onChange={(e) => setBrandForm((p) => ({ ...p, colorPalette: e.target.value }))}
                className="bg-[#0F172A] border-[#334155] text-white"
              />
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
                  {visualStyles.map((s) => (
                    <SelectItem key={s.value} value={s.value} className="text-white">
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label className="text-gray-300">Main Goal</Label>
              <Input
                placeholder="e.g. Increase sales and revenue"
                value={businessForm.mainGoal}
                onChange={(e) => {
                  setBusinessForm((p) => ({ ...p, mainGoal: e.target.value }));
                  setGoalForm((p) => ({ ...p, primaryGoal: e.target.value }));
                }}
                className="bg-[#0F172A] border-[#334155] text-white"
              />
            </div>

            <div className="space-y-2 md:col-span-2">
              <Label className="text-gray-300">Brand Voice Notes</Label>
              <Textarea
                placeholder="Notes on how the brand should sound"
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
              <Label className="text-gray-300">Premium Content Preferences</Label>
              <Input
                placeholder="e.g. Social posts, email campaigns"
                value={businessForm.premiumContentPreferences}
                onChange={(e) => setBusinessForm((p) => ({ ...p, premiumContentPreferences: e.target.value }))}
                className="bg-[#0F172A] border-[#334155] text-white"
              />
            </div>
          </div>
        </div>
      </div>
    );
  }

  function renderStep2() {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <Package className="w-6 h-6 text-[#00D4FF]" />
          <h2 className="text-xl font-semibold text-white">Product Assets</h2>
        </div>
        <p className="text-sm text-gray-400 -mt-3">
          Help AI understand what you sell and why customers should buy it.
        </p>

        <div className="space-y-2">
          <Label className="text-gray-300">
            Product or Service Description
            {renderAiBadge("productDescription")}
          </Label>
          <Textarea
            placeholder="Describe your main product or service. What problem does it solve?"
            value={assetForm.productDescription}
            onChange={(e) => setAssetForm((p) => ({ ...p, productDescription: e.target.value }))}
            className="bg-[#0F172A] border-[#334155] text-white min-h-[120px]"
          />
          {renderAiSuggestionChip("productDescription")}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label className="text-gray-300">
              Unique Selling Point
              {renderAiBadge("uniqueSellingPoint")}
            </Label>
            <Input
              placeholder="What makes you different from competitors?"
              value={assetForm.uniqueSellingPoint}
              onChange={(e) => setAssetForm((p) => ({ ...p, uniqueSellingPoint: e.target.value }))}
              className="bg-[#0F172A] border-[#334155] text-white"
            />
            {renderAiSuggestionChip("uniqueSellingPoint")}
          </div>
          <div className="space-y-2">
            <Label className="text-gray-300">
              Price Point / Offer
              {renderAiBadge("pricePoint")}
            </Label>
            <Input
              placeholder="e.g. $29/month, $199 once-off, 20% launch discount"
              value={assetForm.pricePoint}
              onChange={(e) => setAssetForm((p) => ({ ...p, pricePoint: e.target.value }))}
              className="bg-[#0F172A] border-[#334155] text-white"
            />
            {renderAiSuggestionChip("pricePoint")}
          </div>
        </div>

        <div className="space-y-2">
          <Label className="text-gray-300">Available Marketing Assets</Label>
          <p className="text-xs text-gray-500">
            These help NatForgeAI create richer visuals. You can upload them later.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
            {assetTypes.map((asset) => {
              const isSelected = assetForm.selectedAssets.includes(asset.key);
              const aiRecommended = aiSuggestedFields["selectedAssets"] && isSelected;
              return (
                <label
                  key={asset.key}
                  className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                    isSelected
                      ? "border-[#00D4FF] bg-[#00D4FF]/10"
                      : "border-[#334155] bg-[#0F172A] hover:border-gray-500"
                  } ${aiRecommended ? "ring-1 ring-[#00D4FF]/30" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleAsset(asset.key)}
                    className="w-4 h-4 rounded border-[#334155] bg-[#1E293B] text-[#00D4FF]"
                  />
                  <span className="text-gray-300 text-sm">{asset.label}</span>
                  {aiRecommended && (
                    <span className="ml-auto text-[10px] text-[#00D4FF] bg-[#00D4FF]/10 border border-[#00D4FF]/20 rounded-full px-1.5 py-0.5">
                      AI suggested
                    </span>
                  )}
                </label>
              );
            })}
          </div>
          {renderAiSuggestionChip("selectedAssets", aiSuggestions?.recommendedAssetTypes?.map((a) => a.charAt(0).toUpperCase() + a.slice(1)).join(", "))}
        </div>

        <div className="p-3 rounded-lg bg-[#0F172A]/60 border border-dashed border-[#334155] text-xs text-gray-500 flex items-start gap-2">
          <Upload className="w-4 h-4 text-gray-500 shrink-0 mt-0.5" />
          <p>Asset upload coming soon. You can continue and add assets later.</p>
        </div>

        <div className="space-y-2">
          <Label className="text-gray-300">Premium Content Preferences</Label>
          <p className="text-xs text-gray-500">
            Choose the types of premium campaign assets NatForgeAI should create for you.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
            {premiumContentTypes.map((type) => (
              <label
                key={type.key}
                className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                  assetForm.premiumContentPreferences.includes(type.key)
                    ? "border-[#00D4FF] bg-[#00D4FF]/10"
                    : "border-[#334155] bg-[#0F172A] hover:border-gray-500"
                }`}
              >
                <input
                  type="checkbox"
                  checked={assetForm.premiumContentPreferences.includes(type.key)}
                  onChange={() => togglePremiumContent(type.key)}
                  className="w-4 h-4 rounded border-[#334155] bg-[#1E293B] text-[#00D4FF]"
                />
                <span className="text-gray-300 text-sm">{type.label}</span>
              </label>
            ))}
          </div>
        </div>
      </div>
    );
  }

  function renderStep3() {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <TrendingUp className="w-6 h-6 text-[#00D4FF]" />
          <h2 className="text-xl font-semibold text-white">Campaign Goal</h2>
        </div>
        <p className="text-sm text-gray-400 -mt-3">Define what success looks like for this campaign.</p>

        <div className="space-y-2">
          <Label className="text-gray-300">
            Primary Goal *
            {renderAiBadge("primaryGoal")}
          </Label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {campaignGoals.map((goal) => (
              <button
                key={goal}
                onClick={() => {
                  setGoalForm((p) => ({ ...p, primaryGoal: goal }));
                  if (fieldErrors.primaryGoal) setFieldErrors((prev) => { const n = { ...prev }; delete n.primaryGoal; return n; });
                }}
                className={`p-3 rounded-lg border text-left text-sm transition-all ${
                  goalForm.primaryGoal === goal
                    ? "border-[#00D4FF] bg-[#00D4FF]/10 text-white"
                    : "border-[#334155] bg-[#0F172A] text-gray-400 hover:text-white"
                } ${fieldErrors.primaryGoal && !goalForm.primaryGoal ? "border-red-500/50" : ""}`}
              >
                {goal}
              </button>
            ))}
          </div>
          {fieldErrors.primaryGoal && <p className="text-xs text-red-400">{fieldErrors.primaryGoal}</p>}
          {renderAiSuggestionChip("primaryGoal")}
        </div>

        <div className="space-y-2">
          <Label className="text-gray-300">
            Secondary Goal (optional)
            {renderAiBadge("secondaryGoal")}
          </Label>
          <Input
            placeholder="e.g. Build our email list"
            value={goalForm.secondaryGoal}
            onChange={(e) => setGoalForm((p) => ({ ...p, secondaryGoal: e.target.value }))}
            className="bg-[#0F172A] border-[#334155] text-white"
          />
          {renderAiSuggestionChip("secondaryGoal")}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label className="text-gray-300">
              Success Metric
              {renderAiBadge("successMetric")}
            </Label>
            <Select
              value={goalForm.successMetric}
              onValueChange={(v) => setGoalForm((p) => ({ ...p, successMetric: v }))}
            >
              <SelectTrigger className="bg-[#0F172A] border-[#334155] text-white">
                <SelectValue placeholder="Select metric" />
              </SelectTrigger>
              <SelectContent className="bg-[#1E293B] border-[#334155]">
                {successMetrics.map((m) => (
                  <SelectItem key={m.value} value={m.value} className="text-white">
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {renderAiSuggestionChip("successMetric", successMetrics.find(m => m.value === mapAiMetric(aiSuggestions?.successMetric || ""))?.label)}
          </div>
          <div className="space-y-2">
            <Label className="text-gray-300">
              Target Revenue / Value (USD)
              {renderAiBadge("targetRevenue")}
            </Label>
            <Input
              type="number"
              placeholder="10000"
              value={goalForm.targetRevenue}
              onChange={(e) => setGoalForm((p) => ({ ...p, targetRevenue: e.target.value }))}
              className="bg-[#0F172A] border-[#334155] text-white"
            />
            {renderAiSuggestionChip("targetRevenue")}
          </div>
        </div>
      </div>
    );
  }

  function renderStep4() {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <Palette className="w-6 h-6 text-[#00D4FF]" />
          <h2 className="text-xl font-semibold text-white">Brand Style</h2>
        </div>
        <p className="text-sm text-gray-400 -mt-3">Shape how AI sounds and feels when marketing your brand.</p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label className="text-gray-300">
              Brand Tone *
              {renderAiBadge("brandTone")}
            </Label>
            <Select
              value={brandForm.brandTone}
              onValueChange={(v) => {
                setBrandForm((p) => ({ ...p, brandTone: v }));
                setBusinessForm((p) => ({ ...p, brandTone: v }));
                if (fieldErrors.brandTone) setFieldErrors((prev) => { const n = { ...prev }; delete n.brandTone; return n; });
              }}
            >
              <SelectTrigger className={`bg-[#0F172A] border-[#334155] text-white ${fieldErrors.brandTone ? "border-red-500" : ""}`}>
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
            {fieldErrors.brandTone && <p className="text-xs text-red-400">{fieldErrors.brandTone}</p>}
            {renderAiSuggestionChip("brandTone")}

            {!aiSuggestions && !brandForm.brandTone && (
              <div className="flex flex-wrap gap-2 mt-2">
                {tonePresets.map((preset) => (
                  <button
                    key={preset.value}
                    type="button"
                    onClick={() => {
                      setBrandForm((p) => ({ ...p, brandTone: preset.value }));
                      setBusinessForm((p) => ({ ...p, brandTone: preset.value }));
                    }}
                    className="px-3 py-1 rounded-full text-xs font-medium border border-[#334155] text-gray-300 hover:border-[#00D4FF]/50 hover:text-[#00D4FF] transition-colors"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-2">
            <Label className="text-gray-300">
              Visual Style
              {renderAiBadge("visualStyle")}
            </Label>
            <Select
              value={brandForm.visualStyle}
              onValueChange={(v) => setBrandForm((p) => ({ ...p, visualStyle: v as any }))}
            >
              <SelectTrigger className="bg-[#0F172A] border-[#334155] text-white">
                <SelectValue placeholder="Select style" />
              </SelectTrigger>
              <SelectContent className="bg-[#1E293B] border-[#334155]">
                {visualStyles.map((s) => (
                  <SelectItem key={s.value} value={s.value} className="text-white">
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {renderAiSuggestionChip("visualStyle", visualStyles.find(s => s.value === mapAiVisualStyle(aiSuggestions?.visualStyle || ""))?.label)}
          </div>
        </div>

        <div className="space-y-2">
          <Label className="text-gray-300">
            Color Palette (optional)
            {renderAiBadge("colorPalette")}
          </Label>
          <Input
            placeholder="e.g. Navy blue, gold, white"
            value={brandForm.colorPalette}
            onChange={(e) => setBrandForm((p) => ({ ...p, colorPalette: e.target.value }))}
            className="bg-[#0F172A] border-[#334155] text-white"
          />
          {renderAiSuggestionChip("colorPalette")}
        </div>

        <div className="space-y-2">
          <Label className="text-gray-300">
            Brand Voice Notes
            {renderAiBadge("brandVoiceNotes")}
          </Label>
          <Textarea
            placeholder="e.g. We use short sentences. We never use slang. We always lead with benefits."
            value={brandForm.brandVoiceNotes}
            onChange={(e) => setBrandForm((p) => ({ ...p, brandVoiceNotes: e.target.value }))}
            className="bg-[#0F172A] border-[#334155] text-white"
          />
          {renderAiSuggestionChip("brandVoiceNotes")}
        </div>

        <div className="space-y-2">
          <Label className="text-gray-300">
            Words or Phrases to Avoid
            {renderAiBadge("avoidWords")}
          </Label>
          <Input
            placeholder="e.g. cheap, discount, guaranteed"
            value={brandForm.avoidWords}
            onChange={(e) => setBrandForm((p) => ({ ...p, avoidWords: e.target.value }))}
            className="bg-[#0F172A] border-[#334155] text-white"
          />
          {renderAiSuggestionChip("avoidWords")}
        </div>

        <div className="space-y-2">
          <Label className="text-gray-300">
            Preferred Platforms
            {renderAiBadge("preferredPlatforms")}
          </Label>
          <p className="text-xs text-gray-500">
            Selecting platforms guides content creation. It does not enable automatic posting.
          </p>
          <div className="flex flex-wrap gap-2 mt-2">
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
          {renderAiSuggestionChip("preferredPlatforms", mapAiPlatforms(aiSuggestions?.preferredPlatforms || []).map(v => platforms.find(p => p.value === v)?.label).filter(Boolean).join(", "))}
        </div>
      </div>
    );
  }

  function renderStep5() {
    const contentPlatforms = platforms.filter((p) =>
      ["facebook", "instagram", "linkedin", "tiktok", "twitter", "whatsapp", "email"].includes(p.value)
    );

    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <Plug className="w-6 h-6 text-[#00D4FF]" />
          <h2 className="text-xl font-semibold text-white">Publishing & Platform Preferences</h2>
        </div>
        <p className="text-sm text-gray-400 -mt-3">
          Choose the platforms you want NatForgeAI to create content for. Automatic publishing can be connected later where supported.
        </p>

        {/* Content Platforms */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-white">Content Platforms</h3>
          <p className="text-xs text-gray-500 -mt-2">
            Select all platforms you want content generated for. These selections guide AI content creation.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {contentPlatforms.map((p) => {
              const interested = integrationForm.interestedPlatforms.includes(p.value);
              return (
                <button
                  key={p.value}
                  onClick={() => toggleInterestedPlatform(p.value)}
                  className={`flex items-center gap-3 p-3 rounded-lg border text-left transition-colors ${
                    interested
                      ? "border-[#00D4FF]/30 bg-[#00D4FF]/5"
                      : "border-[#334155] bg-[#0F172A] hover:border-gray-500"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={interested}
                    onChange={() => toggleInterestedPlatform(p.value)}
                    className="w-4 h-4 rounded border-[#334155] bg-[#1E293B] text-[#00D4FF] shrink-0"
                  />
                  <div>
                    <p className="font-medium text-white text-sm">{p.label}</p>
                    <p className="text-[11px] text-gray-500">Content will be generated for this platform</p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Automatic Publishing */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-white">Automatic Publishing Connection</h3>
          <p className="text-xs text-gray-500 -mt-2">
            These show which platforms can publish automatically. You can still generate content for all platforms above.
          </p>
          <div className="space-y-2">
            {contentPlatforms.map((p) => {
              const configured = p.value === "email" ? true : isPlatformConfigured(p.value);
              const connected = p.value === "email" ? false : isPlatformConnected(p.value);
              const unavailable = !configured && p.value !== "email";

              return (
                <div
                  key={`pub-${p.value}`}
                  className={`flex items-center justify-between p-3 rounded-lg border transition-colors ${
                    connected
                      ? "border-emerald-500/30 bg-emerald-500/5"
                      : unavailable
                      ? "border-[#334155]/60 bg-[#0F172A]/60"
                      : "border-[#334155] bg-[#0F172A]"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    {unavailable ? (
                      <Lock className="w-4 h-4 text-gray-500 shrink-0" />
                    ) : connected ? (
                      <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                    ) : (
                      <div className="w-4 h-4 rounded-full border border-[#334155] bg-[#1E293B] shrink-0" />
                    )}
                    <div>
                      <p className="font-medium text-white text-sm">{p.label}</p>
                      {connected ? (
                        <Badge variant="outline" className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-[10px]">
                          Connected
                        </Badge>
                      ) : configured ? (
                        <span className="text-[11px] text-gray-500">Available to connect in Settings → Integrations</span>
                      ) : p.value === "email" ? (
                        <span className="text-[11px] text-blue-400/80">Email can be connected using SMTP settings</span>
                      ) : (
                        <span className="text-[11px] text-amber-500/80">Automatic publishing not available yet</span>
                      )}
                    </div>
                  </div>
                  {unavailable && (
                    <button
                      type="button"
                      onClick={() => setExplainPlatform(p.value)}
                      className="text-[11px] text-gray-400 hover:text-white underline"
                    >
                      Learn more
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <Dialog open={!!explainPlatform} onOpenChange={() => setExplainPlatform(null)}>
          <DialogContent className="bg-[#1E293B] border-[#334155] text-white max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Info className="w-5 h-5 text-[#00D4FF]" />
                {explainPlatform ? platforms.find((p) => p.value === explainPlatform)?.label : ""}
              </DialogTitle>
              <DialogDescription className="text-gray-400">
                This platform is not yet configured for automatic publishing.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 text-sm text-gray-300">
              <p>
                You can still generate content for this platform and publish manually. NatForgeAI will create ready-to-post drafts optimised for {explainPlatform ? platforms.find((p) => p.value === explainPlatform)?.label : "this platform"}.
              </p>
              <p className="text-gray-500">
                Automatic publishing connections can be set up later from Settings → Integrations once the platform is configured for this workspace.
              </p>
            </div>
          </DialogContent>
        </Dialog>

        <div className="p-3 rounded-lg bg-[#0F172A] border border-[#334155] text-xs text-gray-400 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-[#00D4FF] shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p>
              <strong className="text-gray-300">Content vs Publishing:</strong> Selecting a platform above tells NatForgeAI to create content for it. Automatic publishing is a separate connection that lets NatForgeAI post directly on your behalf.
            </p>
            <p>
              You can always generate content now and connect automatic publishing later.
            </p>
          </div>
        </div>
      </div>
    );
  }

  function renderStep6() {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <Check className="w-6 h-6 text-emerald-400" />
          <h2 className="text-xl font-semibold text-white">Review & Launch</h2>
        </div>

        <div className="p-4 rounded-xl bg-gradient-to-r from-[#00D4FF]/10 to-[#7C3AED]/10 border border-[#00D4FF]/20">
          <p className="text-sm text-gray-300">
            NatForgeAI will generate strategy and content using these details. You will be asked to approve key outputs before publishing.
          </p>
          {!connectedIntegrations?.some((i) => i.status === "connected") && (
            <p className="text-sm text-gray-400 mt-2">
              Your content will be generated as ready-to-post drafts. You can connect publishing later.
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Business Details */}
          <div className="p-4 rounded-xl bg-[#0F172A] border border-[#334155]">
            <h3 className="font-semibold text-white mb-3 flex items-center gap-2">
              <Building2 className="w-4 h-4 text-[#00D4FF]" />
              Business Details
            </h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">Name</span>
                <span className="text-gray-300">{businessForm.name || "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Industry</span>
                <span className="text-gray-300 capitalize">{businessForm.industry || "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Location</span>
                <span className="text-gray-300">{businessForm.location || "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Website</span>
                <span className="text-gray-300 truncate max-w-[150px]">{businessForm.website || "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">WhatsApp</span>
                <span className="text-gray-300">{businessForm.whatsappNumber || "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Monthly Budget</span>
                <span className="text-gray-300">{businessForm.monthlyBudget ? `$${businessForm.monthlyBudget}` : "—"}</span>
              </div>
            </div>
          </div>

          {/* Product & Offer */}
          <div className="p-4 rounded-xl bg-[#0F172A] border border-[#334155]">
            <h3 className="font-semibold text-white mb-3 flex items-center gap-2">
              <Package className="w-4 h-4 text-[#00D4FF]" />
              Product & Offer
            </h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">Description</span>
                <span className="text-gray-300 text-right max-w-[200px] line-clamp-2">{assetForm.productDescription || "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">USP</span>
                <span className="text-gray-300 text-right max-w-[200px] line-clamp-2">{assetForm.uniqueSellingPoint || "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Price / Offer</span>
                <span className="text-gray-300">{assetForm.pricePoint || "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Assets</span>
                <span className="text-gray-300 text-right">
                  {assetForm.selectedAssets.length > 0
                    ? assetForm.selectedAssets.map((k) => assetTypes.find((a) => a.key === k)?.label).join(", ")
                    : "—"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Premium Content</span>
                <span className="text-gray-300 text-right">
                  {assetForm.premiumContentPreferences.length > 0
                    ? assetForm.premiumContentPreferences.map((k) => premiumContentTypes.find((t) => t.key === k)?.label).join(", ")
                    : "—"}
                </span>
              </div>
            </div>
          </div>

          {/* Campaign Goals -->
          <div className="p-4 rounded-xl bg-[#0F172A] border border-[#334155]">
            <h3 className="font-semibold text-white mb-3 flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-[#00D4FF]" />
              Campaign Goals
            </h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">Primary Goal</span>
                <span className="text-gray-300 text-right max-w-[200px]">{goalForm.primaryGoal || "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Secondary Goal</span>
                <span className="text-gray-300 text-right max-w-[200px]">{goalForm.secondaryGoal || "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Success Metric</span>
                <span className="text-gray-300">
                  {successMetrics.find((m) => m.value === goalForm.successMetric)?.label || goalForm.successMetric || "—"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Target Revenue</span>
                <span className="text-gray-300">{goalForm.targetRevenue ? `$${goalForm.targetRevenue}` : "—"}</span>
              </div>
            </div>
          </div>

          {/* Brand Style */}
          <div className="p-4 rounded-xl bg-[#0F172A] border border-[#334155]">
            <h3 className="font-semibold text-white mb-3 flex items-center gap-2">
              <Palette className="w-4 h-4 text-[#00D4FF]" />
              Brand Style
            </h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">Tone</span>
                <span className="text-gray-300 capitalize">{brandForm.brandTone || "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Visual Style</span>
                <span className="text-gray-300 capitalize">{brandForm.visualStyle || "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Color Palette</span>
                <span className="text-gray-300">{brandForm.colorPalette || "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Words to Avoid</span>
                <span className="text-gray-300 text-right max-w-[150px] line-clamp-1">{brandForm.avoidWords || "—"}</span>
              </div>
            </div>
          </div>

          {/* Content Platforms */}
          <div className="p-4 rounded-xl bg-[#0F172A] border border-[#334155]">
            <h3 className="font-semibold text-white mb-3 flex items-center gap-2">
              <Megaphone className="w-4 h-4 text-[#00D4FF]" />
              Content Platforms
            </h3>
            <div className="flex flex-wrap gap-2">
              {integrationForm.interestedPlatforms.length > 0 ? (
                integrationForm.interestedPlatforms.map((p) => (
                  <Badge key={p} variant="outline" className="bg-[#00D4FF]/10 text-[#00D4FF] border-[#00D4FF]/20">
                    {platforms.find((pl) => pl.value === p)?.label || p}
                  </Badge>
                ))
              ) : businessForm.preferredPlatforms.length > 0 ? (
                businessForm.preferredPlatforms.map((p) => (
                  <Badge key={p} variant="outline" className="bg-[#00D4FF]/10 text-[#00D4FF] border-[#00D4FF]/20">
                    {platforms.find((pl) => pl.value === p)?.label || p}
                  </Badge>
                ))
              ) : (
                <span className="text-gray-500 text-sm">—</span>
              )}
            </div>
          </div>

          {/* Publishing Status */}
          <div className="p-4 rounded-xl bg-[#0F172A] border border-[#334155]">
            <h3 className="font-semibold text-white mb-3 flex items-center gap-2">
              <Plug className="w-4 h-4 text-[#00D4FF]" />
              Publishing Status
            </h3>
            <div className="space-y-2 text-sm">
              {platforms
                .filter((p) => ["facebook", "instagram", "linkedin", "tiktok", "twitter", "whatsapp", "email"].includes(p.value))
                .map((p) => {
                  const connected = isPlatformConnected(p.value);
                  const configured = p.value === "email" ? true : isPlatformConfigured(p.value);
                  return (
                    <div key={p.value} className="flex justify-between items-center">
                      <span className="text-gray-500">{p.label}</span>
                      {connected ? (
                        <Badge variant="outline" className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-[10px]">
                          Connected
                        </Badge>
                      ) : configured ? (
                        <span className="text-[11px] text-gray-500">Available</span>
                      ) : (
                        <span className="text-[11px] text-amber-500/80">Content only</span>
                      )}
                    </div>
                  );
                })}
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

        <div className="mb-4 rounded-xl border border-[#334155] bg-[#0F172A]/70 p-4">
          <p className="text-xs uppercase tracking-wide text-[#00D4FF] font-semibold">Workflow Guidance</p>
          <p className="text-sm text-gray-200 mt-2">What is happening now: You are setting up the business and campaign context NatForge AI needs.</p>
          <p className="text-sm text-gray-300 mt-1">What has been completed: All previous onboarding steps are saved as you progress.</p>
          <p className="text-sm text-gray-300 mt-1">What you need to do next: Complete the current step, then click Next.</p>
          <p className="text-sm text-gray-300 mt-1">What happens after next action: NatForge AI moves to the next step and uses your inputs to generate strategy and creatives.</p>
        </div>

        {/* Step Content */}
        <Card className="border-[#334155] bg-[#1E293B]/80 backdrop-blur">
          <CardContent className="p-6 sm:p-8">
            {step === 1 && renderStep1()}
            {step === 2 && renderStep2()}
            {step === 3 && renderStep3()}
            {step === 4 && renderStep4()}
            {step === 5 && renderStep5()}
            {step === 6 && renderStep6()}

            {/* Navigation */}
            <div className="flex justify-between mt-8 pt-6 border-t border-[#334155]">
              <Button
                variant="outline"
                onClick={handleBack}
                className={`h-11 px-6 rounded-xl border-[#334155] text-white bg-[#1E293B]/50 hover:bg-[#1E293B] hover:border-gray-300 hover:text-white transition-all shadow-sm hover:shadow-md active:scale-[0.98] ${
                  step === 1 ? "invisible" : ""
                }`}
              >
                <ChevronLeft className="w-4 h-4 mr-1" />
                Back
              </Button>

              {step < totalSteps ? (
                <Button
                  onClick={handleNext}
                  className="h-11 px-6 rounded-xl bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] text-white hover:opacity-90 transition-all shadow-sm hover:shadow-md active:scale-[0.98]"
                >
                  Next
                  <ChevronRight className="w-4 h-4 ml-1" />
                </Button>
              ) : (
                <Button
                  onClick={handleComplete}
                  disabled={isSubmitting}
                  className="h-11 px-6 rounded-xl bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] text-white hover:opacity-90 transition-all shadow-sm hover:shadow-md active:scale-[0.98]"
                >
                  {isSubmitting ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin mr-2" />
                      Launching…
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

        <Dialog open={duplicateDialog.open} onOpenChange={(open) => { if (!open) setDuplicateDialog({ open: false, existingId: null }); }}>
          <DialogContent className="border-[#334155] bg-[#1E293B] text-white">
            <DialogHeader>
              <DialogTitle className="text-white">Business already exists</DialogTitle>
              <DialogDescription className="text-gray-300">
                A business with this name already exists. Do you want to edit the existing business instead?
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 mt-4">
              <Button
                variant="outline"
                onClick={() => setDuplicateDialog({ open: false, existingId: null })}
                className="border-[#334155] text-white hover:bg-[#334155]"
              >
                Cancel
              </Button>
              <Button
                variant="outline"
                onClick={() => navigate("/settings?tab=businesses")}
                className="border-[#334155] text-white hover:bg-[#334155]"
              >
                Edit existing
              </Button>
              <Button
                onClick={handleCreateAnyway}
                disabled={isSubmitting}
                className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] text-white hover:opacity-90"
              >
                {isSubmitting ? "Creating…" : "Create anyway"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
