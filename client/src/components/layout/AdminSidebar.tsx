import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import {
  ShieldAlert,
  Building2,
  BrainCircuit,
  CreditCard,
  Shield,
  DatabaseBackup,
  Rocket,
  UserCheck,
  HardDrive,
  Bot,
  Webhook,
  Clock,
  Plug,
  Settings,
  DollarSign,
  BarChart3,
  Bell,
  Zap,
  Lock,
  LogOut,
  Cpu,
  Menu,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/hooks/use-translations";
import { LocaleSwitcher } from "@/components/i18n/LocaleSwitcher";
import { useAuth } from "@/hooks/use-auth";
import { signOut } from "@/lib/supabase";
import { getTenantAppUrl, getPostLogoutUrl } from "@/lib/runtime/urls";

const opsItems = [
  { href: "/ops",           label: "Ops Console",   icon: ShieldAlert    },
  { href: "/ops/tenants",   label: "Tenants",        icon: Building2      },
  { href: "/ops/ai",        label: "AI Operations",  icon: BrainCircuit   },
  { href: "/ops/billing",   label: "Billing Ops",    icon: CreditCard     },
  { href: "/ops/security",  label: "Security",       icon: Shield         },
  { href: "/ops/recovery",  label: "Recovery",       icon: DatabaseBackup },
  { href: "/ops/release",   label: "Release",        icon: Rocket         },
  { href: "/ops/auth",      label: "Auth",           icon: UserCheck      },
  { href: "/ops/storage",   label: "Storage",        icon: HardDrive      },
  { href: "/ops/assistant", label: "Assistant",      icon: Bot            },
  { href: "/ops/jobs",      label: "Jobs",           icon: Clock          },
  { href: "/ops/webhooks",  label: "Webhooks",       icon: Webhook        },
];

const adminItems = [
  { href: "/integrations", label: "Integrations", icon: Plug     },
  { href: "/settings",     label: "Settings",     icon: Settings },
];

const governanceItems = [
  { href: "/ops/governance/budgets",   label: "Budgets",   icon: DollarSign },
  { href: "/ops/governance/usage",     label: "Usage",     icon: BarChart3  },
  { href: "/ops/governance/alerts",    label: "Alerts",    icon: Bell       },
  { href: "/ops/governance/anomalies", label: "Anomalies", icon: Zap        },
  { href: "/ops/governance/runaway",   label: "Runaway",   icon: Lock       },
];

export function AdminSidebar() {
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

  const initials     = user?.email ? user.email.slice(0, 2).toUpperCase() : "??";
  const displayEmail = user?.email ?? "—";

  function isActive(href: string): boolean {
    if (href === "/ops") return location === "/ops";
    return location.startsWith(href);
  }

  function NavItem({
    href,
    label,
    icon: Icon,
    section,
  }: {
    href: string;
    label: string;
    icon: React.ElementType;
    section?: "ops" | "governance";
  }) {
    const active = isActive(href);
    const isGov  = section === "governance";
    const isOps  = section === "ops";

    return (
      <Link
        href={href}
        data-testid={`admin-nav-${href.replace(/\//g, "-").replace(/^-/, "")}`}
        className={cn(
          "flex items-center gap-3 px-4 py-2 text-sm font-medium transition-colors border-l-2 cursor-pointer",
          active
            ? isGov
              ? "bg-amber-500/10 text-amber-400 border-amber-500"
              : "bg-destructive/10 text-destructive border-destructive"
            : isGov
            ? "text-amber-400/70 hover:text-amber-400 hover:bg-white/5 border-transparent"
            : "text-slate-300 hover:text-white hover:bg-white/5 border-transparent",
        )}
      >
        <Icon
          className={cn(
            "w-4 h-4 shrink-0",
            active
              ? isGov ? "text-amber-400" : "text-destructive"
              : isGov
              ? "text-amber-400/60"
              : "text-slate-400",
          )}
        />
        <span className="flex-1">{label}</span>
      </Link>
    );
  }

  return (
    <>
      {/* ── Mobile top bar (hidden on lg+) ──────────────────────────────── */}
      <div
        className="fixed top-0 left-0 right-0 h-14 z-40 flex items-center px-4 border-b border-white/10 lg:hidden"
        style={{ backgroundColor: "hsl(218 30% 10%)" }}
      >
        <button
          onClick={() => setMobileOpen(true)}
          data-testid="button-admin-mobile-menu-open"
          className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition-colors"
          aria-label="Åbn menu"
        >
          <Menu className="w-5 h-5" />
        </button>
        <div className="flex items-center gap-2 ml-3">
          <div className="bg-destructive rounded-md p-1 flex items-center justify-center shrink-0">
            <ShieldAlert className="w-3.5 h-3.5 text-white" />
          </div>
          <span className="text-sm font-semibold text-white tracking-tight">BlissOps</span>
          <span className="text-destructive font-medium text-xs">Ops</span>
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
          "fixed top-0 left-0 z-50 flex flex-col w-60 shrink-0 border-r border-white/10 overflow-hidden transition-transform duration-300",
          "lg:relative lg:translate-x-0 lg:z-auto",
          mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0",
        )}
        style={{ backgroundColor: "hsl(218 30% 10%)", height: "100dvh" }}
      >

      {/* Brand + mobile close */}
      <div className="px-4 py-4 border-b border-white/5 flex flex-col gap-1 shrink-0">
        <div className="flex items-center gap-2">
          <div className="bg-destructive rounded-md p-1.5 flex items-center justify-center shrink-0">
            <ShieldAlert className="w-4 h-4 text-white" />
          </div>
          <div className="flex items-baseline gap-1 min-w-0 flex-1">
            <span className="font-bold text-white tracking-tight text-sm">BlissOps</span>
            <span className="text-destructive font-medium text-xs">Ops</span>
          </div>
          <button
            onClick={() => setMobileOpen(false)}
            data-testid="button-admin-mobile-menu-close"
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition-colors lg:hidden shrink-0"
            aria-label="Luk menu"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="mt-1">
          <span className="text-[10px] uppercase tracking-wider font-bold bg-destructive/20 text-destructive/80 px-2 py-0.5 rounded-full inline-block">
            Superadmin
          </span>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-2">

        {/* OPS GROUP */}
        <div className="mb-3">
          <div className="bg-destructive/5 border-b border-destructive/10 px-4 py-1.5 mb-1">
            <span className="text-[10px] font-bold text-destructive uppercase tracking-widest">
              {t("nav.platformOps")}
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            {opsItems.map(({ href, label, icon }) => (
              <NavItem key={href} href={href} label={label} icon={icon} section="ops" />
            ))}
          </div>
        </div>

        {/* ADMIN GROUP */}
        <div className="mb-3">
          <div className="px-4 py-1.5 mb-1">
            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
              Admin
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            {adminItems.map(({ href, label, icon }) => (
              <NavItem key={href} href={href} label={label} icon={icon} />
            ))}
          </div>
        </div>

        {/* GOVERNANCE GROUP */}
        <div className="mb-2">
          <div className="bg-amber-500/5 border-b border-amber-500/10 px-4 py-1.5 mb-1">
            <span className="text-[10px] font-bold text-amber-500 uppercase tracking-widest">
              Governance
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            {governanceItems.map(({ href, label, icon }) => (
              <NavItem key={href} href={href} label={label} icon={icon} section="governance" />
            ))}
          </div>
        </div>

      </nav>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-white/5 space-y-2.5 shrink-0" style={{ backgroundColor: "hsl(218 32% 8%)" }}>
        <div className="flex items-center gap-2">
          <div
            className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 text-[10px] font-bold text-destructive"
            style={{ background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.20)" }}
          >
            {initials}
          </div>
          <p
            className="text-xs font-medium text-slate-200 truncate flex-1"
            data-testid="text-admin-sidebar-email"
          >
            {displayEmail}
          </p>
          <button
            onClick={handleLogout}
            title="Log ud"
            data-testid="button-admin-logout"
            className="shrink-0 p-1.5 rounded-md text-slate-400 hover:text-destructive hover:bg-destructive/10 transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
        <a
          href={getTenantAppUrl()}
          className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition-colors"
          data-testid="link-switch-to-tenant"
        >
          <Cpu className="w-3 h-3" />
          Skift til tenant app
        </a>
        <LocaleSwitcher />
      </div>
    </aside>
    </>
  );
}
