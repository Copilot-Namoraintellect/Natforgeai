import { trpc } from "@/providers/trpc";

export function useUsage() {
  const { data, isLoading } = trpc.subscription.myUsage.useQuery();

  const tier = data?.tier;
  const usage = data?.usage;

  const campaignsUsed = usage?.campaignsCreated ?? 0;
  const campaignsLimit = tier?.maxCampaigns ?? 2;
  const campaignsRemaining = Math.max(0, campaignsLimit - campaignsUsed);
  const campaignsAtLimit = campaignsUsed >= campaignsLimit;

  const resultsUsed = usage?.successfulResults ?? 0;
  const resultsLimit = tier?.maxResults ?? 5;
  const resultsRemaining = Math.max(0, resultsLimit - resultsUsed);
  const resultsAtLimit = resultsUsed >= resultsLimit;

  return {
    isLoading,
    tier,
    tierName: tier?.name ?? "Free",
    usage,
    campaigns: {
      used: campaignsUsed,
      limit: campaignsLimit,
      remaining: campaignsRemaining,
      atLimit: campaignsAtLimit,
      percent: campaignsLimit > 0 ? Math.min(100, (campaignsUsed / campaignsLimit) * 100) : 0,
    },
    results: {
      used: resultsUsed,
      limit: resultsLimit,
      remaining: resultsRemaining,
      atLimit: resultsAtLimit,
      percent: resultsLimit > 0 ? Math.min(100, (resultsUsed / resultsLimit) * 100) : 0,
    },
  };
}
