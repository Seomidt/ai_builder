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
  Lightbulb,
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
  { href: "/storage",      label: "Storage",    icon: Database      },
] as const;

const ADMIN_ITEMS = [
  { href: "/team",          label: "Team",                  icon: Users2            },
  { href: "/insights",      label: "Insights",              icon: Lightbulb         },
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

// ── Section label — T5: slightly tighter top spacing ───────────────────────

function SectionLabel({ label }: { label: string }) {
  return (
    <div className="pt-3 pb-px" style={{ paddingLeft: "11px" }}>
      <span className="text-[9px] uppercase tracking-[0.08em] font-medium select-none"
        style={{ color: "rgba(148,163,184,0.45)" }}>
        {label}
      </span>
    </div>
  );
}

// ── Nav link — border-only active, guaranteed via inline style ───────────────

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
        "h-[30px] flex items-center gap-2.5 text-[12.5px] leading-none cursor-pointer shrink-0 whitespace-nowrap select-none",
        active ? "font-semibold" : "font-normal",
      )}
      style={{
        paddingLeft: "11px",
        paddingRight: "12px",
        borderLeft: active
          ? "2px solid rgba(34,211,238,0.9)"
          : "2px solid transparent",
        color: active ? "#e2e8f0" : "rgba(148,163,184,0.75)",
        background: active ? "none" : "transparent",
        textDecoration: "none",
      }}
      onMouseEnter={(e) => {
        if (!active) (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.03)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = active ? "none" : "transparent";
      }}
    >
      <Icon
        size={14}
        strokeWidth={1.6}
        style={{ opacity: active ? 0.7 : 0.4, flexShrink: 0 }}
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
        {/* T1: header — stronger brand presence, anchored */}
        <div className="flex items-center justify-between px-3 pt-3 pb-2.5 border-b border-white/[0.06] shrink-0">
          <div className="flex items-center gap-2">
            <BrandMark size={24} />
            <span
              className="text-[11px] font-semibold tracking-[0.07em] uppercase select-none"
              style={{ color: "rgba(148,163,184,0.70)" }}
            >
              BlissOps
            </span>
          </div>
          <button
            onClick={() => setMobileOpen(false)}
            data-testid="button-mobile-menu-close"
            className="p-1 rounded transition-colors lg:hidden"
            style={{ color: "rgba(148,163,184,0.45)" }}
            aria-label="Luk menu"
          >
            <X size={14} />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 flex flex-col overflow-y-auto pb-2">

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
                className="h-[30px] flex items-center gap-2.5 text-[12.5px] font-normal cursor-pointer shrink-0 select-none"
                style={{
                  paddingLeft: "11px",
                  paddingRight: "12px",
                  borderLeft: "2px solid transparent",
                  color: "rgba(148,163,184,0.45)",
                  background: "transparent",
                  textDecoration: "none",
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.03)"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
              >
                <ShieldAlert size={14} strokeWidth={1.6} style={{ opacity: 0.35, flexShrink: 0 }} />
                Platform Ops
              </a>
            </>
          )}
        </nav>

        {/* T6: footer — utilitarian, does not compete with nav */}
        <div
          className="flex items-center gap-2 px-3 py-1.5 shrink-0"
          style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}
        >
          <div
            className="w-5 h-5 rounded-full flex items-center justify-center text-[8px] font-bold shrink-0"
            style={{
              background: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.09)",
              color: "rgba(148,163,184,0.70)",
            }}
            title={displayEmail}
          >
            {initials}
          </div>
          <p
            className="flex-1 text-[11px] truncate"
            style={{ color: "rgba(148,163,184,0.40)" }}
            data-testid="text-sidebar-email"
          >
            {displayEmail}
          </p>
          <button
            onClick={handleLogout}
            title="Log ud"
            data-testid="button-logout"
            className="cursor-pointer transition-colors shrink-0 hover:text-red-400"
            style={{ color: "rgba(148,163,184,0.40)" }}
          >
            <LogOut size={13} strokeWidth={1.8} />
          </button>
        </div>
      </aside>
    </>
  );
}
