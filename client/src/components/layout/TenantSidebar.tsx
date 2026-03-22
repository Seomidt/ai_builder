import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  FolderKanban,
  Cpu,
  PlayCircle,
  Building2,
  LogOut,
  ShieldAlert,
  Menu,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/hooks/use-translations";
import { LocaleSwitcher } from "@/components/i18n/LocaleSwitcher";
import { useAuth } from "@/hooks/use-auth";
import { signOut } from "@/lib/supabase";
import { getAdminAppUrl, getPostLogoutUrl } from "@/lib/runtime/urls";
import { BrandMark } from "@/components/brand/BrandMark";

export function TenantSidebar() {
  const [location] = useLocation();
  const { t } = useTranslations("common");
  const { user } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    setMobileOpen(false);
  }, [location]);

  async function handleLogout() {
    await signOut();
    window.location.href = getPostLogoutUrl();
  }

  const initials       = user?.email ? user.email.slice(0, 2).toUpperCase() : "??";
  const displayEmail   = user?.email ?? "—";
  const isPlatformAdmin = user?.role === "platform_admin";
  const isTenantPath   = location.startsWith("/tenant");

  const navItems = [
    { href: "/",              label: t("nav.dashboard"),                icon: LayoutDashboard },
    { href: "/projects",      label: t("nav.projects"),                 icon: FolderKanban    },
    { href: "/architectures", label: t("nav.architectures"),            icon: Cpu             },
    { href: "/runs",          label: t("nav.runs"),                     icon: PlayCircle      },
    { href: "/tenant",        label: t("nav.workspace") ?? "Workspace", icon: Building2       },
  ];

  function isActive(href: string): boolean {
    if (href === "/") return location === "/" && !isTenantPath;
    if (isTenantPath && ["/" , "/projects", "/architectures", "/runs"].includes(href)) return false;
    return location.startsWith(href);
  }

  return (
    <>
      {/* ── Mobile top bar ──────────────────────────────────────────────── */}
      <div
        className="fixed top-0 left-0 right-0 h-14 z-40 flex items-center px-4 border-b border-white/10 lg:hidden"
        style={{ backgroundColor: "hsl(218 32% 10%)" }}
      >
        <button
          onClick={() => setMobileOpen(true)}
          data-testid="button-mobile-menu-open"
          className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition-colors"
          aria-label="Åbn menu"
        >
          <Menu size={20} />
        </button>
        <div className="flex items-center gap-2 ml-3">
          <BrandMark size={28} />
          <span className="text-sm font-semibold text-white tracking-tight">BlissOps</span>
        </div>
      </div>

      {/* ── Mobile backdrop ──────────────────────────────────────────────── */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-40 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <aside
        className={cn(
          "fixed top-0 left-0 z-50 flex shrink-0 border-r border-white/10 transition-transform duration-300",
          "lg:relative lg:translate-x-0 lg:z-auto",
          mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0",
        )}
        style={{ width: "256px", height: "100dvh" }}
      >
        {/* ICON RAIL */}
        <div
          className="w-14 flex flex-col items-center border-r border-white/5 shrink-0"
          style={{ backgroundColor: "hsl(218 32% 10%)", height: "100%" }}
        >
          {/* Brand icon */}
          <div className="py-4 shrink-0">
            <BrandMark size={32} />
          </div>

          {/* Nav icons — scrollable */}
          <div className="flex-1 w-full flex flex-col gap-2 px-1.5 overflow-y-auto py-1">
            {navItems.map(({ href, icon: Icon }) => {
              const active = isActive(href);
              return (
                <Link
                  key={href}
                  href={href}
                  data-testid={`icon-nav-${href.replace(/\//g, "-").replace(/^-/, "") || "dashboard"}`}
                  className={cn(
                    "h-11 w-full flex items-center justify-center rounded-xl cursor-pointer transition-colors shrink-0",
                    active
                      ? "bg-cyan-500/15 text-cyan-400"
                      : "text-slate-500 hover:text-slate-300 hover:bg-white/5",
                  )}
                >
                  <Icon size={20} strokeWidth={active ? 2.5 : 2} />
                </Link>
              );
            })}

            {isPlatformAdmin && (
              <a
                href={getAdminAppUrl()}
                data-testid="icon-link-switch-to-admin"
                className="h-11 w-full flex items-center justify-center text-slate-500 hover:text-destructive hover:bg-destructive/8 rounded-xl cursor-pointer transition-colors mt-2 shrink-0"
              >
                <ShieldAlert size={20} strokeWidth={2} />
              </a>
            )}
          </div>

          {/* Avatar + logout — always visible */}
          <div className="flex flex-col items-center gap-3 py-4 shrink-0">
            <div
              className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold text-cyan-400"
              style={{ background: "rgba(34,211,238,0.15)", border: "1px solid rgba(34,211,238,0.3)" }}
              title={displayEmail}
            >
              {initials}
            </div>
            <button
              onClick={handleLogout}
              title="Log ud"
              data-testid="button-logout"
              className="h-10 w-full flex items-center justify-center text-slate-500 hover:text-destructive cursor-pointer transition-colors"
            >
              <LogOut size={18} strokeWidth={2} />
            </button>
          </div>
        </div>

        {/* TEXT PANEL */}
        <div
          className="flex-1 flex flex-col min-w-0"
          style={{ backgroundColor: "hsl(218 28% 13%)", height: "100%" }}
        >
          {/* Header — always visible */}
          <div className="flex items-center justify-between px-4 pt-4 pb-2 shrink-0">
            <span className="text-[10px] font-bold tracking-wider text-slate-500 uppercase">
              Workspace
            </span>
            <button
              onClick={() => setMobileOpen(false)}
              data-testid="button-mobile-menu-close"
              className="p-1 rounded-lg text-slate-500 hover:text-white hover:bg-white/5 transition-colors lg:hidden"
              aria-label="Luk menu"
            >
              <X size={16} />
            </button>
          </div>

          {/* Nav — scrollable */}
          <nav className="flex-1 flex flex-col gap-1 px-3 overflow-y-auto py-1">
            {navItems.map(({ href, label }) => {
              const active = isActive(href);
              return (
                <Link
                  key={href}
                  href={href}
                  data-testid={`nav-link-${href.replace(/\//g, "-").replace(/^-/, "") || "dashboard"}`}
                  className={cn(
                    "h-11 flex items-center px-3 text-sm font-medium cursor-pointer transition-colors rounded-lg shrink-0",
                    active
                      ? "text-cyan-400 font-bold"
                      : "text-slate-400 hover:text-slate-200 hover:bg-white/5",
                  )}
                >
                  {label}
                </Link>
              );
            })}

            {isPlatformAdmin && (
              <>
                <div className="pt-4 pb-1 px-3 text-[9px] uppercase tracking-widest font-semibold text-slate-500/60 shrink-0">
                  Platform
                </div>
                <a
                  href={getAdminAppUrl()}
                  data-testid="link-switch-to-admin"
                  className="h-11 flex items-center px-3 text-sm font-medium text-slate-400 hover:text-destructive hover:bg-destructive/8 rounded-lg cursor-pointer transition-colors shrink-0"
                >
                  Platform Ops
                </a>
              </>
            )}
          </nav>

          {/* Footer — always visible at bottom */}
          <div className="px-4 pt-3 pb-4 border-t border-white/5 space-y-2 shrink-0">
            <p
              className="text-xs text-slate-400 truncate"
              data-testid="text-sidebar-email"
            >
              {displayEmail}
            </p>
            <LocaleSwitcher />
          </div>
        </div>
      </aside>
    </>
  );
}
