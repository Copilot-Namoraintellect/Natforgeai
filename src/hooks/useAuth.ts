import { trpc } from "@/providers/trpc";
import { useCallback, useMemo } from "react";

export function useAuth() {
  const utils = trpc.useUtils();

  const {
    data: user,
    isLoading,
    error,
    refetch,
  } = trpc.auth.me.useQuery(undefined, {
    staleTime: 1000 * 60 * 5,
    retry: false,
  });

  const logout = useCallback(() => {
    localStorage.removeItem("auth_token");
    utils.invalidate();
    window.location.href = "/login";
  }, [utils]);

  const requiresVerification = !!user?.requiresVerification;
  const isFullyVerified = user?.isFullyVerified ?? false;

  return useMemo(
    () => ({
      user: user ?? null,
      isAuthenticated: !!user,
      isFullyVerified,
      requiresVerification,
      isLoading,
      error,
      logout,
      refresh: refetch,
    }),
    [user, isFullyVerified, requiresVerification, isLoading, error, logout, refetch],
  );
}
