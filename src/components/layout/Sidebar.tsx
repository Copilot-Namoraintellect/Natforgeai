import { Link, useLocation } from "react-router";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAuth } from "@/hooks/useAuth";
import {
  LayoutDashboard,
  Megaphone,
  PenTool,
  CalendarDays,
  Users,
  Zap,
  FileText,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  Shield,
  Landmark,
  CreditCard,
} from "lucide-react";

interface SidebarProps {
  collapsed: boolean;
  onCollapse: (v: boolean) => void;
}

const mainNavItems = [
  { path: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { path: "/campaigns", label: "Campaigns", icon: Megaphone },
  { path: "/content", label: "Content Studio", icon: PenTool },
  { path: "/calendar", label: "Calendar", icon: CalendarDays },
  { path: "/leads", label: "Leads", icon: Users },
  { path: "/automations", label: "Automations", icon: Zap },
  { path: "/templates", label: "Templates", icon: FileText },
  { path: "/analytics", label: "Analytics", icon: BarChart3 },
];

const adminNavItems = [
  { path: "/admin", label: "Admin Panel", icon: Shield },
  { path: "/banking", label: "Banking", icon: Landmark },
];

export function Sidebar({ collapsed, onCollapse }: SidebarProps) {
  const location = useLocation();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  return (
    <div
      className={cn(
        "fixed left-0 top-0 h-full bg-card border-r border-border flex flex-col z-40 transition-all duration-300",
        collapsed ? "w-16" : "w-64"
      )}
    >
      {/* Logo */}
      <div className="flex items-center justify-between h-16 px-4 border-b border-border shrink-0">
        <Link to="/dashboard" className="flex items-center gap-2 overflow-hidden">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 shrink-0">
            <Sparkles className="w-4 h-4 text-white" />
          </div>
          {!collapsed && (
            <span className="font-bold text-lg truncate bg-gradient-to-r from-indigo-500 to-purple-600 bg-clip-text text-transparent">
              AI Marketer
            </span>
          )}
        </Link>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={() => onCollapse(!collapsed)}
        >
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </Button>
      </div>

      {/* Main Navigation */}
      <ScrollArea className="flex-1 py-3">
        <nav className="flex flex-col gap-1 px-2">
          {mainNavItems.map((item) => {
            const isActive = location.pathname === item.path;
            const Icon = item.icon;
            return (
              <Link
                key={item.path}
                to={item.path}
                className={cn(
                  "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                  isActive
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent"
                )}
              >
                <Icon className={cn("w-5 h-5 shrink-0", isActive && "text-primary")} />
                {!collapsed && <span className="truncate">{item.label}</span>}
              </Link>
            );
          })}

          {/* Admin Section */}
          {isAdmin && (
            <>
              {!collapsed && (
                <div className="mt-4 mb-2 px-3">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                    Administration
                  </p>
                </div>
              )}
              {collapsed && <div className="mt-4 border-t border-border mx-3" />}
              {adminNavItems.map((item) => {
                const isActive = location.pathname === item.path;
                const Icon = item.icon;
                return (
                  <Link
                    key={item.path}
                    to={item.path}
                    className={cn(
                      "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                      isActive
                        ? "bg-indigo-500/10 text-indigo-600"
                        : "text-muted-foreground hover:text-foreground hover:bg-accent"
                    )}
                  >
                    <Icon className={cn("w-5 h-5 shrink-0", isActive && "text-indigo-600")} />
                    {!collapsed && <span className="truncate">{item.label}</span>}
                    {!collapsed && item.path === "/admin" && (
                      <span className="ml-auto text-[9px] px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-600 font-semibold">
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
      <div className="shrink-0 p-4 border-t border-border">
        {!collapsed && (
          <div className="bg-gradient-to-br from-indigo-500/10 to-purple-600/10 rounded-lg p-3 border border-indigo-500/20">
            <div className="flex items-center gap-2 mb-1">
              <CreditCard className="w-3.5 h-3.5 text-indigo-500" />
              <p className="text-xs font-semibold text-foreground">
                {isAdmin ? "Admin Account" : "Your Plan"}
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              {isAdmin ? "Full system access" : "Manage your subscription"}
            </p>
            <Link
              to={isAdmin ? "/admin" : "/pricing"}
              className="text-xs text-indigo-600 hover:underline mt-1.5 inline-block"
            >
              {isAdmin ? "Open Admin Panel" : "View Plans"} &rarr;
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
