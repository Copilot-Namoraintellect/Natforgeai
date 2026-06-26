import { useState, useEffect, useMemo } from "react";
import { useSearchParams } from "react-router";
import { trpc } from "@/providers/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import {
  Plug,
  Facebook,
  Instagram,
  Linkedin,
  Twitter,
  MessageCircle,
  Mail,
  Video,
  CheckCircle,
  XCircle,
  Clock,
  ExternalLink,
  Loader2,
  AlertCircle,
} from "lucide-react";

const platformConfig: Record<string, { icon: any; name: string; description: string; capabilities: string[]; setupUrl?: string }> = {
  facebook: {
    icon: Facebook,
    name: "Facebook Page",
    description: "Publish posts and manage page inbox",
    capabilities: ["Publishing", "Inbox"],
    setupUrl: "https://developers.facebook.com/apps/",
  },
  instagram: {
    icon: Instagram,
    name: "Instagram Business",
    description: "Publish posts, stories, and manage DMs",
    capabilities: ["Publishing", "Inbox"],
    setupUrl: "https://developers.facebook.com/apps/",
  },
  linkedin: {
    icon: Linkedin,
    name: "LinkedIn Company",
    description: "Share updates and manage company page",
    capabilities: ["Publishing"],
    setupUrl: "https://www.linkedin.com/developers/apps/",
  },
  tiktok: {
    icon: Video,
    name: "TikTok Business",
    description: "Publish videos and manage comments",
    capabilities: ["Publishing", "Inbox"],
    setupUrl: "https://developers.tiktok.com/",
  },
  twitter: {
    icon: Twitter,
    name: "X / Twitter",
    description: "Post tweets and manage mentions",
    capabilities: ["Publishing", "Inbox"],
    setupUrl: "https://developer.twitter.com/en/portal/dashboard",
  },
  whatsapp: {
    icon: MessageCircle,
    name: "WhatsApp Business",
    description: "Send messages and manage conversations",
    capabilities: ["Inbox", "Messaging"],
    setupUrl: "https://business.facebook.com/wa/manage/home/",
  },
  email: {
    icon: Mail,
    name: "Email Provider",
    description: "Send marketing emails and sequences",
    capabilities: ["Publishing"],
  },
};

const statusConfig: Record<string, { color: string; icon: any; label: string }> = {
  connected: { color: "bg-emerald-500/10 text-emerald-600", icon: CheckCircle, label: "Connected" },
  expired: { color: "bg-amber-500/10 text-amber-600", icon: Clock, label: "Expired" },
  disconnected: { color: "bg-gray-500/10 text-gray-600", icon: XCircle, label: "Disconnected" },
};

export default function Integrations() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [connectingPlatform, setConnectingPlatform] = useState<string | null>(null);
  const [emailConfigOpen, setEmailConfigOpen] = useState(false);
  const [explainPlatform, setExplainPlatform] = useState<string | null>(null);
  const [emailConfig, setEmailConfig] = useState({
    fromEmail: "",
    fromName: "",
    smtpHost: "",
    smtpPort: "587",
    smtpUser: "",
    smtpPass: "",
  });
  const [, setEmailErrors] = useState<string[]>([]);

  const utils = trpc.useUtils();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const { data: connectedPlatforms } = trpc.integration.getConnectedPlatforms.useQuery();
  const { data: platformConfigStatus } = trpc.integration.getPlatformConfigStatus.useQuery();

  const integrations = useMemo(
    () =>
      connectedPlatforms?.map((i) => ({
        id: i.id,
        platform: i.provider,
        accountName: i.providerAccountName,
        status: i.status,
        ready: i.ready,
        createdAt: i.createdAt,
      })) ?? [],
    [connectedPlatforms]
  );

  const hasPublishingReadyPlatform = useMemo(
    () => integrations.some((i) => i.status === "connected" && i.ready),
    [integrations]
  );

  const platformStatus = useMemo(
    () => [
      { platform: "facebook", configured: platformConfigStatus?.metaConfigured ?? false },
      { platform: "instagram", configured: platformConfigStatus?.metaConfigured ?? false },
      { platform: "linkedin", configured: platformConfigStatus?.linkedinConfigured ?? false },
      { platform: "tiktok", configured: false },
      { platform: "twitter", configured: false },
      { platform: "whatsapp", configured: false },
      { platform: "email", configured: false },
    ],
    [platformConfigStatus]
  );

  // Handle OAuth callback results
  useEffect(() => {
    const success = searchParams.get("success");
    const error = searchParams.get("error");

    if (success) {
      toast.success(`${platformConfig[success]?.name || success} connected successfully!`);
      setSearchParams({}, { replace: true });
      utils.integration.getConnectedPlatforms.invalidate();
    }

    if (error) {
      toast.error(`Connection failed: ${decodeURIComponent(error)}`);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams]);
  const disconnectMutation = trpc.integration.disconnectPlatform.useMutation({
    onSuccess: () => {
      toast.success("Platform disconnected");
      utils.integration.getConnectedPlatforms.invalidate();
    },
  });
  const testMutation = trpc.integration.testConnection.useMutation({
    onSuccess: () => {
      toast.success(`Connection test passed!`);
    },
    onError: (err) => toast.error(err.message),
  });

  const getIntegrationStatus = (platform: string) => {
    const integration = integrations?.find((i) => i.platform === platform);
    return integration?.status || "disconnected";
  };

  const getIntegration = (platform: string) => {
    return integrations?.find((i) => i.platform === platform);
  };

  const handleConnect = async (platform: string) => {
    if (platform === "email") {
      setEmailConfigOpen(true);
      return;
    }

    setConnectingPlatform(platform);
    try {
      const { url } = await utils.integration.getOAuthUrl.fetch({
        platform: platform as "facebook" | "instagram" | "linkedin" | "tiktok" | "twitter" | "whatsapp" | "email",
      });

      if (url) {
        window.location.href = url;
      } else {
        toast.info(`${platformConfig[platform].name} integration requires API credentials. Set environment variables to enable.`);
      }
    } catch (err: any) {
      toast.error(err.message || "Failed to initiate connection");
    } finally {
      setConnectingPlatform(null);
    }
  };

  const handleEmailSave = () => {
    const errors: string[] = [];
    if (!emailConfig.fromEmail) errors.push("From email is required");
    if (!emailConfig.smtpHost) errors.push("SMTP host is required");
    if (!emailConfig.smtpPort) errors.push("SMTP port is required");
    if (!emailConfig.smtpUser) errors.push("SMTP user is required");
    if (!emailConfig.smtpPass) errors.push("SMTP password is required");
    setEmailErrors(errors);
    if (errors.length > 0) {
      toast.error("Please fix the errors before saving");
      return;
    }
    toast.success("Email configuration saved successfully");
    setEmailConfigOpen(false);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <Plug className="w-6 h-6 text-[#00D4FF]" />
            Integrations
          </h1>
          <Badge variant="outline" className="text-[10px] text-[#00D4FF] border-[#00D4FF]/30">Premium</Badge>
        </div>
        <p className="text-slate-600 mt-1">
          Connect your social media, messaging, and email platforms for autonomous publishing.
        </p>
      </div>

      {/* Page-level explanation */}
      <Card className="bg-blue-500/5 border-blue-500/20">
        <CardContent className="p-4 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-blue-500 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm text-blue-700 font-medium">Integrations are only required for automatic publishing and inbox management</p>
            <p className="text-xs text-blue-600/80 mt-1">
              You can still generate strategy and content without connecting platforms. Connect integrations when you are ready to publish automatically or manage replies.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Setup notice */}
      {!hasPublishingReadyPlatform && (
        <Card className="bg-amber-500/5 border-amber-500/20">
          <CardContent className="p-4 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-amber-500 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm text-amber-700 font-medium">Publishing Setup Required</p>
              <p className="text-xs text-amber-600/80 mt-1">
                Social platform publishing is not yet connected. You can continue creating campaigns and generating content. Platform connections will be available once your workspace is configured.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Admin-only technical checklist */}
      {isAdmin && (
        <Card className="bg-[#1E293B] border-[#334155]">
          <CardContent className="p-4">
            <p className="text-sm font-medium text-white mb-2">Admin Setup Checklist</p>
            <p className="text-xs text-gray-400 mb-3">
              The following environment variables are required for platform integrations:
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs font-mono text-gray-300">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-amber-500" />
                FACEBOOK_APP_ID
              </div>
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-amber-500" />
                FACEBOOK_APP_SECRET
              </div>
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-amber-500" />
                LINKEDIN_CLIENT_ID
              </div>
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-amber-500" />
                LINKEDIN_CLIENT_SECRET
              </div>
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-amber-500" />
                TWITTER_API_KEY
              </div>
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-amber-500" />
                TIKTOK_CLIENT_KEY
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Platform Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {Object.entries(platformConfig).map(([platform, config]) => {
          const status = getIntegrationStatus(platform);
          const statusInfo = statusConfig[status];
          const StatusIcon = statusInfo.icon;
          const PlatformIcon = config.icon;
          const isConnected = status === "connected";
          const integration = getIntegration(platform);

          return (
            <Card
              key={platform}
              className={`bg-[#1E293B] border-[#334155] ${
                isConnected ? "border-emerald-500/30" : ""
              }`}
            >
              <CardContent className="p-5">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className={`p-2.5 rounded-xl ${isConnected ? "bg-emerald-500/10" : "bg-[#0F172A]"}`}>
                      <PlatformIcon className={`w-6 h-6 ${isConnected ? "text-emerald-400" : "text-[#00D4FF]"}`} />
                    </div>
                    <div>
                      <h3 className="font-semibold text-white">{config.name}</h3>
                      <Badge className={`${statusInfo.color} mt-1 border`}>
                        <StatusIcon className="w-3 h-3 mr-1" />
                        {statusInfo.label}
                      </Badge>
                    </div>
                  </div>
                </div>

                <p className="text-sm text-gray-400 mb-3">{config.description}</p>

                {integration?.accountName && (
                  <p className="text-xs text-gray-500 mb-2">
                    Account: {integration.accountName}
                  </p>
                )}

                <div className="flex flex-wrap gap-1.5 mb-4">
                  {config.capabilities.map((cap) => (
                    <span
                      key={cap}
                      className="text-[10px] px-2 py-0.5 rounded-full bg-[#0F172A] text-gray-400 border border-[#334155]"
                    >
                      {cap}
                    </span>
                  ))}
                </div>

                <div className="flex gap-2 flex-wrap">
                  {isConnected ? (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        className="border-[#334155] text-gray-300 hover:text-white hover:bg-[#334155]"
                        onClick={() => testMutation.mutate({ platform: platform as any })}
                        disabled={testMutation.isPending}
                      >
                        {testMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Test"}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="border-red-500/30 text-red-400 hover:bg-red-500/10"
                        onClick={() =>
                          integration?.id && disconnectMutation.mutate({ id: integration.id })
                        }
                        disabled={disconnectMutation.isPending}
                      >
                        Disconnect
                      </Button>
                    </>
                  ) : (
                    <>
                      {platformStatus?.find((p) => p.platform === platform)?.configured === false ? (
                        <div className="flex items-center gap-2 flex-wrap">
                          <Button
                            size="sm"
                            variant="outline"
                            className="border-amber-500/30 text-amber-400 hover:bg-amber-500/10"
                            onClick={() => setExplainPlatform(platform)}
                          >
                            <AlertCircle className="w-3.5 h-3.5 mr-1" />
                            Not Available
                          </Button>
                          {config.setupUrl && isAdmin && (
                            <a
                              href={config.setupUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <Button
                                variant="outline"
                                size="sm"
                                className="border-[#334155] text-gray-300 hover:text-white hover:bg-[#334155]"
                              >
                                <ExternalLink className="w-3.5 h-3.5 mr-1" />
                                Setup
                              </Button>
                            </a>
                          )}
                        </div>
                      ) : (
                        <>
                          <Button
                            size="sm"
                            className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] text-white hover:opacity-90"
                            onClick={() => handleConnect(platform)}
                            disabled={connectingPlatform === platform}
                          >
                            {connectingPlatform === platform ? (
                              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            ) : (
                              <Plug className="w-4 h-4 mr-2" />
                            )}
                            {isConnected ? "Reconnect" : "Connect"}
                          </Button>
                          {config.setupUrl && isAdmin && (
                            <a
                              href={config.setupUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <Button
                                variant="outline"
                                size="sm"
                                className="border-[#334155] text-gray-300 hover:text-white hover:bg-[#334155]"
                              >
                                <ExternalLink className="w-3.5 h-3.5 mr-1" />
                                Setup
                              </Button>
                            </a>
                          )}
                        </>
                      )}
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Platform Explanation Dialog */}
      <Dialog open={!!explainPlatform} onOpenChange={() => setExplainPlatform(null)}>
        <DialogContent className="bg-[#1E293B] border-[#334155] text-white">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-amber-400" />
              {explainPlatform ? platformConfig[explainPlatform]?.name || explainPlatform : ""}
            </DialogTitle>
            <DialogDescription className="text-gray-400">
              {explainPlatform === "whatsapp"
                ? "WhatsApp Business integration is not available yet. It requires Meta Business API setup which is not configured."
                : explainPlatform === "email"
                ? "Email provider integration is not available yet. SMTP-based sending will be enabled in a future update."
                : "Automatic publishing is not available for this platform yet."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm text-gray-300">
            <p>
              {explainPlatform === "whatsapp"
                ? "WhatsApp Business API requires a verified Meta Business account, phone number registration, and message template approval. This infrastructure is not yet configured for your workspace."
                : explainPlatform === "email"
                ? "Email sending requires SMTP provider configuration (SendGrid, Mailgun, AWS SES, etc.) and domain authentication. This will be available in a future update."
                : "Platform setup is not enabled for this workspace yet. You can still generate content and publish manually."}
            </p>
            <p className="text-gray-500">
              Integrations are only required for automatic publishing and inbox management. Strategy and content generation work without any platform connected.
            </p>
          </div>
        </DialogContent>
      </Dialog>

      {/* Email Config Dialog */}
      <Dialog open={emailConfigOpen} onOpenChange={setEmailConfigOpen}>
        <DialogContent className="bg-[#1E293B] border-[#334155] text-white">
          <DialogHeader>
            <DialogTitle>Email Provider Configuration</DialogTitle>
            <DialogDescription>
              Enter your SMTP settings to send marketing emails.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label className="text-gray-300">From Email</Label>
                <Input
                  value={emailConfig.fromEmail}
                  onChange={(e) => setEmailConfig((p) => ({ ...p, fromEmail: e.target.value }))}
                  placeholder="noreply@yourcompany.com"
                  className="bg-[#0F172A] border-[#334155] text-white"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-gray-300">From Name</Label>
                <Input
                  value={emailConfig.fromName}
                  onChange={(e) => setEmailConfig((p) => ({ ...p, fromName: e.target.value }))}
                  placeholder="Your Company"
                  className="bg-[#0F172A] border-[#334155] text-white"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label className="text-gray-300">SMTP Host</Label>
              <Input
                value={emailConfig.smtpHost}
                onChange={(e) => setEmailConfig((p) => ({ ...p, smtpHost: e.target.value }))}
                placeholder="smtp.gmail.com"
                className="bg-[#0F172A] border-[#334155] text-white"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label className="text-gray-300">SMTP Port</Label>
                <Input
                  value={emailConfig.smtpPort}
                  onChange={(e) => setEmailConfig((p) => ({ ...p, smtpPort: e.target.value }))}
                  className="bg-[#0F172A] border-[#334155] text-white"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-gray-300">SMTP User</Label>
                <Input
                  value={emailConfig.smtpUser}
                  onChange={(e) => setEmailConfig((p) => ({ ...p, smtpUser: e.target.value }))}
                  className="bg-[#0F172A] border-[#334155] text-white"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label className="text-gray-300">SMTP Password</Label>
              <Input
                type="password"
                value={emailConfig.smtpPass}
                onChange={(e) => setEmailConfig((p) => ({ ...p, smtpPass: e.target.value }))}
                className="bg-[#0F172A] border-[#334155] text-white"
              />
            </div>
            <div className="flex justify-end gap-3">
              <Button
                variant="outline"
                onClick={() => setEmailConfigOpen(false)}
                className="border-[#334155] text-gray-300"
              >
                Cancel
              </Button>
              <Button
                onClick={handleEmailSave}
                className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] text-white"
              >
                Save Configuration
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
