import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { Logo } from "@/components/Logo";
import {
  ArrowRight,
  Play,
  Upload,
  Wand2,
  Target,
  Rocket,
  TrendingUp,
  Brain,
  FileText,
  Users,
  MessageSquare,
  ShoppingCart,
  MousePointerClick,
  TrendingUp as TrendIcon,
  DollarSign,
} from "lucide-react";

const howItWorks = [
  { step: "01", title: "Upload Strategy", description: "Upload your marketing strategy or brief.", icon: Upload },
  { step: "02", title: "Generate Campaign", description: "AI builds complete campaigns from your strategy.", icon: Wand2 },
  { step: "03", title: "Find Customers", description: "Identify and target your ideal audience.", icon: Target },
  { step: "04", title: "Launch Everywhere", description: "Deploy across all channels automatically.", icon: Rocket },
  { step: "05", title: "Convert Leads", description: "Turn engagement into revenue.", icon: TrendingUp },
];

const aiAgents = [
  { title: "Strategy Agent", description: "Analyzes markets and crafts winning strategies.", icon: Brain, color: "from-[#00D4FF] to-[#7C3AED]" },
  { title: "Content Agent", description: "Generates copy, creatives, and campaigns.", icon: FileText, color: "from-[#7C3AED] to-[#00D4FF]" },
  { title: "Audience Agent", description: "Finds and segments your ideal customers.", icon: Users, color: "from-[#00D4FF] to-[#10B981]" },
  { title: "Engagement Agent", description: "Automates outreach and nurtures leads.", icon: MessageSquare, color: "from-[#10B981] to-[#00D4FF]" },
  { title: "Sales Agent", description: "Closes deals and optimizes conversions.", icon: ShoppingCart, color: "from-[#7C3AED] to-[#10B981]" },
];

const analytics = [
  { label: "Leads Generated", value: "12,450", change: "+24%", icon: Users },
  { label: "Engagement Rate", value: "68.2%", change: "+12%", icon: MousePointerClick },
  { label: "Conversion Rate", value: "14.8%", change: "+8%", icon: TrendIcon },
  { label: "Revenue Influenced", value: "$2.4M", change: "+32%", icon: DollarSign },
];

export default function Home() {
  const { isAuthenticated } = useAuth();

  return (
    <div className="min-h-screen bg-[#F8FAFC]">
      {/* Navbar */}
      <nav className="border-b border-border/40 bg-white/70 backdrop-blur-xl fixed w-full z-50">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <Logo />
          <div className="flex items-center gap-4">
            {isAuthenticated ? (
              <Button asChild className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] hover:opacity-90 text-white rounded-xl">
                <Link to="/dashboard">Dashboard</Link>
              </Button>
            ) : (
              <Button asChild variant="outline" className="rounded-xl">
                <Link to="/login">Login</Link>
              </Button>
            )}
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="pt-32 pb-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-[1280px] mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-[#00D4FF]/10 text-[#0F172A] text-sm font-medium mb-6 border border-[#00D4FF]/20">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#00D4FF] opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-[#00D4FF]"></span>
            </span>
            Autonomous Marketing. Real Results.
          </div>
          <h1 className="text-5xl sm:text-6xl lg:text-7xl font-bold tracking-tight mb-6 text-[#0F172A]">
            Forge Strategy{" "}
            <span className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] bg-clip-text text-transparent">
              Into Sales
            </span>
          </h1>
          <p className="text-lg sm:text-xl text-muted-foreground max-w-2xl mx-auto mb-10">
            NatForge AI transforms marketing strategies into complete campaigns,
            identifies customers, creates content, engages prospects and drives conversions.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Button
              size="lg"
              asChild
              className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] hover:opacity-90 text-white text-lg px-8 rounded-xl h-14"
            >
              <Link to={isAuthenticated ? "/dashboard" : "/login"}>
                Start Free Trial
                <ArrowRight className="w-5 h-5 ml-2" />
              </Link>
            </Button>
            <Button size="lg" variant="outline" className="text-lg px-8 rounded-xl h-14 border-[#0F172A]/20" asChild>
              <Link to="/login">
                <Play className="w-5 h-5 mr-2" />
                Watch Demo
              </Link>
            </Button>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section className="py-20 px-4 sm:px-6 lg:px-8 bg-white">
        <div className="max-w-[1280px] mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4 text-[#0F172A]">
              How It Works
            </h2>
            <p className="text-muted-foreground max-w-2xl mx-auto">
              From strategy to revenue in five simple steps.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-6">
            {howItWorks.map((item) => (
              <div key={item.step} className="relative group">
                <div className="rounded-[20px] bg-[#F8FAFC] border border-border p-6 h-full hover:shadow-lg transition-all">
                  <div className="text-4xl font-bold text-[#00D4FF]/20 mb-4">{item.step}</div>
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#00D4FF] to-[#7C3AED] flex items-center justify-center mb-4">
                    <item.icon className="w-5 h-5 text-white" />
                  </div>
                  <h3 className="text-lg font-semibold mb-2 text-[#0F172A]">{item.title}</h3>
                  <p className="text-sm text-muted-foreground">{item.description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* AI Agents */}
      <section className="py-20 px-4 sm:px-6 lg:px-8 bg-[#F8FAFC]">
        <div className="max-w-[1280px] mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4 text-[#0F172A]">
              AI Agents
            </h2>
            <p className="text-muted-foreground max-w-2xl mx-auto">
              Specialized AI agents that work together to grow your business.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {aiAgents.map((agent) => (
              <div key={agent.title} className="rounded-[20px] bg-white border border-border p-6 hover:shadow-xl transition-all group">
                <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${agent.color} flex items-center justify-center mb-4 group-hover:scale-110 transition-transform`}>
                  <agent.icon className="w-6 h-6 text-white" />
                </div>
                <h3 className="text-lg font-semibold mb-2 text-[#0F172A]">{agent.title}</h3>
                <p className="text-sm text-muted-foreground">{agent.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Analytics */}
      <section className="py-20 px-4 sm:px-6 lg:px-8 bg-white">
        <div className="max-w-[1280px] mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4 text-[#0F172A]">
              Analytics
            </h2>
            <p className="text-muted-foreground max-w-2xl mx-auto">
              Track what matters and optimize for growth.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {analytics.map((metric) => (
              <div key={metric.label} className="rounded-[20px] bg-[#F8FAFC] border border-border p-6">
                <div className="flex items-center justify-between mb-4">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#00D4FF] to-[#7C3AED] flex items-center justify-center">
                    <metric.icon className="w-5 h-5 text-white" />
                  </div>
                  <span className="text-xs font-semibold text-[#10B981] bg-[#10B981]/10 px-2 py-1 rounded-full">
                    {metric.change}
                  </span>
                </div>
                <div className="text-3xl font-bold text-[#0F172A] mb-1">{metric.value}</div>
                <div className="text-sm text-muted-foreground">{metric.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-20 px-4 sm:px-6 lg:px-8 bg-gradient-to-br from-[#0F172A] to-[#111827]">
        <div className="max-w-[1280px] mx-auto text-center">
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4 text-white">
            Ready to Forge Your Growth?
          </h2>
          <p className="text-gray-400 mb-10 max-w-2xl mx-auto">
            Join businesses using NatForge AI to turn strategy into revenue.
          </p>
          <Button
            size="lg"
            asChild
            className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] hover:opacity-90 text-white text-lg px-8 rounded-xl h-14"
          >
            <Link to={isAuthenticated ? "/dashboard" : "/login"}>
              Start Free Trial
              <ArrowRight className="w-5 h-5 ml-2" />
            </Link>
          </Button>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border py-8 px-4 sm:px-6 lg:px-8 bg-white">
        <div className="max-w-[1440px] mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <Logo size="sm" />
          <p className="text-sm text-muted-foreground">
            Forge Strategy Into Sales.
          </p>
        </div>
      </footer>
    </div>
  );
}
