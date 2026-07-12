import { Link, useLocation } from "react-router";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAuth } from "@/hooks/useAuth";
import { Logo } from "@/components/Logo";
import { trpc } from "@/providers/trpc";
import { workflowStateLabels } from "@/lib/workflow";
import {
  Megaphone,
  PenTool,
  CalendarDays,
  Users,
  Brain,
  Zap,
  Building2,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Shield,
  Landmark,
  CreditCard,
  Rocket,
  CheckCircle,
  Activity,
  Plug,
  Settings2,
  Coins,
  CircleDot,
} from "lucide-react";

interface SidebarProps {
  collapsed: boolean;
  onCollapse: (v: boolean) => void;
}

const mainNavItems = [
  { path: "/mission-control", label: "Mission Control", icon: Rocket },
  { path: "/onboarding", label: "Onboarding", icon: Building2 },
  { path: "/campaigns", label: "Campaigns", icon: Megaphone },
  { path: "/approvals", label: "Approval Centre", icon: CheckCircle, badge: "pendingApprovals" },
  { path: "/agent-activity", label: "Agent Activity", icon: Activity },
  { path: "/content", label: "Content Studio", icon: PenTool },
  { path: "/calendar", label: "Calendar", icon: CalendarDays },
  { path: "/leads", label: "Leads", icon: Users },
  { path: "/audience-intelligence", label: "Audience Intelligence", icon: Brain },
  { path: "/analytics", label: "Analytics", icon: BarChart3 },
  { path: "/integrations", label: "Integrations", icon: Plug },
  { path: "/automations", label: "Automations", icon: Zap },
  { path: "/credits", label: "Credits", icon: Coins },
  { path: "/settings", label: "Settings", icon: Settings2 },
];

const adminNavItems = [
  { path: "/admin", label: "Admin Panel", icon: Shield },
  { path: "/admin/system-health", label: "System Health", icon: Activity },
  { path: "/banking", label: "Banking", icon: Landmark },
];

export function Sidebar({ collapsed, onCollapse }: SidebarProps) {
  const location = useLocation();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const { data: pendingApprovals } = trpc.approval.listApprovals.useQuery(
    { status: "pending" },
    { enabled: !!user }
  );

  const { data: wallet } = trpc.billing.myWallet.useQuery(undefined, {
    enabled: !!user,
    refetchInterval: 30000,
  });
  const { data: campaigns } = trpc.campaign.list.useQuery(undefined, {
    enabled: !!user,
    refetchInterval: 10000,
  });

  const approvalCount = pendingApprovals?.length ?? 0;
  const activeCampaign =
    campaigns?.find((c) =>
      !["completed", "campaign_live", "engagement_active", "leads_converting", "optimisation_active"].includes(
        c.workflowState
      )
    ) || campaigns?.[0] || null;

  const workflowStep = activeCampaign?.workflowState
    ? workflowStateLabels[activeCampaign.workflowState]?.step ?? 1
    : user?.onboardingComplete
      ? 2
      : 1;

  const journeySteps = [
    { label: "Onboarding", path: "/onboarding", done: !!user?.onboardingComplete, step: 1 },
    { label: "Campaigns", path: "/campaigns", done: workflowStep >= 2, step: 2 },
    { label: "Approval Centre", path: "/approvals", done: workflowStep >= 3, step: 3 },
    { label: "Agent Activity", path: "/agent-activity", done: workflowStep >= 5, step: 4 },
    { label: "Content Studio", path: "/content", done: workflowStep >= 6, step: 5 },
  ];

  return (
    <div
      className={cn(
        "fixed left-0 top-0 h-full bg-[#0F172A] border-r border-[#1E293B] flex flex-col z-40 transition-all duration-300",
        collapsed ? "w-16" : "w-64"
      )}
    >
      {/* Logo */}
      <div className="flex items-center justify-between h-16 px-4 border-b border-[#1E293B] shrink-0">
        <Logo size="md" dark />
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-gray-400 hover:text-white hover:bg-[#1E293B]"
          onClick={() => onCollapse(!collapsed)}
        >
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </Button>
      </div>

      {/* Main Navigation */}
      <ScrollArea className="flex-1 py-3">
        <nav className="flex flex-col gap-1 px-2">
          {!collapsed && (
            <div className="mb-3 rounded-xl border border-[#334155] bg-[#0B1220] p-3">
              <p className="text-[10px] font-semibold text-[#00D4FF] uppercase tracking-wider">Workflow Progress</p>
              <p className="text-[11px] text-gray-400 mt-1">
                {activeCampaign ? `Campaign #${activeCampaign.id}: ${workflowStateLabels[activeCampaign.workflowState]?.label || activeCampaign.workflowState}` : "Start with onboarding, then launch your first campaign."}
              </p>
              <div className="mt-2 space-y-1.5">
                {journeySteps.map((step) => {
                  const isCurrent = workflowStep === step.step;
                  return (
                    <Link
                      key={step.path}
                      to={step.path}
                      className={cn(
                        "flex items-center gap-2 text-[11px] rounded-md px-2 py-1.5 transition-colors",
                        isCurrent ? "bg-[#1E293B] text-white" : "text-gray-400 hover:bg-[#1E293B] hover:text-gray-200"
                      )}
                    >
                      {step.done ? <CheckCircle className="w-3.5 h-3.5 text-emerald-400" /> : <CircleDot className="w-3.5 h-3.5 text-amber-400" />}
                      <span className="truncate">{step.label}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          )}

          {mainNavItems.map((item) => {
            const isActive = location.pathname === item.path;
            const Icon = item.icon;
            const badgeCount = item.badge === "pendingApprovals" ? approvalCount : 0;
            return (
              <Link
                key={item.path}
                to={item.path}
                className={cn(
                  "flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors",
                  isActive
                    ? "bg-[#00D4FF]/10 text-[#00D4FF]"
                    : "text-gray-400 hover:text-white hover:bg-[#1E293B]"
                )}
              >
                <Icon className={cn("w-5 h-5 shrink-0", isActive && "text-[#00D4FF]")} />
                {!collapsed && <span className="truncate">{item.label}</span>}
                {!collapsed && badgeCount > 0 && (
                  <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded-full bg-red-500 text-white font-semibold">
                    {badgeCount}
                  </span>
                )}
              </Link>
            );
          })}

          {/* Admin Section */}
          {isAdmin && (
            <>
              {!collapsed && (
                <div className="mt-4 mb-2 px-3">
                  <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
                    Administration
                  </p>
                </div>
              )}
              {collapsed && <div className="mt-4 border-t border-[#1E293B] mx-3" />}
              {adminNavItems.map((item) => {
                const isActive = location.pathname === item.path;
                const Icon = item.icon;
                return (
                  <Link
                    key={item.path}
                    to={item.path}
                    className={cn(
                      "flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors",
                      isActive
                        ? "bg-[#00D4FF]/10 text-[#00D4FF]"
                        : "text-gray-400 hover:text-white hover:bg-[#1E293B]"
                    )}
                  >
                    <Icon className={cn("w-5 h-5 shrink-0", isActive && "text-[#00D4FF]")} />
                    {!collapsed && <span className="truncate">{item.label}</span>}
                    {!collapsed && item.path === "/admin" && (
                      <span className="ml-auto text-[9px] px-1.5 py-0.5 rounded bg-[#00D4FF]/10 text-[#00D4FF] font-semibold">
                        ADMIN
                      </span>
                    )}
                  </Link>
                );
              })}
            </>
          )}
        </nav>
      </ScrollArea>

      {/* Bottom */}
      <div className="shrink-0 p-4 border-t border-[#1E293B]">
        {!collapsed && (
          <div className="bg-[#1E293B] rounded-xl p-3 border border-[#334155]">
            <div className="flex items-center gap-2 mb-1">
              <CreditCard className="w-3.5 h-3.5 text-[#00D4FF]" />
              <p className="text-xs font-semibold text-white">
                {isAdmin ? "Admin Account" : "Your Plan"}
              </p>
            </div>
            {/* Credit Balance */}
            {!isAdmin && wallet && (
              <Link to="/credits" className="flex items-center gap-2 mb-1 group">
                <Coins className="w-3 h-3 text-amber-400" />
                <p className="text-xs text-amber-400 font-medium group-hover:underline">
                  {wallet.balance.toLocaleString()} credits
                </p>
              </Link>
            )}
            <p className="text-xs text-gray-400">
              {isAdmin ? "Full system access" : "Manage your subscription"}
            </p>
            <Link
              to={isAdmin ? "/admin" : "/pricing"}
              className="text-xs text-[#00D4FF] hover:underline mt-1.5 inline-block"
            >
              {isAdmin ? "Open Admin Panel" : "View Plans"} &rarr;
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
