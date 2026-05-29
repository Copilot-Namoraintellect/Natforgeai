import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/hooks/useAuth";
import { Logo } from "@/components/Logo";
import { Link } from "react-router";
import {
  Check,
  Zap,
  Crown,
  Rocket,
  ArrowRight,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";

const tierIcons: Record<string, any> = {
  free: Zap,
  startup: Rocket,
  growth: Zap,
  enterprise: Crown,
};

const tierColors: Record<string, string> = {
  free: "from-gray-400 to-gray-600",
  startup: "from-[#00D4FF] to-[#7C3AED]",
  growth: "from-[#7C3AED] to-[#00D4FF]",
  enterprise: "from-[#10B981] to-[#00D4FF]",
};

export default function Pricing() {
  const { isAuthenticated } = useAuth();
  const utils = trpc.useUtils();
  const [subscribingId, setSubscribingId] = useState<number | null>(null);

  const { data: tiers, isLoading } = trpc.subscription.tiers.useQuery();
  const { data: mySub } = trpc.subscription.mySubscription.useQuery(undefined, {
    enabled: isAuthenticated,
  });

  const subscribeMutation = trpc.subscription.subscribe.useMutation({
    onSuccess: (data) => {
      utils.subscription.mySubscription.invalidate();
      toast.success(`Subscribed to ${data.tier.name} plan!`);
      setSubscribingId(null);
    },
    onError: (err) => {
      toast.error(err.message || "Subscription failed");
      setSubscribingId(null);
    },
  });

  function handleSubscribe(tierId: number) {
    if (!isAuthenticated) {
      toast.info("Please log in to subscribe");
      return;
    }
    setSubscribingId(tierId);
    subscribeMutation.mutate({ tierId });
  }

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F8FAFC]">
      {/* Header */}
      <div className="border-b border-border bg-white/80 backdrop-blur-sm">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="flex items-center justify-between">
            <Logo />
            {isAuthenticated && (
              <Button variant="outline" size="sm" asChild className="rounded-xl">
                <Link to="/dashboard">Dashboard</Link>
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-[1280px] mx-auto px-4 sm:px-6 lg:px-8 py-12">
        {/* Title */}
        <div className="text-center mb-12">
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4 text-[#0F172A]">
            Choose Your Plan
          </h1>
          <p className="text-muted-foreground max-w-2xl mx-auto">
            Start free, upgrade when you are ready. All plans include core marketing tools.
          </p>
          {mySub && (
            <Badge className="mt-4 bg-[#00D4FF]/10 text-[#00D4FF] border-[#00D4FF]/20">
              Current Plan: {mySub.tier?.name || "Free"}
            </Badge>
          )}
        </div>

        {/* Tiers Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {tiers?.map((tier) => {
            const Icon = tierIcons[tier.slug] || Zap;
            const isCurrent = mySub?.tierId === tier.id;
            const isSubscribing = subscribingId === tier.id;
            const priceDollars = (tier.priceUsd / 100).toFixed(0);
            const features = tier.features
              ? (typeof tier.features === "string"
                  ? JSON.parse(tier.features)
                  : tier.features)
              : [];

            return (
              <Card
                key={tier.id}
                className={`relative flex flex-col transition-all hover:shadow-lg rounded-[20px] bg-white border-border ${
                  isCurrent ? "ring-2 ring-[#00D4FF] shadow-lg" : ""
                } ${tier.slug === "startup" ? "border-[#00D4FF]/50 shadow-[#00D4FF]/10" : ""}`}
              >
                {tier.slug === "startup" && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <Badge className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] text-white border-0 rounded-lg">
                      Most Popular
                    </Badge>
                  </div>
                )}
                {isCurrent && (
                  <div className="absolute -top-3 right-4">
                    <Badge variant="outline" className="bg-[#10B981]/10 text-[#10B981] border-[#10B981]/20 rounded-lg">
                      Current
                    </Badge>
                  </div>
                )}

                <CardContent className="p-6 flex flex-col flex-1">
                  {/* Icon & Name */}
                  <div
                    className={`w-12 h-12 rounded-xl bg-gradient-to-br ${tierColors[tier.slug]} flex items-center justify-center mb-4`}
                  >
                    <Icon className="w-6 h-6 text-white" />
                  </div>

                  <h3 className="text-xl font-bold text-[#0F172A]">{tier.name}</h3>
                  <p className="text-sm text-muted-foreground mt-1 mb-4">
                    {tier.description}
                  </p>

                  {/* Price */}
                  <div className="mb-4">
                    <span className="text-3xl font-bold text-[#0F172A]">${priceDollars}</span>
                    <span className="text-muted-foreground">/month</span>
                  </div>

                  {/* CTA */}
                  <Button
                    className={`w-full mb-6 rounded-xl ${
                      isCurrent
                        ? "bg-muted text-muted-foreground hover:bg-muted cursor-default"
                        : tier.slug === "startup"
                        ? "bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] hover:opacity-90 text-white"
                        : ""
                    }`}
                    variant={isCurrent ? "secondary" : tier.slug === "startup" ? "default" : "outline"}
                    disabled={isCurrent || isSubscribing}
                    onClick={() => handleSubscribe(tier.id)}
                  >
                    {isSubscribing ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : isCurrent ? (
                      "Current Plan"
                    ) : tier.priceUsd === 0 ? (
                      "Get Started"
                    ) : (
                      <>
                        Subscribe <ArrowRight className="w-4 h-4 ml-1" />
                      </>
                    )}
                  </Button>

                  {/* Features */}
                  <div className="space-y-3 flex-1">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      Includes
                    </p>
                    {Array.isArray(features) &&
                      features.map((feature: string, i: number) => (
                        <div key={i} className="flex items-start gap-2">
                          <Check
                            className={`w-4 h-4 mt-0.5 shrink-0 ${
                              tier.slug === "free"
                                ? "text-gray-400"
                                : "text-[#10B981]"
                            }`}
                          />
                          <span className="text-sm">{feature}</span>
                        </div>
                      ))}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* FAQ / Info */}
        <div className="mt-16 grid grid-cols-1 md:grid-cols-3 gap-8">
          <div className="text-center">
            <div className="w-10 h-10 rounded-full bg-[#00D4FF]/10 flex items-center justify-center mx-auto mb-3">
              <Zap className="w-5 h-5 text-[#00D4FF]" />
            </div>
            <h3 className="font-semibold mb-1 text-[#0F172A]">Instant Activation</h3>
            <p className="text-sm text-muted-foreground">
              Your subscription activates immediately after payment confirmation.
            </p>
          </div>
          <div className="text-center">
            <div className="w-10 h-10 rounded-full bg-[#10B981]/10 flex items-center justify-center mx-auto mb-3">
              <Check className="w-5 h-5 text-[#10B981]" />
            </div>
            <h3 className="font-semibold mb-1 text-[#0F172A]">Cancel Anytime</h3>
            <p className="text-sm text-muted-foreground">
              No long-term contracts. Cancel your subscription at any time.
            </p>
          </div>
          <div className="text-center">
            <div className="w-10 h-10 rounded-full bg-[#7C3AED]/10 flex items-center justify-center mx-auto mb-3">
              <Crown className="w-5 h-5 text-[#7C3AED]" />
            </div>
            <h3 className="font-semibold mb-1 text-[#0F172A]">Free Tier Forever</h3>
            <p className="text-sm text-muted-foreground">
              Start with our free plan and upgrade when you need more power.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
