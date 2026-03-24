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

// ── Section label — T4: tighter, muted, intentional ────────────────────────

function SectionLabel({ label }: { label: string }) {
  return (
    <div className="pt-2.5 pb-px px-2">
      <span className="text-[9px] uppercase tracking-[0.07em] font-semibold text-slate-500/55 select-none">
        {label}
      </span>
    </div>
  );
}

// ── Nav link — T3/T5: restrained active, tight height, enterprise type ──────

function NavLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      data-testid={`nav-link-${href.replace(/\//g, "-").replace(/^-/, "")}`}
      className={cn(
        "h-8 flex items-center px-2.5 text-[12.5px] leading-none cursor-pointer transition-colors rounded-md shrink-0 whitespace-nowrap",
        active
          ? "bg-cyan-500/[0.09] text-cyan-300 font-semibold tracking-[-0.01em]"
          : "text-slate-400 font-medium hover:text-slate-200 hover:bg-white/[0.04]",
      )}
    >
      {label}
    </Link>
  );
}

// ── Icon link — T2: lighter rail, reduced roundness ──────────────────────────

function IconLink({
  href, label, icon: Icon, active,
}: {
  href: string; label: string; icon: React.ElementType; active: boolean;
}) {
  return (
    <Link
      href={href}
      data-testid={`icon-nav-${href.replace(/\//g, "-").replace(/^-/, "")}`}
      title={label}
      className={cn(
        "h-9 w-full flex items-center justify-center rounded-lg cursor-pointer transition-colors shrink-0",
        active
          ? "bg-cyan-500/10 text-cyan-400"
          : "text-slate-500/70 hover:text-slate-300 hover:bg-white/[0.04]",
      )}
    >
      <Icon size={17} strokeWidth={active ? 2.4 : 1.9} />
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

  const role        = user?.role;
  const isAdmin     = isTenantAdmin(role);
  const isPlatAdmin = isPlatformAdmin(role);
  const initials    = user?.email ? user.email.slice(0, 2).toUpperCase() : "??";
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
          className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition-colors"
          aria-label="Åbn menu"
        >
          <Menu size={20} />
        </button>
        <div className="flex items-center gap-2 ml-3">
          <BrandMark size={26} />
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

      {/* ── Sidebar — T1: tighter width ──────────────────────────────────── */}
      <aside
        className={cn(
          "fixed top-0 left-0 z-50 flex shrink-0 border-r border-white/[0.08] transition-transform duration-300",
          "lg:relative lg:translate-x-0 lg:z-auto",
          mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0",
        )}
        style={{ width: "244px", height: "100dvh" }}
      >
        {/* ── ICON RAIL — T2: narrower, lighter ───────────────────────── */}
        <div
          className="w-12 flex flex-col items-center border-r border-white/[0.06] shrink-0"
          style={{ backgroundColor: "hsl(218 32% 10%)", height: "100%" }}
        >
          <div className="py-3.5 shrink-0">
            <BrandMark size={28} />
          </div>

          <div className="flex-1 w-full flex flex-col gap-0.5 px-1 overflow-y-auto py-0.5">
            {CORE_ITEMS.map(({ href, label, icon }) => (
              <IconLink key={href} href={href} label={label} icon={icon} active={coreActive(href)} />
            ))}

            {isAdmin && ADMIN_ITEMS.map(({ href, label, icon }) => (
              <IconLink key={href} href={href} label={label} icon={icon} active={adminActive(href)} />
            ))}

            {isPlatAdmin && (
              <a
                href={getAdminAppUrl()}
                data-testid="icon-link-switch-to-admin"
                className="h-9 w-full flex items-center justify-center text-slate-500/60 hover:text-destructive hover:bg-destructive/8 rounded-lg cursor-pointer transition-colors mt-1.5 shrink-0"
                title="Platform Ops"
              >
                <ShieldAlert size={16} strokeWidth={1.9} />
              </a>
            )}
          </div>

          {/* T6: tighter avatar/footer area */}
          <div className="flex flex-col items-center gap-2 py-3 shrink-0">
            <div
              className="w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold text-cyan-400"
              style={{ background: "rgba(34,211,238,0.12)", border: "1px solid rgba(34,211,238,0.22)" }}
              title={displayEmail}
            >
              {initials}
            </div>
            <button
              onClick={handleLogout}
              title="Log ud"
              data-testid="button-logout"
              className="h-9 w-full flex items-center justify-center text-slate-500/60 hover:text-destructive cursor-pointer transition-colors"
            >
              <LogOut size={16} strokeWidth={1.9} />
            </button>
          </div>
        </div>

        {/* ── TEXT PANEL — T1/T7: tighter header, sharper surface ──────── */}
        <div
          className="flex-1 flex flex-col min-w-0"
          style={{ backgroundColor: "hsl(218 28% 13%)", height: "100%" }}
        >
          <div className="flex items-center justify-between px-3 pt-3 pb-1.5 shrink-0">
            <span className="text-[9px] font-bold tracking-[0.1em] text-slate-500/70 uppercase select-none">
              BlissOps
            </span>
            <button
              onClick={() => setMobileOpen(false)}
              data-testid="button-mobile-menu-close"
              className="p-1 rounded text-slate-500 hover:text-white hover:bg-white/5 transition-colors lg:hidden"
              aria-label="Luk menu"
            >
              <X size={14} />
            </button>
          </div>

          {/* T1: tighter nav px, no inter-item gap */}
          <nav className="flex-1 flex flex-col overflow-y-auto px-1.5 pb-2">

            <SectionLabel label="Core" />
            {CORE_ITEMS.map(({ href, label }) => (
              <NavLink key={href} href={href} label={label} active={coreActive(href)} />
            ))}

            {isAdmin && (
              <>
                <SectionLabel label="Administration" />
                {ADMIN_ITEMS.map(({ href, label }) => (
                  <NavLink key={href} href={href} label={label} active={adminActive(href)} />
                ))}
              </>
            )}

            {isPlatAdmin && (
              <>
                <SectionLabel label="Intern" />
                <a
                  href={getAdminAppUrl()}
                  data-testid="link-switch-to-admin"
                  className="h-8 flex items-center px-2.5 text-[12.5px] font-medium text-slate-500/70 hover:text-destructive hover:bg-destructive/8 rounded-md cursor-pointer transition-colors shrink-0"
                >
                  Platform Ops
                </a>
              </>
            )}
          </nav>

          {/* T6: reduced footer padding and subdued email */}
          <div className="px-3 pt-2 pb-3 border-t border-white/[0.07] shrink-0">
            <p
              className="text-[11px] text-slate-500/70 truncate"
              data-testid="text-sidebar-email"
            >
              {displayEmail}
            </p>
          </div>
        </div>
      </aside>
    </>
  );
}
