import { useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { trpc } from "@/providers/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  User,
  Building2,
  Plus,
  Pencil,
  Trash2,
  Sparkles,
  Bell,
  Globe,
  Shield,
  CheckCircle2,
  AlertTriangle,
  Mail,
  Loader2,
  MapPin,
  Phone,
  ExternalLink,
  Facebook,
  Instagram,
  Linkedin,
  Unlink,
} from "lucide-react";
import { toast } from "sonner";

type BusinessFormData = {
  id?: number;
  name: string;
  logo: string;
  website: string;
  email: string;
  whatsappNumber: string;
  location: string;
  description: string;
  industry: string;
  targetAudience: string;
  brandTone: string;
  productOrService: string;
  brandColors: string;
  visualStyle: string;
  brandVoiceNotes: string;
  avoidWords: string;
  mainGoal: string;
  premiumContentPreferences: string;
};

function emptyForm(): BusinessFormData {
  return {
    name: "",
    logo: "",
    website: "",
    email: "",
    whatsappNumber: "",
    location: "",
    description: "",
    industry: "",
    targetAudience: "",
    brandTone: "",
    productOrService: "",
    brandColors: "",
    visualStyle: "",
    brandVoiceNotes: "",
    avoidWords: "",
    mainGoal: "",
    premiumContentPreferences: "",
  };
}

function businessToForm(biz: any): BusinessFormData {
  return {
    id: biz.id,
    name: biz.name || "",
    logo: biz.logo || "",
    website: biz.website || "",
    email: biz.email || "",
    whatsappNumber: biz.whatsappNumber || "",
    location: biz.location || "",
    description: biz.description || "",
    industry: biz.industry || "",
    targetAudience: biz.targetAudience || "",
    brandTone: biz.brandTone || biz.tone || "",
    productOrService: biz.productOrService || "",
    brandColors: Array.isArray(biz.brandColors) ? biz.brandColors.join(", ") : "",
    visualStyle: biz.visualStyle || "",
    brandVoiceNotes: biz.brandVoiceNotes || "",
    avoidWords: biz.avoidWords || "",
    mainGoal: biz.mainGoal || "",
    premiumContentPreferences: biz.premiumContentPreferences || "",
  };
}

type IntegrationRow = {
  id: number;
  providerAccountName: string | null;
  status: string;
  createdAt: Date | string;
};

function PlatformIntegrationRow({
  name,
  description,
  icon: Icon,
  iconClass,
  configured,
  integration,
  onConnect,
  onDisconnect,
  isConnecting,
  isDisconnecting,
  isAdmin,
}: {
  name: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  iconClass: string;
  configured: boolean;
  integration?: IntegrationRow;
  onConnect: () => void;
  onDisconnect: (id: number) => void;
  isConnecting: boolean;
  isDisconnecting: boolean;
  isAdmin: boolean;
}) {
  const isConnected = integration?.status === "connected";

  return (
    <div className="flex items-center justify-between py-2 gap-4">
      <div className="flex items-center gap-3 min-w-0">
        <div className={`p-2 rounded-lg bg-gradient-to-br ${iconClass} shrink-0`}>
          <Icon className="w-4 h-4 text-white" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium">{name}</p>
          <p className="text-xs text-muted-foreground truncate">{description}</p>
          {isConnected && integration?.providerAccountName && (
            <p className="text-xs text-emerald-600 truncate">
              {integration.providerAccountName}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {!configured ? (
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <span className="text-xs text-muted-foreground">
              This connection is not configured yet.
            </span>
            {isAdmin && (
              <Badge variant="outline" className="text-amber-600 border-amber-200 bg-amber-50">
                Configure provider
              </Badge>
            )}
          </div>
        ) : isConnected ? (
          <>
            <Badge className="bg-emerald-500/10 text-emerald-600 border-emerald-200">
              <CheckCircle2 className="w-3 h-3 mr-1" />
              Connected
            </Badge>
            <Button
              variant="outline"
              size="sm"
              className="border-red-200 text-red-600 hover:bg-red-50"
              onClick={() => onDisconnect(integration.id)}
              disabled={isDisconnecting}
            >
              {isDisconnecting ? (
                <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
              ) : (
                <Unlink className="w-3.5 h-3.5 mr-1" />
              )}
              Disconnect
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] text-white"
            onClick={onConnect}
            disabled={isConnecting}
          >
            {isConnecting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
            Connect
          </Button>
        )}
      </div>
    </div>
  );
}

function SecuritySettings() {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const enable2FA = trpc.auth.enableTwoFactor.useMutation({
    onSuccess: () => {
      utils.auth.me.invalidate();
      toast.success("Two-factor authentication enabled");
      setConfirmOpen(false);
    },
    onError: (err) => toast.error(err.message || "Failed to enable 2FA"),
  });

  const disable2FA = trpc.auth.disableTwoFactor.useMutation({
    onSuccess: () => {
      utils.auth.me.invalidate();
      toast.success("Two-factor authentication disabled");
    },
    onError: (err) => toast.error(err.message || "Failed to disable 2FA"),
  });

  const isEnabled = user?.twoFactorEnabled;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Shield className="w-4 h-4 text-[#00D4FF]" />
          Two-Factor Authentication
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between py-2">
          <div>
            <p className="text-sm font-medium">Status</p>
            <p className="text-xs text-muted-foreground">
              Add an extra layer of security to your account
            </p>
          </div>
          {isEnabled ? (
            <Badge className="bg-emerald-500/10 text-emerald-600 border-emerald-200">
              <CheckCircle2 className="w-3 h-3 mr-1" />
              Enabled
            </Badge>
          ) : (
            <Badge variant="outline" className="text-amber-600 border-amber-200 bg-amber-50">
              <AlertTriangle className="w-3 h-3 mr-1" />
              Disabled
            </Badge>
          )}
        </div>

        {isEnabled ? (
          <div className="space-y-3">
            <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">Two-factor authentication is active</p>
                <p className="text-emerald-700/80 mt-0.5">
                  You will receive a 6-digit verification code via email every time you sign in with your password.
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              className="border-red-200 text-red-600 hover:bg-red-50"
              onClick={() => disable2FA.mutate()}
              disabled={disable2FA.isPending}
            >
              {disable2FA.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Disable 2FA
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="p-3 rounded-lg bg-muted/50 border border-border text-xs text-muted-foreground">
              <p className="font-medium text-foreground mb-1">How it works</p>
              <ul className="space-y-1 list-disc list-inside">
                <li>Every login attempt sends a one-time code to your email</li>
                <li>Codes expire after 10 minutes</li>
                <li>Only 5 attempts allowed per code</li>
              </ul>
            </div>
            <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
              <DialogTrigger asChild>
                <Button className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] text-white">
                  <Mail className="w-4 h-4 mr-2" />
                  Enable Email 2FA
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-sm">
                <DialogHeader>
                  <DialogTitle>Enable Two-Factor Authentication?</DialogTitle>
                  <DialogDescription>
                    Once enabled, you will need to enter a verification code sent to your email every time you log in.
                  </DialogDescription>
                </DialogHeader>
                <div className="flex gap-2 pt-2">
                  <Button variant="outline" className="flex-1" onClick={() => setConfirmOpen(false)}>
                    Cancel
                  </Button>
                  <Button
                    className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white"
                    onClick={() => enable2FA.mutate({ method: "email" })}
                    disabled={enable2FA.isPending}
                  >
                    {enable2FA.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                    Confirm Enable
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        )}
      </CardContent>
    </Card>
  );
}


export default function Settings() {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const isAdmin = user?.role === "admin";

  const { data: platformConfigStatus } = trpc.integration.getPlatformConfigStatus.useQuery();
  const { data: connectedPlatforms } = trpc.integration.getConnectedPlatforms.useQuery();

  const initiateConnection = trpc.integration.initiateConnection.useMutation({
    onSuccess: (result) => {
      if (!result.success) {
        toast.error(result.message || "Connection not available.");
        return;
      }
      window.open(result.authUrl, "_blank", "noopener,noreferrer");
    },
    onError: (err) => toast.error(err.message || "Failed to start connection."),
  });

  const disconnectPlatform = trpc.integration.disconnectPlatform.useMutation({
    onSuccess: () => {
      utils.integration.getConnectedPlatforms.invalidate();
      toast.success("Platform disconnected.");
    },
    onError: (err) => toast.error(err.message || "Failed to disconnect platform."),
  });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<"create" | "edit">("create");
  const [formData, setFormData] = useState<BusinessFormData>(emptyForm());

  const [duplicateDialog, setDuplicateDialog] = useState<{
    open: boolean;
    existingId?: number;
    message?: string;
  }>({ open: false });

  const [deleteDialog, setDeleteDialog] = useState<{
    open: boolean;
    biz?: any;
  }>({ open: false });

  const { data: businesses } = trpc.business.list.useQuery();

  const createBiz = trpc.business.create.useMutation({
    onSuccess: (data) => {
      utils.business.list.invalidate();
      if (data.success === false) {
        if (data.code === "DUPLICATE") {
          setDialogOpen(false);
          setDuplicateDialog({
            open: true,
            existingId: data.existingId,
            message: data.message,
          });
        } else {
          toast.error(data.message || "Could not add business.");
        }
        return;
      }
      setDialogOpen(false);
      setFormData(emptyForm());
      toast.success("Business added!");
    },
    onError: (err) => toast.error(err.message || "Failed to add business"),
  });

  const updateBiz = trpc.business.update.useMutation({
    onSuccess: () => {
      utils.business.list.invalidate();
      setDialogOpen(false);
      setFormData(emptyForm());
      toast.success("Business updated!");
    },
    onError: (err) => toast.error(err.message || "Failed to update business"),
  });

  const deleteBiz = trpc.business.delete.useMutation({
    onSuccess: () => {
      utils.business.list.invalidate();
      setDeleteDialog({ open: false });
      toast.success("Business removed!");
    },
    onError: (err) => toast.error(err.message || "Failed to delete business"),
  });

  const uploadAsset = trpc.business.uploadAsset.useMutation({
    onSuccess: () => toast.success("Logo uploaded"),
    onError: (err) => toast.error(err.message || "Logo upload failed"),
  });

  const completeProfileWithAi = trpc.business.completeProfileWithAi.useMutation({
    onSuccess: (data) => {
      if (!data.success || !data.suggestions) {
        toast.error(data.message || "Could not complete profile with AI.");
        return;
      }
      setFormData((prev) => ({
        ...prev,
        description: data.suggestions.description ?? prev.description,
        industry: data.suggestions.industry ?? prev.industry,
        targetAudience: data.suggestions.targetAudience ?? prev.targetAudience,
        brandTone: data.suggestions.brandTone ?? prev.brandTone,
        productOrService: data.suggestions.productOrService ?? prev.productOrService,
        brandColors: Array.isArray(data.suggestions.brandColors)
          ? data.suggestions.brandColors.join(", ")
          : prev.brandColors,
        visualStyle: data.suggestions.visualStyle ?? prev.visualStyle,
        brandVoiceNotes: data.suggestions.brandVoiceNotes ?? prev.brandVoiceNotes,
        avoidWords: data.suggestions.avoidWords ?? prev.avoidWords,
        mainGoal: data.suggestions.mainGoal ?? prev.mainGoal,
        premiumContentPreferences:
          data.suggestions.premiumContentPreferences ?? prev.premiumContentPreferences,
      }));
      toast.success("AI profile suggestions applied. Review and save.");
    },
    onError: (err) => toast.error(err.message || "AI completion failed"),
  });

  function openCreateDialog() {
    setDialogMode("create");
    setFormData(emptyForm());
    setDialogOpen(true);
  }

  function openEditDialog(biz: any) {
    setDialogMode("edit");
    setFormData(businessToForm(biz));
    setDialogOpen(true);
  }

  function buildPayload(allowDuplicate?: boolean) {
    const payload = {
      name: formData.name,
      description: formData.description || undefined,
      industry: formData.industry || undefined,
      location: formData.location || undefined,
      targetAudience: formData.targetAudience || undefined,
      brandTone: formData.brandTone || undefined,
      website: formData.website || undefined,
      logo: formData.logo || undefined,
      email: formData.email || undefined,
      whatsappNumber: formData.whatsappNumber || undefined,
      productOrService: formData.productOrService || undefined,
      brandColors: formData.brandColors
        ? formData.brandColors.split(",").map((c) => c.trim()).filter(Boolean)
        : undefined,
      visualStyle: formData.visualStyle || undefined,
      brandVoiceNotes: formData.brandVoiceNotes || undefined,
      avoidWords: formData.avoidWords || undefined,
      mainGoal: formData.mainGoal || undefined,
      premiumContentPreferences: formData.premiumContentPreferences || undefined,
    };
    return allowDuplicate ? { ...payload, allowDuplicate: true as const } : payload;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (dialogMode === "create") {
      createBiz.mutate(buildPayload());
    } else {
      updateBiz.mutate({ id: formData.id!, ...buildPayload() });
    }
  }

  async function handleLogoFileChange(file: File | null) {
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
            setFormData((prev) => ({ ...prev, logo: data.url }));
          },
        }
      );
    };
    reader.readAsDataURL(file);
  }

  function handleAiComplete() {
    if (!formData.name.trim()) {
      toast.error("Please enter a business name first.");
      return;
    }
    completeProfileWithAi.mutate({
      id: dialogMode === "edit" ? formData.id : undefined,
      name: formData.name,
      website: formData.website,
      location: formData.location,
      description: formData.description,
      logo: formData.logo,
    });
  }

  function handleEditExisting() {
    const existing = businesses?.find((b) => b.id === duplicateDialog.existingId);
    if (existing) {
      setDuplicateDialog({ open: false });
      openEditDialog(existing);
    } else {
      toast.error("Could not find existing business.");
    }
  }

  function handleCreateAnyway() {
    setDuplicateDialog({ open: false });
    setDialogOpen(true);
    createBiz.mutate(buildPayload(true));
  }

  const updateField = (field: keyof BusinessFormData, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const submitPending = createBiz.isPending || updateBiz.isPending;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground mt-1">
          Manage your account, businesses, and preferences.
        </p>
      </div>

      <Tabs defaultValue="profile" className="space-y-6">
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="businesses">Businesses</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
          <TabsTrigger value="preferences">Preferences</TabsTrigger>
        </TabsList>

        {/* Profile Tab */}
        <TabsContent value="profile" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <User className="w-4 h-4 text-[#00D4FF]" />
                Profile Information
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 rounded-full bg-gradient-to-br from-[#00D4FF] to-[#7C3AED] flex items-center justify-center text-white text-xl font-bold">
                  {user?.name?.charAt(0)?.toUpperCase() || "U"}
                </div>
                <div>
                  <p className="font-semibold">{user?.name || "User"}</p>
                  <p className="text-sm text-muted-foreground">{user?.email}</p>
                  <Badge variant="secondary" className="mt-1 capitalize">
                    {user?.role || "user"}
                  </Badge>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-4 border-t">
                <div>
                  <Label className="text-muted-foreground">Name</Label>
                  <p className="text-sm font-medium">{user?.name || "Not set"}</p>
                </div>
                <div>
                  <Label className="text-muted-foreground">Email</Label>
                  <p className="text-sm font-medium">{user?.email || "Not set"}</p>
                </div>
                <div>
                  <Label className="text-muted-foreground">Role</Label>
                  <p className="text-sm font-medium capitalize">{user?.role || "user"}</p>
                </div>
                <div>
                  <Label className="text-muted-foreground">Member Since</Label>
                  <p className="text-sm font-medium">
                    {user?.createdAt
                      ? new Date(user.createdAt).toLocaleDateString()
                      : "N/A"}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Businesses Tab */}
        <TabsContent value="businesses" className="space-y-6">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold">Your Businesses</h3>
            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
              <DialogTrigger asChild>
                <Button size="sm" onClick={openCreateDialog}>
                  <Plus className="w-4 h-4 mr-2" />
                  Add Business
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>
                    {dialogMode === "create" ? "Add Business" : "Edit Business"}
                  </DialogTitle>
                  <DialogDescription>
                    Add your logo and contact details. NatForgeAI can complete the rest of your
                    business profile with AI.
                  </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="space-y-6 mt-4">
                  {/* Section A: Essentials */}
                  <div className="space-y-4">
                    <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                      Essentials
                    </h4>
                    <div>
                      <Label>Business Name *</Label>
                      <Input
                        value={formData.name}
                        onChange={(e) => updateField("name", e.target.value)}
                        placeholder="3@1 Newmarket"
                        required
                      />
                    </div>
                    <div>
                      <Label>Logo</Label>
                      <Input
                        type="file"
                        accept="image/*"
                        disabled={uploadAsset.isPending}
                        onChange={(e) =>
                          handleLogoFileChange(e.target.files?.[0] ?? null)
                        }
                      />
                      {uploadAsset.isPending && (
                        <p className="text-xs text-muted-foreground mt-1">Uploading logo…</p>
                      )}
                      {formData.logo && (
                        <div className="mt-2 flex items-center gap-2">
                          <img
                            src={formData.logo}
                            alt="Logo preview"
                            className="w-12 h-12 object-contain rounded border"
                          />
                          <span className="text-xs text-muted-foreground">Logo uploaded</span>
                        </div>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label>Website</Label>
                        <Input
                          value={formData.website}
                          onChange={(e) => updateField("website", e.target.value)}
                          placeholder="https://example.com"
                        />
                      </div>
                      <div>
                        <Label>Location</Label>
                        <Input
                          value={formData.location}
                          onChange={(e) => updateField("location", e.target.value)}
                          placeholder="Johannesburg"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label>Email</Label>
                        <Input
                          type="email"
                          value={formData.email}
                          onChange={(e) => updateField("email", e.target.value)}
                          placeholder="hello@example.com"
                        />
                      </div>
                      <div>
                        <Label>WhatsApp Number</Label>
                        <Input
                          value={formData.whatsappNumber}
                          onChange={(e) => updateField("whatsappNumber", e.target.value)}
                          placeholder="+27 82 000 0000"
                        />
                      </div>
                    </div>
                    <div>
                      <Label>Optional short description</Label>
                      <Textarea
                        value={formData.description}
                        onChange={(e) => updateField("description", e.target.value)}
                        placeholder="What does your business do?"
                      />
                    </div>
                  </div>

                  {/* Section B: AI-completed profile */}
                  <div className="space-y-4 pt-4 border-t">
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                        AI-completed business profile
                      </h4>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleAiComplete}
                        disabled={completeProfileWithAi.isPending || !formData.name.trim()}
                      >
                        {completeProfileWithAi.isPending ? (
                          <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                        ) : (
                          <Sparkles className="w-3.5 h-3.5 mr-1.5" />
                        )}
                        Complete Business Profile with AI
                      </Button>
                    </div>

                    <div>
                      <Label>Description</Label>
                      <Textarea
                        value={formData.description}
                        onChange={(e) => updateField("description", e.target.value)}
                        placeholder="AI-generated business description"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label>Industry</Label>
                        <Input
                          value={formData.industry}
                          onChange={(e) => updateField("industry", e.target.value)}
                          placeholder="Retail, Tech..."
                        />
                      </div>
                      <div>
                        <Label>Brand Tone</Label>
                        <Input
                          value={formData.brandTone}
                          onChange={(e) => updateField("brandTone", e.target.value)}
                          placeholder="premium, bold, friendly"
                        />
                      </div>
                    </div>
                    <div>
                      <Label>Target Audience</Label>
                      <Input
                        value={formData.targetAudience}
                        onChange={(e) => updateField("targetAudience", e.target.value)}
                        placeholder="Young professionals..."
                      />
                    </div>
                    <div>
                      <Label>Product or Service</Label>
                      <Input
                        value={formData.productOrService}
                        onChange={(e) => updateField("productOrService", e.target.value)}
                        placeholder="e.g. same-day printing, custom T-shirts"
                      />
                    </div>
                    <div>
                      <Label>Brand Colours (comma separated)</Label>
                      <Input
                        value={formData.brandColors}
                        onChange={(e) => updateField("brandColors", e.target.value)}
                        placeholder="#0F172A, #00D4FF, #FFFFFF"
                      />
                    </div>
                    <div>
                      <Label>Visual Style</Label>
                      <Input
                        value={formData.visualStyle}
                        onChange={(e) => updateField("visualStyle", e.target.value)}
                        placeholder="modern, minimal, bold"
                      />
                    </div>
                    <div>
                      <Label>Brand Voice Notes</Label>
                      <Input
                        value={formData.brandVoiceNotes}
                        onChange={(e) => updateField("brandVoiceNotes", e.target.value)}
                        placeholder="Short sentences, no slang"
                      />
                    </div>
                    <div>
                      <Label>Words to Avoid</Label>
                      <Input
                        value={formData.avoidWords}
                        onChange={(e) => updateField("avoidWords", e.target.value)}
                        placeholder="cheap, discount, guaranteed"
                      />
                    </div>
                    <div>
                      <Label>Main Goal</Label>
                      <Input
                        value={formData.mainGoal}
                        onChange={(e) => updateField("mainGoal", e.target.value)}
                        placeholder="Increase brand awareness"
                      />
                    </div>
                    <div>
                      <Label>Premium Content Preferences</Label>
                      <Input
                        value={formData.premiumContentPreferences}
                        onChange={(e) =>
                          updateField("premiumContentPreferences", e.target.value)
                        }
                        placeholder="e.g. video ads, carousel posts"
                      />
                    </div>
                  </div>

                  <Button
                    type="submit"
                    className="w-full bg-gradient-to-r from-[#00D4FF] to-[#7C3AED]"
                    disabled={submitPending}
                  >
                    {submitPending ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : null}
                    {dialogMode === "create" ? "Add Business" : "Update Business"}
                  </Button>
                </form>
              </DialogContent>
            </Dialog>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {businesses?.length === 0 && (
              <Card className="col-span-full">
                <CardContent className="flex flex-col items-center justify-center py-12">
                  <Building2 className="w-10 h-10 text-muted-foreground mb-3" />
                  <p className="text-sm text-muted-foreground">
                    No businesses added yet. Add your first business to get started.
                  </p>
                </CardContent>
              </Card>
            )}
            {businesses?.map((biz) => (
              <Card key={biz.id} className="group hover:shadow-md transition-all">
                <CardContent className="p-5">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-3">
                      {biz.logo ? (
                        <img
                          src={biz.logo}
                          alt={biz.name}
                          className="w-10 h-10 object-contain rounded-lg border bg-white"
                        />
                      ) : (
                        <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-[#00D4FF] to-[#7C3AED] flex items-center justify-center text-white font-bold text-sm">
                          {biz.name.charAt(0).toUpperCase()}
                        </div>
                      )}
                      <div>
                        <p className="font-semibold">{biz.name}</p>
                        {biz.industry && (
                          <p className="text-xs text-muted-foreground">{biz.industry}</p>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => openEditDialog(biz)}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-red-500"
                        onClick={() => setDeleteDialog({ open: true, biz })}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>

                  <div className="space-y-1 mb-3">
                    {biz.location && (
                      <p className="text-xs text-muted-foreground flex items-center gap-1">
                        <MapPin className="w-3 h-3" />
                        {biz.location}
                      </p>
                    )}
                    {biz.website ? (
                      <p className="text-xs text-muted-foreground flex items-center gap-1">
                        <ExternalLink className="w-3 h-3" />
                        {biz.website}
                      </p>
                    ) : biz.whatsappNumber ? (
                      <p className="text-xs text-muted-foreground flex items-center gap-1">
                        <Phone className="w-3 h-3" />
                        {biz.whatsappNumber}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex flex-wrap gap-2 mt-2">
                    {biz.isActive ? (
                      <Badge className="bg-emerald-500/10 text-emerald-600 text-xs">
                        Active
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-xs">
                        Inactive
                      </Badge>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        {/* Security Tab */}
        <TabsContent value="security" className="space-y-6">
          <SecuritySettings />
        </TabsContent>

        {/* Preferences Tab */}
        <TabsContent value="preferences" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Bell className="w-4 h-4 text-[#00D4FF]" />
                Notifications
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between py-2">
                <div>
                  <p className="text-sm font-medium">Campaign Updates</p>
                  <p className="text-xs text-muted-foreground">
                    Get notified when campaigns start or end
                  </p>
                </div>
                <Badge variant="outline">Coming Soon</Badge>
              </div>
              <div className="flex items-center justify-between py-2 border-t">
                <div>
                  <p className="text-sm font-medium">New Leads</p>
                  <p className="text-xs text-muted-foreground">
                    Get notified when new leads are added
                  </p>
                </div>
                <Badge variant="outline">Coming Soon</Badge>
              </div>
              <div className="flex items-center justify-between py-2 border-t">
                <div>
                  <p className="text-sm font-medium">Schedule Reminders</p>
                  <p className="text-xs text-muted-foreground">
                    Get reminded before scheduled posts
                  </p>
                </div>
                <Badge variant="outline">Coming Soon</Badge>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Globe className="w-4 h-4 text-emerald-500" />
                Platform Integrations
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <PlatformIntegrationRow
                name="Instagram"
                description="Professional account"
                icon={Instagram}
                iconClass="from-pink-500 to-purple-600"
                configured={platformConfigStatus?.metaConfigured ?? false}
                integration={connectedPlatforms?.find((i) => i.provider === "instagram")}
                onConnect={() => initiateConnection.mutate({ provider: "meta" })}
                onDisconnect={(id) => disconnectPlatform.mutate({ id })}
                isConnecting={initiateConnection.isPending}
                isDisconnecting={disconnectPlatform.isPending}
                isAdmin={isAdmin}
              />
              <div className="border-t" />
              <PlatformIntegrationRow
                name="LinkedIn"
                description="Profile or company page"
                icon={Linkedin}
                iconClass="from-blue-500 to-cyan-600"
                configured={platformConfigStatus?.linkedinConfigured ?? false}
                integration={connectedPlatforms?.find((i) => i.provider === "linkedin")}
                onConnect={() => initiateConnection.mutate({ provider: "linkedin" })}
                onDisconnect={(id) => disconnectPlatform.mutate({ id })}
                isConnecting={initiateConnection.isPending}
                isDisconnecting={disconnectPlatform.isPending}
                isAdmin={isAdmin}
              />
              <div className="border-t" />
              <PlatformIntegrationRow
                name="Facebook"
                description="Page"
                icon={Facebook}
                iconClass="from-indigo-500 to-blue-600"
                configured={platformConfigStatus?.metaConfigured ?? false}
                integration={connectedPlatforms?.find((i) => i.provider === "facebook")}
                onConnect={() => initiateConnection.mutate({ provider: "meta" })}
                onDisconnect={(id) => disconnectPlatform.mutate({ id })}
                isConnecting={initiateConnection.isPending}
                isDisconnecting={disconnectPlatform.isPending}
                isAdmin={isAdmin}
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Duplicate confirmation dialog */}
      <Dialog open={duplicateDialog.open} onOpenChange={(open) => setDuplicateDialog({ open })}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Business already exists</DialogTitle>
            <DialogDescription>
              {duplicateDialog.message ||
                "A business with this name already exists. Do you want to edit the existing business instead?"}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 pt-2">
            <Button onClick={handleEditExisting} variant="outline">
              Edit existing
            </Button>
            <Button
              onClick={handleCreateAnyway}
              className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] text-white"
            >
              Create anyway
            </Button>
            <Button variant="ghost" onClick={() => setDuplicateDialog({ open: false })}>
              Cancel
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog open={deleteDialog.open} onOpenChange={(open) => setDeleteDialog({ open })}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete business profile?</DialogTitle>
            <DialogDescription>
              Delete this business profile? Existing campaigns may lose business context.
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2 pt-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setDeleteDialog({ open: false })}
            >
              Cancel
            </Button>
            <Button
              className="flex-1 bg-red-600 hover:bg-red-700 text-white"
              onClick={() => deleteDialog.biz && deleteBiz.mutate({ id: deleteDialog.biz.id })}
              disabled={deleteBiz.isPending}
            >
              {deleteBiz.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : null}
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
