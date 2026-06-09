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
} from "lucide-react";
import { toast } from "sonner";

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
  const [bizOpen, setBizOpen] = useState(false);
  const [editBiz, setEditBiz] = useState<any>(null);
  const utils = trpc.useUtils();

  const { data: businesses } = trpc.business.list.useQuery();

  const createBiz = trpc.business.create.useMutation({
    onSuccess: () => {
      utils.business.list.invalidate();
      setBizOpen(false);
      toast.success("Business added!");
    },
  });

  const updateBiz = trpc.business.update.useMutation({
    onSuccess: () => {
      utils.business.list.invalidate();
      setEditBiz(null);
      toast.success("Business updated!");
    },
  });

  const deleteBiz = trpc.business.delete.useMutation({
    onSuccess: () => {
      utils.business.list.invalidate();
      toast.success("Business removed!");
    },
  });

  function handleCreateBiz(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    createBiz.mutate({
      name: form.get("name") as string,
      description: (form.get("description") as string) || undefined,
      industry: (form.get("industry") as string) || undefined,
      location: (form.get("location") as string) || undefined,
      targetAudience: (form.get("targetAudience") as string) || undefined,
      tone: (form.get("tone") as string) || undefined,
      website: (form.get("website") as string) || undefined,
    });
  }

  function handleUpdateBiz(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editBiz) return;
    const form = new FormData(e.currentTarget);
    updateBiz.mutate({
      id: editBiz.id,
      name: (form.get("name") as string) || undefined,
      description: (form.get("description") as string) || undefined,
      industry: (form.get("industry") as string) || undefined,
      location: (form.get("location") as string) || undefined,
      targetAudience: (form.get("targetAudience") as string) || undefined,
      tone: (form.get("tone") as string) || undefined,
      website: (form.get("website") as string) || undefined,
    });
  }

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
            <Dialog open={bizOpen} onOpenChange={setBizOpen}>
              <DialogTrigger asChild>
                <Button size="sm">
                  <Plus className="w-4 h-4 mr-2" />
                  Add Business
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>Add Business</DialogTitle>
                  <DialogDescription>
                    Add your business profile to use with campaigns.
                  </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleCreateBiz} className="space-y-4 mt-4">
                  <div>
                    <Label>Business Name *</Label>
                    <Input name="name" placeholder="3@1 Newmarket" required />
                  </div>
                  <div>
                    <Label>Description</Label>
                    <Textarea name="description" placeholder="What does your business do?" />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>Industry</Label>
                      <Input name="industry" placeholder="Retail, Tech..." />
                    </div>
                    <div>
                      <Label>Location</Label>
                      <Input name="location" placeholder="Johannesburg" />
                    </div>
                  </div>
                  <div>
                    <Label>Target Audience</Label>
                    <Input name="targetAudience" placeholder="Young professionals..." />
                  </div>
                  <div>
                    <Label>Brand Tone</Label>
                    <Input name="tone" placeholder="premium, bold, friendly" />
                  </div>
                  <div>
                    <Label>Website</Label>
                    <Input name="website" placeholder="https://example.com" />
                  </div>
                  <Button
                    type="submit"
                    className="w-full bg-gradient-to-r from-[#00D4FF] to-[#7C3AED]"
                    disabled={createBiz.isPending}
                  >
                    {createBiz.isPending ? "Adding..." : "Add Business"}
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
                      <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-[#00D4FF] to-[#7C3AED] flex items-center justify-center text-white font-bold text-sm">
                        {biz.name.charAt(0).toUpperCase()}
                      </div>
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
                        onClick={() => setEditBiz(biz)}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-red-500"
                        onClick={() => deleteBiz.mutate({ id: biz.id })}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>

                  {biz.description && (
                    <p className="text-sm text-muted-foreground mb-2 line-clamp-2">
                      {biz.description}
                    </p>
                  )}

                  <div className="flex flex-wrap gap-2 mt-2">
                    {biz.location && (
                      <Badge variant="outline" className="text-xs">
                        {biz.location}
                      </Badge>
                    )}
                    {biz.tone && (
                      <Badge variant="outline" className="text-xs">
                        {biz.tone}
                      </Badge>
                    )}
                    {biz.isActive && (
                      <Badge className="bg-emerald-500/10 text-emerald-600 text-xs">
                        Active
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
              <div className="flex items-center justify-between py-2">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-gradient-to-br from-pink-500 to-purple-600">
                    <Sparkles className="w-4 h-4 text-white" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">Instagram</p>
                    <p className="text-xs text-muted-foreground">Connect your account</p>
                  </div>
                </div>
                <Badge variant="outline">Coming Soon</Badge>
              </div>
              <div className="flex items-center justify-between py-2 border-t">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-gradient-to-br from-blue-500 to-cyan-600">
                    <Sparkles className="w-4 h-4 text-white" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">LinkedIn</p>
                    <p className="text-xs text-muted-foreground">Connect your account</p>
                  </div>
                </div>
                <Badge variant="outline">Coming Soon</Badge>
              </div>
              <div className="flex items-center justify-between py-2 border-t">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-gradient-to-br from-indigo-500 to-blue-600">
                    <Sparkles className="w-4 h-4 text-white" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">Facebook</p>
                    <p className="text-xs text-muted-foreground">Connect your account</p>
                  </div>
                </div>
                <Badge variant="outline">Coming Soon</Badge>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Edit Business Dialog */}
      {editBiz && (
        <Dialog open={!!editBiz} onOpenChange={() => setEditBiz(null)}>
          <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Edit Business</DialogTitle>
              <DialogDescription>
                Update your business profile details.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleUpdateBiz} className="space-y-4 mt-4">
              <div>
                <Label>Business Name</Label>
                <Input name="name" defaultValue={editBiz.name} />
              </div>
              <div>
                <Label>Description</Label>
                <Textarea name="description" defaultValue={editBiz.description || ""} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Industry</Label>
                  <Input name="industry" defaultValue={editBiz.industry || ""} />
                </div>
                <div>
                  <Label>Location</Label>
                  <Input name="location" defaultValue={editBiz.location || ""} />
                </div>
              </div>
              <div>
                <Label>Target Audience</Label>
                <Input name="targetAudience" defaultValue={editBiz.targetAudience || ""} />
              </div>
              <div>
                <Label>Brand Tone</Label>
                <Input name="tone" defaultValue={editBiz.tone || ""} />
              </div>
              <div>
                <Label>Website</Label>
                <Input name="website" defaultValue={editBiz.website || ""} />
              </div>
              <Button
                type="submit"
                className="w-full bg-gradient-to-r from-[#00D4FF] to-[#7C3AED]"
                disabled={updateBiz.isPending}
              >
                {updateBiz.isPending ? "Saving..." : "Update Business"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
