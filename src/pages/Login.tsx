import { useState } from "react";
import { useNavigate, Link, useSearchParams } from "react-router";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { signInWithPopup } from "firebase/auth";
import { auth, googleProvider } from "@/lib/firebase";
import { getGooglePopupOutcome, shouldShowGoogleErrorBanner } from "@/lib/google-auth";
import { Logo } from "@/components/Logo";
import {
  Mail,
  Lock,
  User,
  Eye,
  EyeOff,
  ArrowRight,
  Chrome,
  Loader2,
  Activity,
} from "lucide-react";

export default function Login() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<"login" | "register">("login");
  const [showPassword, setShowPassword] = useState(false);
  const [firebaseError, setFirebaseError] = useState<string | null>(null);
  const [firebaseInfo, setFirebaseInfo] = useState<string | null>(null);
  const [diagnosticResult, setDiagnosticResult] = useState<any>(null);
  const [runningDiagnostic, setRunningDiagnostic] = useState(false);

  const verificationRequired = searchParams.get("verify") === "required";

  // 2FA challenge state
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [challengeSource, setChallengeSource] = useState<"login" | "firebase" | "register" | null>(null);
  const [challengePurpose, setChallengePurpose] = useState<"email_verification" | "login_2fa" | null>(null);
  const [challengeMessage, setChallengeMessage] = useState<string | null>(null);
  const [otpEmail, setOtpEmail] = useState<string>("");
  const [otpCode, setOtpCode] = useState("");
  const [resendCooldown, setResendCooldown] = useState(0);

  // Login form state
  const [loginForm, setLoginForm] = useState({
    usernameOrEmail: "",
    password: "",
    rememberMe: false,
  });

  // Register form state
  const [registerForm, setRegisterForm] = useState({
    name: "",
    username: "",
    email: "",
    password: "",
    confirmPassword: "",
  });

  const loginMutation = trpc.auth.login.useMutation({
    onSuccess: async (data) => {
      if ("requiresTwoFactor" in data && data.requiresTwoFactor) {
        setChallengeToken(data.challengeToken);
        setChallengeSource("login");
        setChallengePurpose((data.purpose as "email_verification" | "login_2fa") ?? "login_2fa");
        setChallengeMessage(data.message ?? null);
        setOtpEmail(data.user?.email || loginForm.usernameOrEmail);
        if (data.message) toast.info(data.message);
        return;
      }
      if ("token" in data && data.token) {
        localStorage.setItem("auth_token", data.token);
        toast.success("Welcome back!");
        try {
          utils.auth.me.invalidate();
          const user = await utils.auth.me.fetch(undefined);
          if (user && !user.onboardingComplete && user.role !== "admin") {
            navigate("/onboarding");
          } else {
            navigate("/mission-control");
          }
        } catch {
          navigate("/mission-control");
        }
      }
    },
    onError: (err) => {
      toast.error(err.message || "Login failed");
    },
  });

  const resendVerificationCodeMutation = trpc.auth.resendVerificationCode.useMutation({
    onSuccess: async (data) => {
      setChallengeToken(data.challengeToken);
      setChallengePurpose((data.purpose as "email_verification" | "login_2fa") ?? "email_verification");
      setChallengeMessage(data.message ?? null);
      setResendCooldown(60);
      if (data.message) toast.success(data.message);
      const interval = setInterval(() => {
        setResendCooldown((prev) => {
          if (prev <= 1) {
            clearInterval(interval);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    },
    onError: (err) => {
      toast.error(err.message || "Could not resend code");
    },
  });

  const verifyTwoFactorMutation = trpc.auth.verifyTwoFactor.useMutation({
    onSuccess: async (data) => {
      localStorage.setItem("auth_token", data.token);
      toast.success("Welcome back!");
      if (verificationRequired) {
        const next = new URLSearchParams(searchParams);
        next.delete("verify");
        setSearchParams(next, { replace: true });
      }
      try {
        utils.auth.me.invalidate();
        const user = await utils.auth.me.fetch(undefined);
        if (user && !user.onboardingComplete && user.role !== "admin") {
          navigate("/onboarding");
        } else {
          navigate("/mission-control");
        }
      } catch {
        navigate("/mission-control");
      }
    },
    onError: (err) => {
      toast.error(err.message || "Verification failed");
    },
  });

  const registerMutation = trpc.auth.register.useMutation({
    onSuccess: async (data) => {
      if ("requiresTwoFactor" in data && data.requiresTwoFactor) {
        setChallengeToken(data.challengeToken);
        setChallengeSource("register");
        setChallengePurpose((data.purpose as "email_verification" | "login_2fa") ?? "email_verification");
        setChallengeMessage(data.message ?? null);
        setOtpEmail(data.user?.email || registerForm.email);
        if (data.message) toast.info(data.message);
        return;
      }

      // Fallback: switch to login tab and prefill credentials
      setTab("login");
      setLoginForm({
        usernameOrEmail: data.user?.username || registerForm.username,
        password: registerForm.password,
        rememberMe: false,
      });
      toast.success("Account created. Please sign in.");
    },
    onError: (err) => {
      const msg = err.message || "Registration failed";
      if (msg.includes("Username already taken")) {
        toast.error("That username is already taken. Please choose another.");
      } else if (msg.includes("Email already registered")) {
        toast.error("That email is already registered. Try logging in instead.");
      } else {
        toast.error(msg);
      }
    },
  });

  const utils = trpc.useUtils();

  const firebaseAuthMutation = trpc.auth.firebaseAuth.useMutation({
    onSuccess: async (data) => {
      if ("requiresTwoFactor" in data && data.requiresTwoFactor) {
        setChallengeToken(data.challengeToken);
        setChallengeSource("firebase");
        setChallengePurpose((data.purpose as "email_verification" | "login_2fa") ?? "login_2fa");
        setChallengeMessage(data.message ?? null);
        setOtpEmail(data.user?.email || "");
        if (data.message) toast.info(data.message);
        return;
      }

      if (!data?.token) {
        toast.error("Google sign-in succeeded, but no session token was returned. Please try again.");
        return;
      }

      localStorage.setItem("auth_token", data.token);
      toast.success("Welcome!");
      setFirebaseError(null);

      try {
        utils.auth.me.invalidate();
        const user = await utils.auth.me.fetch(undefined);
        if (user && !user.onboardingComplete && user.role !== "admin") {
          navigate("/onboarding");
        } else {
          navigate("/mission-control");
        }
      } catch {
        navigate("/mission-control");
      }
    },
    onError: (err) => {
      const msg = err.message || "Google sign-in failed";
      setFirebaseError(msg);
      toast.error(msg);
    },
  });

  async function runDiagnostic() {
    setRunningDiagnostic(true);
    setDiagnosticResult(null);
    try {
      const res = await fetch("/api/trpc/ping.firebaseStatus");
      const json = await res.json();
      setDiagnosticResult(json.result?.data || json);
    } catch (e: any) {
      setDiagnosticResult({ status: "error", error: e.message });
    }
    setRunningDiagnostic(false);
  }

  function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    if (!loginForm.usernameOrEmail || !loginForm.password) {
      toast.error("Please fill in all fields");
      return;
    }
    loginMutation.mutate({
      usernameOrEmail: loginForm.usernameOrEmail,
      password: loginForm.password,
    });
  }

  function handleVerifyOtp(e: React.FormEvent) {
    e.preventDefault();
    if (!challengeToken || otpCode.length !== 6) {
      toast.error("Please enter the 6-digit code");
      return;
    }
    verifyTwoFactorMutation.mutate({ challengeToken, otpCode });
  }

  function handleResendCode() {
    if (resendCooldown > 0) return;
    if (!challengeToken) {
      toast.info("Please sign in again to receive a new verification code.");
      return;
    }
    resendVerificationCodeMutation.mutate({ challengeToken });
  }

  function handleBackToLogin() {
    setChallengeToken(null);
    setChallengeSource(null);
    setChallengePurpose(null);
    setChallengeMessage(null);
    setOtpEmail("");
    setOtpCode("");
    if (verificationRequired) {
      const next = new URLSearchParams(searchParams);
      next.delete("verify");
      setSearchParams(next, { replace: true });
    }
  }

  function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    if (!registerForm.name || !registerForm.username || !registerForm.email || !registerForm.password) {
      toast.error("Please fill in all fields");
      return;
    }
    if (registerForm.password !== registerForm.confirmPassword) {
      toast.error("Passwords do not match");
      return;
    }
    if (registerForm.password.length < 6) {
      toast.error("Password must be at least 6 characters");
      return;
    }
    registerMutation.mutate({
      username: registerForm.username,
      email: registerForm.email,
      password: registerForm.password,
      name: registerForm.name,
    });
  }

  async function handleFirebaseGoogleAuth() {
    setFirebaseError(null);
    setFirebaseInfo(null);

    try {
      const result = await signInWithPopup(auth, googleProvider);
      const idToken = await result.user.getIdToken();
      await firebaseAuthMutation.mutateAsync({ idToken });
    } catch (err: any) {
      // tRPC/backend errors are handled by the mutation's onError.
      const outcome = getGooglePopupOutcome(err);

      if (outcome.kind === "cancelled") {
        setFirebaseInfo(outcome.message);
        toast.info(outcome.message);
        return;
      }

      if (outcome.kind === "blocked") {
        setFirebaseInfo(outcome.message);
        toast.info(outcome.message);
        return;
      }

      if (shouldShowGoogleErrorBanner(outcome)) {
        setFirebaseError(outcome.message);
      }
      toast.error(outcome.message);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F8FAFC] p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <Logo size="lg" className="justify-center" />
          <p className="text-sm text-muted-foreground mt-2">
            Forge Strategy Into Sales
          </p>
        </div>

        {/* Verification Required Banner */}
        {verificationRequired && !challengeToken && (
          <div className="mb-4 p-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-sm">
            <p className="font-semibold mb-1">Verification Required</p>
            <p>Please sign in again to verify your identity and continue.</p>
          </div>
        )}

        {/* Firebase Error Banner */}
        {firebaseError && (
          <div className="mb-4 p-4 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm">
            <p className="font-semibold mb-1">Google Sign-in Failed</p>
            <p>{firebaseError}</p>
            <div className="mt-3 flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="text-xs"
                onClick={runDiagnostic}
                disabled={runningDiagnostic}
              >
                <Activity className="w-3 h-3 mr-1" />
                {runningDiagnostic ? "Running..." : "Run Diagnostic"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-xs"
                onClick={() => setFirebaseError(null)}
              >
                Dismiss
              </Button>
            </div>
            {diagnosticResult && (
              <div className="mt-3 p-2 rounded bg-white/80 text-xs font-mono overflow-auto">
                <pre>{JSON.stringify(diagnosticResult, null, 2)}</pre>
              </div>
            )}
          </div>
        )}

        {firebaseInfo && (
          <div className="mb-4 p-4 rounded-xl bg-sky-50 border border-sky-200 text-sky-700 text-sm">
            <p className="font-semibold mb-1">Google Sign-in Update</p>
            <p>{firebaseInfo}</p>
            <div className="mt-3 flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="text-xs"
                onClick={() => setFirebaseInfo(null)}
              >
                Dismiss
              </Button>
            </div>
          </div>
        )}

        <Card className="border-0 shadow-xl shadow-[#0F172A]/5 rounded-[20px]">
          <CardContent className="p-6">
            {challengeToken ? (
            <form onSubmit={handleVerifyOtp} className="space-y-4">
              <div className="text-center mb-4">
                <Lock className="w-8 h-8 text-[#00D4FF] mx-auto mb-2" />
                <h3 className="text-lg font-semibold">
                  {challengePurpose === "email_verification" ? "Verify Your Account" : "Verify Your Login"}
                </h3>
                {challengeMessage && (
                  <p className="text-sm text-amber-700 bg-amber-50 rounded-lg px-3 py-2 mt-2">
                    {challengeMessage}
                  </p>
                )}
                <p className="text-sm text-muted-foreground mt-1">
                  A verification code has been sent to:
                </p>
                <p className="text-sm font-medium mt-1">{otpEmail || "your email"}</p>
              </div>

              <div>
                <Label htmlFor="otp-email" className="text-sm font-medium">
                  Email
                </Label>
                <div className="relative mt-1.5">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    id="otp-email"
                    type="email"
                    value={otpEmail}
                    disabled
                    className="pl-9 rounded-xl bg-muted"
                  />
                </div>
              </div>

              <div>
                <Label htmlFor="otp-code" className="text-sm font-medium">
                  Verification Code
                </Label>
                <Input
                  id="otp-code"
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="000000"
                  className="text-center text-lg tracking-[0.3em] rounded-xl mt-1.5"
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ""))}
                  autoFocus
                />
              </div>

              <Button
                type="submit"
                className="w-full bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] hover:opacity-90 text-white rounded-xl"
                disabled={verifyTwoFactorMutation.isPending || otpCode.length !== 6}
              >
                {verifyTwoFactorMutation.isPending ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <ArrowRight className="w-4 h-4 mr-2" />
                )}
                Verify
              </Button>

              <div className="flex items-center justify-between text-sm">
                <button
                  type="button"
                  onClick={handleBackToLogin}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                >
                  {challengeSource === "register" ? "Back to registration" : "Back to login"}
                </button>
                <button
                  type="button"
                  onClick={handleResendCode}
                  disabled={resendCooldown > 0 || loginMutation.isPending || firebaseAuthMutation.isPending}
                  className="text-[#00D4FF] hover:underline disabled:opacity-50 disabled:hover:no-underline"
                >
                  {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : "Resend code"}
                </button>
              </div>
            </form>
          ) : (
            <Tabs value={tab} onValueChange={(v) => setTab(v as "login" | "register")}>
              <TabsList className="grid w-full grid-cols-2 mb-6 rounded-xl">
                <TabsTrigger value="login">Login</TabsTrigger>
                <TabsTrigger value="register">Register</TabsTrigger>
              </TabsList>

              {/* ─── LOGIN TAB ─── */}
              <TabsContent value="login">
                <form onSubmit={handleLogin} className="space-y-4">
                  <div>
                    <Label htmlFor="login-user" className="text-sm font-medium">
                      Username or Email
                    </Label>
                    <div className="relative mt-1.5">
                      <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input
                        id="login-user"
                        placeholder="Enter username or email"
                        className="pl-9 rounded-xl"
                        value={loginForm.usernameOrEmail}
                        onChange={(e) =>
                          setLoginForm({ ...loginForm, usernameOrEmail: e.target.value })
                        }
                      />
                    </div>
                  </div>

                  <div>
                    <Label htmlFor="login-password" className="text-sm font-medium">
                      Password
                    </Label>
                    <div className="relative mt-1.5">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input
                        id="login-password"
                        type={showPassword ? "text" : "password"}
                        placeholder="Enter password"
                        className="pl-9 pr-10 rounded-xl"
                        value={loginForm.password}
                        onChange={(e) =>
                          setLoginForm({ ...loginForm, password: e.target.value })
                        }
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      >
                        {showPassword ? (
                          <EyeOff className="w-4 h-4" />
                        ) : (
                          <Eye className="w-4 h-4" />
                        )}
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="remember"
                        checked={loginForm.rememberMe}
                        onCheckedChange={(checked) =>
                          setLoginForm({ ...loginForm, rememberMe: checked as boolean })
                        }
                      />
                      <Label htmlFor="remember" className="text-xs text-muted-foreground cursor-pointer">
                        Remember me
                      </Label>
                    </div>
                  </div>

                  <Button
                    type="submit"
                    className="w-full bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] hover:opacity-90 text-white rounded-xl"
                    disabled={loginMutation.isPending}
                  >
                    {loginMutation.isPending ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <ArrowRight className="w-4 h-4 mr-2" />
                    )}
                    Sign In
                  </Button>
                </form>

                <div className="relative my-5">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-border" />
                  </div>
                  <div className="relative flex justify-center text-xs">
                    <span className="bg-card px-3 text-muted-foreground">or continue with</span>
                  </div>
                </div>

                <Button
                  variant="outline"
                  className="w-full rounded-xl"
                  onClick={handleFirebaseGoogleAuth}
                  disabled={firebaseAuthMutation.isPending}
                >
                  {firebaseAuthMutation.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Chrome className="w-4 h-4 mr-2 text-red-500" />
                  )}
                  Google Account
                </Button>
                <button
                  type="button"
                  onClick={handleFirebaseGoogleAuth}
                  className="w-full text-center text-xs text-muted-foreground hover:text-[#00D4FF] mt-2"
                >
                  Use another Google account
                </button>
              </TabsContent>

              {/* ─── REGISTER TAB ─── */}
              <TabsContent value="register">
                <form onSubmit={handleRegister} className="space-y-4">
                  <div>
                    <Label htmlFor="reg-name" className="text-sm font-medium">
                      Full Name
                    </Label>
                    <div className="relative mt-1.5">
                      <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input
                        id="reg-name"
                        placeholder="John Smith"
                        className="pl-9 rounded-xl"
                        value={registerForm.name}
                        onChange={(e) =>
                          setRegisterForm({ ...registerForm, name: e.target.value })
                        }
                      />
                    </div>
                  </div>

                  <div>
                    <Label htmlFor="reg-username" className="text-sm font-medium">
                      Username
                    </Label>
                    <div className="relative mt-1.5">
                      <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input
                        id="reg-username"
                        placeholder="johnsmith"
                        className="pl-9 rounded-xl"
                        value={registerForm.username}
                        onChange={(e) =>
                          setRegisterForm({ ...registerForm, username: e.target.value })
                        }
                      />
                    </div>
                  </div>

                  <div>
                    <Label htmlFor="reg-email" className="text-sm font-medium">
                      Email
                    </Label>
                    <div className="relative mt-1.5">
                      <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input
                        id="reg-email"
                        type="email"
                        placeholder="john@example.com"
                        className="pl-9 rounded-xl"
                        value={registerForm.email}
                        onChange={(e) =>
                          setRegisterForm({ ...registerForm, email: e.target.value })
                        }
                      />
                    </div>
                  </div>

                  <div>
                    <Label htmlFor="reg-password" className="text-sm font-medium">
                      Password
                    </Label>
                    <div className="relative mt-1.5">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input
                        id="reg-password"
                        type={showPassword ? "text" : "password"}
                        placeholder="Min 6 characters"
                        className="pl-9 pr-10 rounded-xl"
                        value={registerForm.password}
                        onChange={(e) =>
                          setRegisterForm({ ...registerForm, password: e.target.value })
                        }
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      >
                        {showPassword ? (
                          <EyeOff className="w-4 h-4" />
                        ) : (
                          <Eye className="w-4 h-4" />
                        )}
                      </button>
                    </div>
                  </div>

                  <div>
                    <Label htmlFor="reg-confirm" className="text-sm font-medium">
                      Confirm Password
                    </Label>
                    <div className="relative mt-1.5">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input
                        id="reg-confirm"
                        type="password"
                        placeholder="Confirm password"
                        className="pl-9 rounded-xl"
                        value={registerForm.confirmPassword}
                        onChange={(e) =>
                          setRegisterForm({ ...registerForm, confirmPassword: e.target.value })
                        }
                      />
                    </div>
                  </div>

                  <Button
                    type="submit"
                    className="w-full bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] hover:opacity-90 text-white rounded-xl"
                    disabled={registerMutation.isPending}
                  >
                    {registerMutation.isPending ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <ArrowRight className="w-4 h-4 mr-2" />
                    )}
                    Create Account
                  </Button>
                </form>

                <div className="relative my-5">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-border" />
                  </div>
                  <div className="relative flex justify-center text-xs">
                    <span className="bg-card px-3 text-muted-foreground">or register with</span>
                  </div>
                </div>

                <Button
                  variant="outline"
                  className="w-full rounded-xl"
                  onClick={handleFirebaseGoogleAuth}
                  disabled={firebaseAuthMutation.isPending}
                >
                  {firebaseAuthMutation.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Chrome className="w-4 h-4 mr-2 text-red-500" />
                  )}
                  Google Account
                </Button>
                <button
                  type="button"
                  onClick={handleFirebaseGoogleAuth}
                  className="w-full text-center text-xs text-muted-foreground hover:text-[#00D4FF] mt-2"
                >
                  Use another Google account
                </button>

                <p className="text-xs text-center text-muted-foreground mt-4">
                  Already have an account?{" "}
                  <button
                    onClick={() => setTab("login")}
                    className="text-[#00D4FF] hover:underline font-medium"
                  >
                    Sign in
                  </button>
                </p>
              </TabsContent>
            </Tabs>
          )}
          </CardContent>
        </Card>

        {/* Back to home */}
        <p className="text-center text-sm text-muted-foreground mt-6">
          <Link to="/" className="hover:text-foreground transition-colors">
            Back to home
          </Link>
        </p>
      </div>
    </div>
  );
}
