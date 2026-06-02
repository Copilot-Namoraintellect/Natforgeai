import { useState, useEffect } from "react";
import { useSearchParams } from "react-router";
import { trpc } from "@/providers/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
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
  const [emailConfig, setEmailConfig] = useState({
    fromEmail: "",
    fromName: "",
    smtpHost: "",
    smtpPort: "587",
    smtpUser: "",
    smtpPass: "",
  });

  const utils = trpc.useUtils();
  const { data: integrations } = trpc.integration.getConnectedPlatforms.useQuery();

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
      const result = await fetch(`/api/trpc/integration.getOAuthUrl?input=${encodeURIComponent(JSON.stringify({ json: { platform } }))}`, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem("auth_token")}`,
        },
      });

      const data = await result.json();

      if (data.result?.data?.url) {
        window.location.href = data.result.data.url;
      } else if (data.error) {
        toast.error(data.error.message || "Failed to get OAuth URL");
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
    toast.success("Email configuration saved (mock - implement SMTP integration)");
    setEmailConfigOpen(false);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <Plug className="w-6 h-6 text-[#00D4FF]" />
          Integrations
        </h1>
        <p className="text-gray-400 mt-1">
          Connect your social media, messaging, and email platforms
        </p>
      </div>

      {/* Setup notice */}
      <Card className="bg-amber-500/5 border-amber-500/20">
        <CardContent className="p-4 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-amber-500 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm text-amber-200 font-medium">Platform API Setup Required</p>
            <p className="text-xs text-amber-200/70 mt-1">
              To connect social platforms, you need to add API credentials to your environment variables:
              FACEBOOK_APP_ID, FACEBOOK_APP_SECRET, LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET, etc.
              Without these, connections will show as "not configured."
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Platform Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
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
                    <div className="p-2.5 rounded-xl bg-[#0F172A]">
                      <PlatformIcon className="w-6 h-6 text-[#00D4FF]" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-white">{config.name}</h3>
                      <Badge className={`${statusInfo.color} mt-1`}>
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

                <div className="flex gap-2">
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
                        onClick={() => disconnectMutation.mutate({ platform: platform as any })}
                      >
                        Disconnect
                      </Button>
                    </>
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
                        Connect
                      </Button>
                      {config.setupUrl && (
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
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Email Config Dialog */}
      <Dialog open={emailConfigOpen} onOpenChange={setEmailConfigOpen}>
        <DialogContent className="bg-[#1E293B] border-[#334155] text-white">
          <DialogHeader>
            <DialogTitle>Email Provider Configuration</DialogTitle>
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
