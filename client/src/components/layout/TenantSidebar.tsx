import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  FolderKanban,
  Cpu,
  PlayCircle,
  Building2,
  LogOut,
  ShieldAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/hooks/use-translations";
import { LocaleSwitcher } from "@/components/i18n/LocaleSwitcher";
import { useAuth } from "@/hooks/use-auth";
import { signOut } from "@/lib/supabase";
import { getAdminAppUrl, getPostLogoutUrl } from "@/lib/runtime/urls";

function BlissOpsLogo({ size = "md" }: { size?: "sm" | "md" }) {
  const px = size === "sm" ? 22 : 28;
  return (
    <img
      src="/brand/icon.jpeg"
      alt="BlissOps"
      width={px}
      height={px}
      style={{ mixBlendMode: "screen", objectFit: "contain" }}
    />
  );
}

export function TenantSidebar() {
  const [location] = useLocation();
  const { t } = useTranslations("common");
  const { user } = useAuth();

  async function handleLogout() {
    await signOut();
    window.location.href = getPostLogoutUrl();
  }

  const initials     = user?.email ? user.email.slice(0, 2).toUpperCase() : "??";
  const displayEmail = user?.email ?? "—";
  const displayOrg   = user?.organizationId ?? "—";
  const isPlatformAdmin = user?.role === "platform_admin";

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

  return (
    <aside className="flex flex-col w-56 shrink-0 h-screen sidebar-gradient border-r border-sidebar-border">

      {/* Brand */}
      <div className="flex items-center gap-2.5 px-4 py-5 border-b border-sidebar-border">
        <BlissOpsLogo />
        <div className="flex-1 min-w-0">
          <span className="text-sm font-bold text-sidebar-foreground tracking-wide">
            Bliss<span className="text-primary">Ops</span>
          </span>
          <p className="text-[9px] uppercase tracking-widest text-sidebar-foreground/70 font-medium mt-0.5">
            AI Platform
          </p>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 py-4 space-y-0.5 overflow-y-auto">
        <p className="px-3 pb-2 text-[9px] uppercase tracking-widest font-semibold text-sidebar-foreground/60">
          Workspace
        </p>
        {navItems.map(({ href, label, icon: Icon }) => {
          const active = isActive(href);
          return (
            <Link
              key={href}
              href={href}
              data-testid={`nav-link-${href.replace(/\//g, "-").replace(/^-/, "") || "dashboard"}`}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 cursor-pointer relative",
                active
                  ? "bg-primary/12 text-primary border border-primary/20 shadow-sm"
                  : "text-sidebar-foreground/85 hover:text-sidebar-foreground hover:bg-white/8 border border-transparent",
              )}
              style={active ? { boxShadow: "0 0 12px rgba(34,211,238,0.10), inset 0 0 12px rgba(34,211,238,0.04)" } : {}}
            >
              {active && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-primary rounded-full" style={{ boxShadow: "0 0 8px rgba(34,211,238,0.6)" }} />
              )}
              <Icon className={cn("w-4 h-4 shrink-0", active ? "text-primary" : "text-sidebar-foreground/75")} />
              <span className="flex-1">{label}</span>
            </Link>
          );
        })}

        {/* Platform admin cross-surface link */}
        {isPlatformAdmin && (
          <div className="pt-4">
            <p className="px-3 pb-2 text-[9px] uppercase tracking-widest font-semibold text-sidebar-foreground/60">
              Platform
            </p>
            <a
              href={getAdminAppUrl()}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all text-sidebar-foreground/75 hover:text-destructive hover:bg-destructive/8 border border-transparent"
              data-testid="link-switch-to-admin"
            >
              <ShieldAlert className="w-4 h-4 shrink-0" />
              <span className="flex-1">Platform Ops</span>
            </a>
          </div>
        )}
      </nav>

      {/* Footer */}
      <div className="px-3 py-3 border-t border-sidebar-border space-y-2.5 bg-black/10">
        <div className="flex items-center gap-2.5">
          <div
            className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 text-xs font-bold text-primary"
            style={{ background: "rgba(34,211,238,0.15)", border: "1px solid rgba(34,211,238,0.3)" }}
          >
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-sidebar-foreground truncate" data-testid="text-sidebar-email">
              {displayEmail}
            </p>
            <p className="text-[10px] text-sidebar-foreground/70 truncate" data-testid="text-sidebar-org">
              {displayOrg}
            </p>
          </div>
          <button
            onClick={handleLogout}
            title="Log ud"
            data-testid="button-logout"
            className="shrink-0 p-1.5 rounded-md text-sidebar-foreground/60 hover:text-destructive hover:bg-destructive/10 transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
        <LocaleSwitcher />
      </div>
    </aside>
  );
}
