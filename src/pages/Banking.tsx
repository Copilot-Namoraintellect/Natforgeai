import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Building2,
  Landmark,
  CreditCard,
  Globe,
  Bitcoin,
  Plus,
  Trash2,
  Star,
  Check,
  Loader2,
  Save,
} from "lucide-react";
import { toast } from "sonner";

export default function Banking() {
  const [activeTab, setActiveTab] = useState("bank");
  const utils = trpc.useUtils();

  const { data: bankingList } = trpc.banking.list.useQuery();
  const [createForm, setCreateForm] = useState({
    accountName: "",
    bankName: "",
    accountNumber: "",
    branchCode: "",
    swiftCode: "",
    iban: "",
    routingNumber: "",
    stripeAccountId: "",
    paypalEmail: "",
    cryptoWalletAddress: "",
    cryptoNetwork: "",
  });

  const createMutation = trpc.banking.create.useMutation({
    onSuccess: () => {
      utils.banking.list.invalidate();
      resetForm();
      toast.success("Banking details added!");
    },
  });

  const updateMutation = trpc.banking.update.useMutation({
    onSuccess: () => {
      utils.banking.list.invalidate();
      toast.success("Banking details updated!");
    },
  });

  const deleteMutation = trpc.banking.delete.useMutation({
    onSuccess: () => {
      utils.banking.list.invalidate();
      toast.success("Banking details removed!");
    },
  });

  function resetForm() {
    setCreateForm({
      accountName: "",
      bankName: "",
      accountNumber: "",
      branchCode: "",
      swiftCode: "",
      iban: "",
      routingNumber: "",
      stripeAccountId: "",
      paypalEmail: "",
      cryptoWalletAddress: "",
      cryptoNetwork: "",
    });
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const data = { ...createForm };
    // Only send relevant fields based on tab
    if (activeTab === "bank") {
      createMutation.mutate({
        accountName: data.accountName,
        bankName: data.bankName,
        accountNumber: data.accountNumber,
        branchCode: data.branchCode,
        swiftCode: data.swiftCode,
        iban: data.iban,
        routingNumber: data.routingNumber,
      });
    } else if (activeTab === "stripe") {
      createMutation.mutate({ stripeAccountId: data.stripeAccountId });
    } else if (activeTab === "paypal") {
      createMutation.mutate({ paypalEmail: data.paypalEmail });
    } else if (activeTab === "crypto") {
      createMutation.mutate({
        cryptoWalletAddress: data.cryptoWalletAddress,
        cryptoNetwork: data.cryptoNetwork,
      });
    }
  }

  const defaultDetail = bankingList?.find((d) => d.isDefault);

  const filteredByType = (type: string) => {
    if (!bankingList) return [];
    if (type === "bank") return bankingList.filter((d) => d.bankName || d.accountNumber);
    if (type === "stripe") return bankingList.filter((d) => d.stripeAccountId);
    if (type === "paypal") return bankingList.filter((d) => d.paypalEmail);
    if (type === "crypto") return bankingList.filter((d) => d.cryptoWalletAddress);
    return [];
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Building2 className="w-6 h-6 text-[#00D4FF]" />
          Banking & Payment Details
        </h1>
        <p className="text-muted-foreground mt-1">
          Manage how you receive payments from subscribers.
        </p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-[#00D4FF]/10">
                <Landmark className="w-5 h-5 text-[#00D4FF]" />
              </div>
              <div>
                <p className="text-2xl font-bold">{filteredByType("bank").length}</p>
                <p className="text-xs text-muted-foreground">Bank Accounts</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-purple-500/10">
                <CreditCard className="w-5 h-5 text-purple-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{filteredByType("stripe").length}</p>
                <p className="text-xs text-muted-foreground">Stripe Accounts</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-500/10">
                <Globe className="w-5 h-5 text-blue-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{filteredByType("paypal").length}</p>
                <p className="text-xs text-muted-foreground">PayPal Accounts</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-amber-500/10">
                <Bitcoin className="w-5 h-5 text-amber-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{filteredByType("crypto").length}</p>
                <p className="text-xs text-muted-foreground">Crypto Wallets</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Default Banking Detail Display */}
      {defaultDetail && (
        <Card className="border-emerald-500/30 bg-emerald-500/5">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <Star className="w-4 h-4 text-emerald-500" />
              <span className="text-sm font-semibold text-emerald-600">Default Payment Method</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
              {defaultDetail.bankName && (
                <>
                  <div><span className="text-muted-foreground">Bank:</span> {defaultDetail.bankName}</div>
                  <div><span className="text-muted-foreground">Account:</span> ****{defaultDetail.accountNumber?.slice(-4)}</div>
                  <div><span className="text-muted-foreground">Type:</span> {defaultDetail.accountType}</div>
                  <div><span className="text-muted-foreground">Branch:</span> {defaultDetail.branchCode}</div>
                </>
              )}
              {defaultDetail.stripeAccountId && (
                <div className="col-span-2"><span className="text-muted-foreground">Stripe:</span> {defaultDetail.stripeAccountId}</div>
              )}
              {defaultDetail.paypalEmail && (
                <div className="col-span-2"><span className="text-muted-foreground">PayPal:</span> {defaultDetail.paypalEmail}</div>
              )}
              {defaultDetail.cryptoWalletAddress && (
                <div className="col-span-2"><span className="text-muted-foreground">{defaultDetail.cryptoNetwork}:</span> {defaultDetail.cryptoWalletAddress?.slice(0, 12)}...{defaultDetail.cryptoWalletAddress?.slice(-8)}</div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Add New + List */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="bank">
            <Landmark className="w-3.5 h-3.5 mr-1" /> Bank Transfer
          </TabsTrigger>
          <TabsTrigger value="stripe">
            <CreditCard className="w-3.5 h-3.5 mr-1" /> Stripe
          </TabsTrigger>
          <TabsTrigger value="paypal">
            <Globe className="w-3.5 h-3.5 mr-1" /> PayPal
          </TabsTrigger>
          <TabsTrigger value="crypto">
            <Bitcoin className="w-3.5 h-3.5 mr-1" /> Crypto
          </TabsTrigger>
        </TabsList>

        <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Form */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Plus className="w-4 h-4" />
                Add {activeTab === "bank" ? "Bank Account" : activeTab === "stripe" ? "Stripe Account" : activeTab === "paypal" ? "PayPal" : "Crypto Wallet"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleCreate} className="space-y-3">
                {activeTab === "bank" && (
                  <>
                    <div>
                      <Label className="text-xs">Account Holder Name</Label>
                      <Input value={createForm.accountName} onChange={(e) => setCreateForm({ ...createForm, accountName: e.target.value })} placeholder="Your Business Name" className="h-9" />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label className="text-xs">Bank Name</Label>
                        <Input value={createForm.bankName} onChange={(e) => setCreateForm({ ...createForm, bankName: e.target.value })} placeholder="e.g. FNB" className="h-9" />
                      </div>
                      <div>
                        <Label className="text-xs">Account Number</Label>
                        <Input value={createForm.accountNumber} onChange={(e) => setCreateForm({ ...createForm, accountNumber: e.target.value })} placeholder="Account number" className="h-9" />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label className="text-xs">Branch Code</Label>
                        <Input value={createForm.branchCode} onChange={(e) => setCreateForm({ ...createForm, branchCode: e.target.value })} placeholder="e.g. 250655" className="h-9" />
                      </div>
                      <div>
                        <Label className="text-xs">SWIFT Code</Label>
                        <Input value={createForm.swiftCode} onChange={(e) => setCreateForm({ ...createForm, swiftCode: e.target.value })} placeholder="e.g. FIRNZAJJ" className="h-9" />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label className="text-xs">IBAN</Label>
                        <Input value={createForm.iban} onChange={(e) => setCreateForm({ ...createForm, iban: e.target.value })} placeholder="IBAN (if applicable)" className="h-9" />
                      </div>
                      <div>
                        <Label className="text-xs">Routing Number</Label>
                        <Input value={createForm.routingNumber} onChange={(e) => setCreateForm({ ...createForm, routingNumber: e.target.value })} placeholder="Routing number" className="h-9" />
                      </div>
                    </div>
                  </>
                )}

                {activeTab === "stripe" && (
                  <div>
                    <Label className="text-xs">Stripe Account ID</Label>
                    <Input value={createForm.stripeAccountId} onChange={(e) => setCreateForm({ ...createForm, stripeAccountId: e.target.value })} placeholder="acct_xxxxxxxxxxxxxxxx" className="h-9" />
                    <p className="text-xs text-muted-foreground mt-1">Find this in your Stripe Dashboard → Settings → Account Information</p>
                  </div>
                )}

                {activeTab === "paypal" && (
                  <div>
                    <Label className="text-xs">PayPal Business Email</Label>
                    <Input value={createForm.paypalEmail} onChange={(e) => setCreateForm({ ...createForm, paypalEmail: e.target.value })} placeholder="your-business@email.com" type="email" className="h-9" />
                  </div>
                )}

                {activeTab === "crypto" && (
                  <>
                    <div>
                      <Label className="text-xs">Wallet Address</Label>
                      <Input value={createForm.cryptoWalletAddress} onChange={(e) => setCreateForm({ ...createForm, cryptoWalletAddress: e.target.value })} placeholder="0x... or bc1..." className="h-9" />
                    </div>
                    <div>
                      <Label className="text-xs">Network</Label>
                      <Input value={createForm.cryptoNetwork} onChange={(e) => setCreateForm({ ...createForm, cryptoNetwork: e.target.value })} placeholder="e.g. Ethereum, Bitcoin, Polygon" className="h-9" />
                    </div>
                  </>
                )}

                <Button
                  type="submit"
                  className="w-full bg-gradient-to-r from-[#00D4FF] to-[#7C3AED]"
                  disabled={createMutation.isPending}
                  size="sm"
                >
                  {createMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                  Save Payment Method
                </Button>
              </form>
            </CardContent>
          </Card>

          {/* List */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Saved {activeTab === "bank" ? "Bank Accounts" : activeTab === "stripe" ? "Stripe Accounts" : activeTab === "paypal" ? "PayPal Accounts" : "Crypto Wallets"}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {filteredByType(activeTab).length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-6">
                  No {activeTab} payment methods saved yet.
                </p>
              )}
              {filteredByType(activeTab).map((detail) => (
                <div key={detail.id} className={`p-4 rounded-lg border ${detail.isDefault ? "border-emerald-500/30 bg-emerald-500/5" : "border-border bg-muted/30"}`}>
                  <div className="flex items-start justify-between">
                    <div className="space-y-1">
                      {activeTab === "bank" && (
                        <>
                          <p className="text-sm font-medium">{detail.bankName}</p>
                          <p className="text-xs text-muted-foreground">Account: ****{detail.accountNumber?.slice(-4)}</p>
                          <p className="text-xs text-muted-foreground">Holder: {detail.accountName}</p>
                          {detail.branchCode && <p className="text-xs text-muted-foreground">Branch: {detail.branchCode}</p>}
                        </>
                      )}
                      {activeTab === "stripe" && (
                        <p className="text-sm font-mono">{detail.stripeAccountId}</p>
                      )}
                      {activeTab === "paypal" && (
                        <p className="text-sm">{detail.paypalEmail}</p>
                      )}
                      {activeTab === "crypto" && (
                        <>
                          <p className="text-sm font-mono">{detail.cryptoWalletAddress?.slice(0, 16)}...{detail.cryptoWalletAddress?.slice(-8)}</p>
                          <p className="text-xs text-muted-foreground">Network: {detail.cryptoNetwork}</p>
                        </>
                      )}
                    </div>
                    <div className="flex gap-1">
                      {!detail.isDefault && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => updateMutation.mutate({ id: detail.id, isDefault: true })}
                        >
                          <Star className="w-3.5 h-3.5" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-red-500"
                        onClick={() => deleteMutation.mutate({ id: detail.id })}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                  {detail.isDefault && (
                    <Badge className="mt-2 bg-emerald-500/10 text-emerald-600 text-xs">
                      <Check className="w-3 h-3 mr-1" /> Default
                    </Badge>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </Tabs>
    </div>
  );
}
