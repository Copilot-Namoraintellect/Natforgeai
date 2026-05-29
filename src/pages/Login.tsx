import { useState } from "react";
import { useNavigate, Link } from "react-router";
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
  const [tab, setTab] = useState<"login" | "register">("login");
  const [showPassword, setShowPassword] = useState(false);
  const [firebaseError, setFirebaseError] = useState<string | null>(null);
  const [diagnosticResult, setDiagnosticResult] = useState<any>(null);
  const [runningDiagnostic, setRunningDiagnostic] = useState(false);

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
    onSuccess: (data) => {
      localStorage.setItem("auth_token", data.token);
      toast.success("Welcome back!");
      navigate("/dashboard");
    },
    onError: (err) => {
      toast.error(err.message || "Login failed");
    },
  });

  const registerMutation = trpc.auth.register.useMutation({
    onSuccess: (data) => {
      localStorage.setItem("auth_token", data.token);
      toast.success("Account created! Welcome aboard.");
      navigate("/dashboard");
    },
    onError: (err) => {
      toast.error(err.message || "Registration failed");
    },
  });

  const firebaseAuthMutation = trpc.auth.firebaseAuth.useMutation({
    onSuccess: (data) => {
      localStorage.setItem("auth_token", data.token);
      toast.success("Welcome!");
      setFirebaseError(null);
      navigate("/dashboard");
    },
    onError: (err) => {
      console.error("[Firebase Auth] Backend error:", err);
      const msg = err.message || "Firebase authentication failed";
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
      console.log("[Diagnostic] Backend Firebase status:", json);
      setDiagnosticResult(json.result?.data || json);
    } catch (e: any) {
      console.error("[Diagnostic] Failed:", e);
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
    console.log("[Firebase Auth] Starting Google sign-in popup...");

    try {
      const result = await signInWithPopup(auth, googleProvider);
      console.log("[Firebase Auth] Popup succeeded. User:", result.user.uid, result.user.email);

      const idToken = await result.user.getIdToken();
      console.log("[Firebase Auth] ID token obtained (length:", idToken.length, ")");

      firebaseAuthMutation.mutate({ idToken });
    } catch (err: any) {
      console.error("[Firebase Auth] Client-side error:", err);
      console.error("[Firebase Auth] Error code:", err.code);
      console.error("[Firebase Auth] Error message:", err.message);

      let userMessage = err.message || "Google sign-in failed";

      // Provide clearer messages for common Firebase Auth errors
      if (err.code === "auth/popup-closed-by-user") {
        userMessage = "Sign-in popup was closed. Please try again.";
      } else if (err.code === "auth/popup-blocked") {
        userMessage = "Popup was blocked by your browser. Please allow popups for this site.";
      } else if (err.code === "auth/unauthorized-domain") {
        userMessage = "This domain is not authorized for Firebase Auth. Please add it in your Firebase Console > Authentication > Settings > Authorized domains.";
      } else if (err.code === "auth/operation-not-supported-in-this-environment") {
        userMessage = "Google sign-in is not supported in this environment.";
      } else if (err.code === "auth/cancelled-popup-request") {
        userMessage = "Sign-in was cancelled. Please try again.";
      } else if (err.code === "auth/account-exists-with-different-credential") {
        userMessage = "An account already exists with the same email address but different sign-in credentials.";
      } else if (err.code === "auth/network-request-failed") {
        userMessage = "Network error. Please check your internet connection.";
      }

      setFirebaseError(userMessage);
      toast.error(userMessage);
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

        <Card className="border-0 shadow-xl shadow-[#0F172A]/5 rounded-[20px]">
          <CardContent className="p-6">
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
