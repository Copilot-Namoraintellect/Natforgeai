export type GooglePopupOutcomeKind = "cancelled" | "blocked" | "auth_error" | "non_auth_error";

export interface GooglePopupOutcome {
  kind: GooglePopupOutcomeKind;
  message: string;
}

export function getGooglePopupOutcome(error: unknown): GooglePopupOutcome {
  const err = (error || {}) as { code?: string; message?: string };
  const code = err.code || "";

  if (!code.startsWith("auth/")) {
    return {
      kind: "non_auth_error",
      message: err.message || "Google sign-in failed",
    };
  }

  if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
    return {
      kind: "cancelled",
      message: "Google sign-in was cancelled.",
    };
  }

  if (code === "auth/popup-blocked") {
    return {
      kind: "blocked",
      message: "Google sign-in popup was blocked by your browser. Allow popups for this site and try again.",
    };
  }

  if (code === "auth/unauthorized-domain") {
    return {
      kind: "auth_error",
      message:
        "This domain is not authorized for Firebase Auth. Add it in Firebase Console > Authentication > Settings > Authorized domains.",
    };
  }

  if (code === "auth/operation-not-supported-in-this-environment") {
    return {
      kind: "auth_error",
      message: "Google sign-in is not supported in this environment.",
    };
  }

  if (code === "auth/account-exists-with-different-credential") {
    return {
      kind: "auth_error",
      message: "An account already exists with the same email but different sign-in credentials.",
    };
  }

  if (code === "auth/network-request-failed") {
    return {
      kind: "auth_error",
      message: "Network error. Please check your internet connection.",
    };
  }

  return {
    kind: "auth_error",
    message: err.message || "Google sign-in failed",
  };
}

export function shouldShowGoogleErrorBanner(outcome: GooglePopupOutcome): boolean {
  return outcome.kind === "auth_error" || outcome.kind === "non_auth_error";
}
