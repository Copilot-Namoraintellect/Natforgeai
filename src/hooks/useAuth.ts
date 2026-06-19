import { trpc } from "@/providers/trpc";
import { useCallback, useMemo } from "react";
import { signOut } from "firebase/auth";
import { auth } from "@/lib/firebase";

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

  const logout = useCallback(async () => {
    localStorage.removeItem("auth_token");
    // Fully clear Firebase session so the next Google login shows the account chooser.
    try {
      await signOut(auth);
    } catch (err: any) {
      console.warn("[useAuth] Firebase signOut failed:", err.message);
    }
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
