import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  FolderKanban,
  Cpu,
  PlayCircle,
  Building2,
  LogOut,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/hooks/use-translations";
import { LocaleSwitcher } from "@/components/i18n/LocaleSwitcher";
import { useAuth } from "@/hooks/use-auth";
import { signOut } from "@/lib/supabase";

export function TenantSidebar() {
  const [location] = useLocation();
  const { t } = useTranslations("common");
  const { user } = useAuth();

  async function handleLogout() {
    await signOut();
    window.location.href = "/auth/login";
  }

  const initials    = user?.email ? user.email.slice(0, 2).toUpperCase() : "??";
  const displayEmail = user?.email ?? "—";
  const displayOrg   = user?.organizationId ?? "—";

  const isTenantPath = location.startsWith("/tenant");

  const navItems = [
    { href: "/",              label: t("nav.dashboard"),     icon: LayoutDashboard },
    { href: "/projects",      label: t("nav.projects"),      icon: FolderKanban    },
    { href: "/architectures", label: t("nav.architectures"), icon: Cpu             },
    { href: "/runs",          label: t("nav.runs"),          icon: PlayCircle      },
    { href: "/tenant",        label: t("nav.workspace") ?? "Workspace", icon: Building2 },
  ];

  function isActive(href: string): boolean {
    if (href === "/") return location === "/" && !isTenantPath;
    if (isTenantPath && (href === "/" || href === "/projects" || href === "/architectures" || href === "/runs")) return false;
    return location.startsWith(href);
  }

  function navClass(active: boolean) {
    if (active) return "bg-sidebar-primary/15 text-sidebar-primary border border-sidebar-primary/25";
    return "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent";
  }

  return (
    <aside className="flex flex-col w-56 shrink-0 h-screen bg-sidebar border-r border-sidebar-border">
      {/* Brand */}
      <div className="flex items-center gap-2.5 px-4 py-5 border-b border-sidebar-border">
        <div className="flex items-center justify-center w-7 h-7 rounded-md bg-sidebar-primary">
          <Cpu className="w-4 h-4 text-sidebar-primary-foreground" />
        </div>
        <span className="text-sm font-semibold text-sidebar-foreground tracking-wide">
          {t("brand.name")}
        </span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {navItems.map(({ href, label, icon: Icon }) => {
          const active = isActive(href);
          return (
            <Link
              key={href}
              href={href}
              data-testid={`nav-link-${href.replace(/\//g, "-").replace(/^-/, "") || "dashboard"}`}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors cursor-pointer",
                navClass(active),
              )}
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span className="flex-1">{label}</span>
              {active && <ChevronRight className="w-3 h-3 opacity-60" />}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-sidebar-border space-y-2">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-full bg-sidebar-primary/20 flex items-center justify-center shrink-0">
            <span className="text-xs font-semibold text-sidebar-primary">{initials}</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-sidebar-foreground truncate" data-testid="text-sidebar-email">
              {displayEmail}
            </p>
            <p className="text-xs text-sidebar-foreground/40 truncate" data-testid="text-sidebar-org">
              {displayOrg}
            </p>
          </div>
          <button
            onClick={handleLogout}
            title="Log ud"
            data-testid="button-logout"
            className="shrink-0 p-1 rounded text-sidebar-foreground/40 hover:text-destructive hover:bg-destructive/10 transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
        <LocaleSwitcher />
      </div>
    </aside>
  );
}
