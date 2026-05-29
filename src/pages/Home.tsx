import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import {
  Sparkles,
  Megaphone,
  PenTool,
  Calendar,
  Users,
  Zap,
  BarChart3,
  ArrowRight,
  Check,
} from "lucide-react";

const features = [
  {
    icon: Megaphone,
    title: "Campaign Builder",
    description: "Build complete marketing campaigns with AI-powered strategy generation.",
    color: "from-indigo-500 to-blue-600",
  },
  {
    icon: PenTool,
    title: "Content Studio",
    description: "Generate social posts, ad copy, emails, and scripts with AI.",
    color: "from-amber-500 to-orange-600",
  },
  {
    icon: Calendar,
    title: "Content Calendar",
    description: "Schedule and manage your content across all platforms.",
    color: "from-purple-500 to-pink-600",
  },
  {
    icon: Users,
    title: "Lead CRM",
    description: "Track leads through your sales pipeline from first contact to close.",
    color: "from-emerald-500 to-teal-600",
  },
  {
    icon: Zap,
    title: "Automations",
    description: "Build workflows that trigger actions based on events.",
    color: "from-orange-500 to-red-600",
  },
  {
    icon: BarChart3,
    title: "Analytics",
    description: "Track performance metrics and optimize your marketing.",
    color: "from-cyan-500 to-blue-600",
  },
];

const promptLibrary = [
  "Master Campaign Strategy",
  "Social Media Posts",
  "Ad Copy Generator",
  "Canva Design Prompt",
  "Video Script Generator",
  "Meta Ads Targeting",
  "B2B Lead Targeting",
  "CRM Follow-up Sequence",
  "Chatbot Auto-Reply",
  "Daily Power Prompt",
];

export default function Home() {
  const { isAuthenticated } = useAuth();

  return (
    <div className="min-h-screen bg-background">
      {/* Navbar */}
      <nav className="border-b border-border bg-card/50 backdrop-blur-sm fixed w-full z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
              <Sparkles className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-lg bg-gradient-to-r from-indigo-500 to-purple-600 bg-clip-text text-transparent">
              AI Marketer
            </span>
          </div>
          <div className="flex items-center gap-4">
            {isAuthenticated ? (
              <Button asChild className="bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700">
                <Link to="/dashboard">Dashboard</Link>
              </Button>
            ) : (
              <Button asChild variant="outline">
                <Link to="/login">Login</Link>
              </Button>
            )}
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="pt-32 pb-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-5xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-indigo-500/10 text-indigo-600 text-sm font-medium mb-6">
            <Sparkles className="w-4 h-4" />
            Your AI-Powered Marketing Command Center
          </div>
          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight mb-6">
            Turn Strategy Into{" "}
            <span className="bg-gradient-to-r from-indigo-500 to-purple-600 bg-clip-text text-transparent">
              Execution
            </span>
          </h1>
          <p className="text-lg sm:text-xl text-muted-foreground max-w-2xl mx-auto mb-8">
            From campaign strategy to content creation, scheduling, lead management,
            and analytics — run your entire marketing operation from one platform.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            {isAuthenticated ? (
              <Button
                size="lg"
                asChild
                className="bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-lg px-8"
              >
                <Link to="/dashboard">
                  Go to Dashboard
                  <ArrowRight className="w-5 h-5 ml-2" />
                </Link>
              </Button>
            ) : (
              <>
                <Button
                  size="lg"
                  asChild
                  className="bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-lg px-8"
                >
                  <Link to="/login">
                    Get Started Free
                    <ArrowRight className="w-5 h-5 ml-2" />
                  </Link>
                </Button>
                <Button size="lg" variant="outline" className="text-lg px-8" asChild>
                  <Link to="/login">Login</Link>
                </Button>
              </>
            )}
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="py-20 px-4 sm:px-6 lg:px-8 bg-muted/30">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold tracking-tight mb-4">
              Everything You Need to Market Smarter
            </h2>
            <p className="text-muted-foreground max-w-2xl mx-auto">
              A complete toolkit that takes you from strategy to sales — powered by AI,
              organized for action.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {features.map((feature) => (
              <Card
                key={feature.title}
                className="group hover:shadow-lg transition-all border-0 bg-card shadow-sm"
              >
                <CardContent className="p-6">
                  <div
                    className={`w-12 h-12 rounded-lg bg-gradient-to-br ${feature.color} flex items-center justify-center mb-4 group-hover:scale-110 transition-transform`}
                  >
                    <feature.icon className="w-6 h-6 text-white" />
                  </div>
                  <h3 className="text-lg font-semibold mb-2">{feature.title}</h3>
                  <p className="text-sm text-muted-foreground">
                    {feature.description}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Prompt Library */}
      <section className="py-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold tracking-tight mb-4">
              Pre-Built Prompt Library
            </h2>
            <p className="text-muted-foreground max-w-2xl mx-auto">
              13 battle-tested prompts ready to deploy across your marketing stack.
              Copy, customize, and execute.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {promptLibrary.map((prompt, i) => (
              <div
                key={prompt}
                className="flex items-center gap-3 p-4 rounded-lg bg-card border border-border hover:border-primary/50 transition-colors"
              >
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500/10 to-purple-600/10 flex items-center justify-center text-sm font-bold text-indigo-600">
                  {i + 1}
                </div>
                <span className="text-sm font-medium">{prompt}</span>
                <Check className="w-4 h-4 text-emerald-500 ml-auto shrink-0" />
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-20 px-4 sm:px-6 lg:px-8 bg-gradient-to-br from-indigo-500/5 to-purple-600/5">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-3xl font-bold tracking-tight mb-4">
            Ready to Transform Your Marketing?
          </h2>
          <p className="text-muted-foreground mb-8">
            Join marketers who are already using AI Marketer to plan, create,
            and execute campaigns faster than ever.
          </p>
          <Button
            size="lg"
            asChild
            className="bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-lg px-8"
          >
            <Link to={isAuthenticated ? "/dashboard" : "/login"}>
              {isAuthenticated ? "Go to Dashboard" : "Get Started Free"}
              <ArrowRight className="w-5 h-5 ml-2" />
            </Link>
          </Button>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border py-8 px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
              <Sparkles className="w-3 h-3 text-white" />
            </div>
            <span className="text-sm font-semibold bg-gradient-to-r from-indigo-500 to-purple-600 bg-clip-text text-transparent">
              AI Marketer
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            Your AI-powered marketing command center.
          </p>
        </div>
      </footer>
    </div>
  );
}

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl ${className}`}>
      {children}
    </div>
  );
}

function CardContent({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      {children}
    </div>
  );
}
