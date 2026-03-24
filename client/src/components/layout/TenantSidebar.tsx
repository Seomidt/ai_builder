import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import {
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

// ── Section label — T5: smaller, lower opacity ──────────────────────────────

function SectionLabel({ label }: { label: string }) {
  return (
    <div className="pt-4 pb-px px-3">
      <span className="text-[9px] uppercase tracking-[0.08em] font-medium text-slate-600/80 select-none">
        {label}
      </span>
    </div>
  );
}

// ── Nav link — border-only active, no row highlight ─────────────────────────

function NavLink({
  href,
  label,
  icon: Icon,
  active,
}: {
  href: string;
  label: string;
  icon: React.ElementType;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      data-testid={`nav-link-${href.replace(/\//g, "-").replace(/^-/, "")}`}
      className={cn(
        "h-[26px] flex items-center gap-2 text-[12.5px] leading-none cursor-pointer transition-colors shrink-0 whitespace-nowrap select-none",
        active
          ? "text-white font-medium"
          : "text-slate-500 font-normal hover:text-slate-300 hover:bg-white/[0.025]",
      )}
      style={{
        paddingLeft: "11px",
        paddingRight: "12px",
        borderLeft: active ? "2px solid rgba(34,211,238,0.85)" : "2px solid transparent",
      }}
    >
      <Icon
        size={16}
        strokeWidth={1.7}
        style={{ opacity: active ? 0.55 : 0.35, flexShrink: 0 }}
      />
      {label}
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

  const role         = user?.role;
  const isAdmin      = isTenantAdmin(role);
  const isPlatAdmin  = isPlatformAdmin(role);
  const initials     = user?.email ? user.email.slice(0, 2).toUpperCase() : "??";
  const displayEmail = user?.email ?? "—";

  const coreActive  = (href: AllHref) => isActive(href, location);
  const adminActive = (href: AllHref) => isActive(href, location);

  return (
    <>
      {/* ── Mobile top bar ──────────────────────────────────────────────── */}
      <div
        className="fixed top-0 left-0 right-0 h-14 z-40 flex items-center px-4 border-b border-white/[0.08] lg:hidden"
        style={{ backgroundColor: "hsl(218 32% 10%)" }}
      >
        <button
          onClick={() => setMobileOpen(true)}
          data-testid="button-mobile-menu-open"
          className="p-2 rounded text-slate-400 hover:text-white hover:bg-white/5 transition-colors"
          aria-label="Åbn menu"
        >
          <Menu size={20} />
        </button>
        <div className="flex items-center gap-2 ml-3">
          <BrandMark size={24} />
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
          "fixed top-0 left-0 z-50 flex flex-col shrink-0 border-r border-white/[0.08] transition-transform duration-300",
          "lg:relative lg:translate-x-0 lg:z-auto",
          mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0",
        )}
        style={{
          width: "220px",
          height: "100dvh",
          backgroundColor: "hsl(218 30% 11%)",
        }}
      >
        {/* T6: header — smaller, lower opacity wordmark */}
        <div className="flex items-center justify-between px-3 pt-3.5 pb-1.5 shrink-0">
          <div className="flex items-center gap-1.5">
            <BrandMark size={20} />
            <span className="text-[10px] font-semibold tracking-[0.08em] text-slate-500/55 uppercase select-none">
              BlissOps
            </span>
          </div>
          <button
            onClick={() => setMobileOpen(false)}
            data-testid="button-mobile-menu-close"
            className="p-1 rounded text-slate-500 hover:text-white hover:bg-white/5 transition-colors lg:hidden"
            aria-label="Luk menu"
          >
            <X size={14} />
          </button>
        </div>

        {/* Nav — T4: tight vertical rhythm */}
        <nav className="flex-1 flex flex-col overflow-y-auto px-0 pb-2">

          <SectionLabel label="Core" />
          {CORE_ITEMS.map(({ href, label, icon }) => (
            <NavLink key={href} href={href} label={label} icon={icon} active={coreActive(href)} />
          ))}

          {isAdmin && (
            <>
              <SectionLabel label="Administration" />
              {ADMIN_ITEMS.map(({ href, label, icon }) => (
                <NavLink key={href} href={href} label={label} icon={icon} active={adminActive(href)} />
              ))}
            </>
          )}

          {isPlatAdmin && (
            <>
              <SectionLabel label="Intern" />
              <a
                href={getAdminAppUrl()}
                data-testid="link-switch-to-admin"
                className="h-[26px] flex items-center gap-2 text-[12.5px] font-normal text-slate-600 hover:text-destructive hover:bg-white/[0.025] cursor-pointer transition-colors shrink-0 select-none"
                style={{ paddingLeft: "11px", paddingRight: "12px", borderLeft: "2px solid transparent" }}
              >
                <ShieldAlert size={16} strokeWidth={1.7} style={{ opacity: 0.35, flexShrink: 0 }} />
                Platform Ops
              </a>
            </>
          )}
        </nav>

        {/* Footer — T4: compact, utilitarian */}
        <div className="flex items-center gap-2 px-3 py-2 border-t border-white/[0.07] shrink-0">
          <div
            className="w-5 h-5 rounded-full flex items-center justify-center text-[8px] font-bold text-slate-400 shrink-0"
            style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.10)" }}
            title={displayEmail}
          >
            {initials}
          </div>
          <p
            className="flex-1 text-[11px] text-slate-600 truncate"
            data-testid="text-sidebar-email"
          >
            {displayEmail}
          </p>
          <button
            onClick={handleLogout}
            title="Log ud"
            data-testid="button-logout"
            className="text-slate-600/70 hover:text-destructive cursor-pointer transition-colors shrink-0"
          >
            <LogOut size={13} strokeWidth={1.8} />
          </button>
        </div>
      </aside>
    </>
  );
}
