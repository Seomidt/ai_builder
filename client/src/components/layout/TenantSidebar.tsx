import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import {
  BookOpen,
  Brain,
  Users2,
  LogOut,
  ShieldAlert,
  Menu,
  X,
  BarChart2,
  Settings,
  MessageSquare,
  Database,
  SlidersHorizontal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { signOut } from "@/lib/supabase";
import { getAdminAppUrl, getPostLogoutUrl } from "@/lib/runtime/urls";
import { BrandMark } from "@/components/brand/BrandMark";

// ── Navigation sections ─────────────────────────────────────────────────────

const CORE_ITEMS = [
  { href: "/ai-chat",      label: "AI Chat",    icon: MessageSquare },
  { href: "/ai-eksperter", label: "Eksperter",  icon: Brain         },
  { href: "/viden-data",   label: "Storage",    icon: Database      },
] as const;

const ADMIN_ITEMS = [
  { href: "/team",          label: "Team",                  icon: Users2            },
  { href: "/workspace/ai",  label: "Ekspertindstillinger",  icon: SlidersHorizontal },
  { href: "/brug",          label: "Usage",                 icon: BarChart2         },
  { href: "/indstillinger", label: "Indstillinger",         icon: Settings          },
] as const;

type AllHref =
  | (typeof CORE_ITEMS)[number]["href"]
  | (typeof ADMIN_ITEMS)[number]["href"];

// ── Role helpers ────────────────────────────────────────────────────────────

function isTenantAdmin(role?: string): boolean {
  return role === "tenant_admin" || role === "platform_admin" || role === "owner";
}

function isPlatformAdmin(role?: string): boolean {
  return role === "platform_admin";
}

// ── Active check ────────────────────────────────────────────────────────────

function isActive(href: AllHref, location: string): boolean {
  if (href === "/ai-chat") return location === "/ai-chat" || location === "/";
  return location === href || location.startsWith(href + "/");
}

// ── Section label ───────────────────────────────────────────────────────────

function SectionLabel({ label }: { label: string }) {
  return (
    <div className="pt-3 pb-0.5 px-3">
      <span className="text-[9px] uppercase tracking-widest font-semibold text-slate-500/60">
        {label}
      </span>
    </div>
  );
}

// ── Nav link (text panel) ───────────────────────────────────────────────────

function NavLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      data-testid={`nav-link-${href.replace(/\//g, "-").replace(/^-/, "")}`}
      className={cn(
        "h-9 flex items-center px-3 text-[13px] font-medium cursor-pointer transition-colors rounded-lg shrink-0 whitespace-nowrap",
        active
          ? "bg-cyan-500/10 text-cyan-300 font-semibold"
          : "text-slate-400 hover:text-slate-200 hover:bg-white/5",
      )}
    >
      {label}
    </Link>
  );
}

// ── Icon link (icon rail) ────────────────────────────────────────────────────

function IconLink({ href, label, icon: Icon, active }: { href: string; label: string; icon: React.ElementType; active: boolean }) {
  return (
    <Link
      href={href}
      data-testid={`icon-nav-${href.replace(/\//g, "-").replace(/^-/, "")}`}
      title={label}
      className={cn(
        "h-10 w-full flex items-center justify-center rounded-xl cursor-pointer transition-colors shrink-0",
        active
          ? "bg-cyan-500/15 text-cyan-400"
          : "text-slate-500 hover:text-slate-300 hover:bg-white/5",
      )}
    >
      <Icon size={19} strokeWidth={active ? 2.5 : 2} />
    </Link>
  );
}

// ── Main sidebar ────────────────────────────────────────────────────────────

export function TenantSidebar() {
  const [location] = useLocation();
  const { user } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => { setMobileOpen(false); }, [location]);

  async function handleLogout() {
    await signOut();
    window.location.href = getPostLogoutUrl();
  }

  const role             = user?.role;
  const isAdmin          = isTenantAdmin(role);
  const isPlatAdmin      = isPlatformAdmin(role);
  const initials         = user?.email ? user.email.slice(0, 2).toUpperCase() : "??";
  const displayEmail     = user?.email ?? "—";

  const coreActive  = (href: AllHref) => isActive(href, location);
  const adminActive = (href: AllHref) => isActive(href, location);

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
        {/* ── ICON RAIL ────────────────────────────────────────────────── */}
        <div
          className="w-14 flex flex-col items-center border-r border-white/5 shrink-0"
          style={{ backgroundColor: "hsl(218 32% 10%)", height: "100%" }}
        >
          <div className="py-4 shrink-0">
            <BrandMark size={32} />
          </div>

          <div className="flex-1 w-full flex flex-col gap-1 px-1.5 overflow-y-auto py-1">
            {/* Core icons */}
            {CORE_ITEMS.map(({ href, label, icon }) => (
              <IconLink key={href} href={href} label={label} icon={icon} active={coreActive(href)} />
            ))}

            {/* Admin icons */}
            {isAdmin && ADMIN_ITEMS.map(({ href, label, icon }) => (
              <IconLink key={href} href={href} label={label} icon={icon} active={adminActive(href)} />
            ))}

            {/* Platform Ops icon — visual divider */}
            {isPlatAdmin && (
              <a
                href={getAdminAppUrl()}
                data-testid="icon-link-switch-to-admin"
                className="h-10 w-full flex items-center justify-center text-slate-500 hover:text-destructive hover:bg-destructive/8 rounded-xl cursor-pointer transition-colors mt-2 shrink-0"
                title="Platform Ops"
              >
                <ShieldAlert size={19} strokeWidth={2} />
              </a>
            )}
          </div>

          {/* Avatar + logout */}
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

        {/* ── TEXT PANEL ───────────────────────────────────────────────── */}
        <div
          className="flex-1 flex flex-col min-w-0"
          style={{ backgroundColor: "hsl(218 28% 13%)", height: "100%" }}
        >
          <div className="flex items-center justify-between px-4 pt-4 pb-2 shrink-0">
            <span className="text-[10px] font-bold tracking-wider text-slate-500 uppercase">
              BlissOps
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

          <nav className="flex-1 flex flex-col overflow-y-auto px-2 pb-2">

            {/* Core */}
            <SectionLabel label="Core" />
            {CORE_ITEMS.map(({ href, label }) => (
              <NavLink key={href} href={href} label={label} active={coreActive(href)} />
            ))}

            {/* Administration — tenant admin only */}
            {isAdmin && (
              <>
                <SectionLabel label="Administration" />
                {ADMIN_ITEMS.map(({ href, label }) => (
                  <NavLink key={href} href={href} label={label} active={adminActive(href)} />
                ))}
              </>
            )}

            {/* Intern — platform owner only */}
            {isPlatAdmin && (
              <>
                <SectionLabel label="Intern" />
                <a
                  href={getAdminAppUrl()}
                  data-testid="link-switch-to-admin"
                  className="h-9 flex items-center px-3 text-[13px] font-medium text-slate-500 hover:text-destructive hover:bg-destructive/8 rounded-lg cursor-pointer transition-colors shrink-0"
                >
                  Platform Ops
                </a>
              </>
            )}
          </nav>

          <div className="px-4 pt-3 pb-4 border-t border-white/5 shrink-0">
            <p className="text-xs text-slate-400 truncate" data-testid="text-sidebar-email">
              {displayEmail}
            </p>
          </div>
        </div>
      </aside>
    </>
  );
}
