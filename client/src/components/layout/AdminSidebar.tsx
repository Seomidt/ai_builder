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

function BlissOpsAdminIcon() {
  return (
    <div
      className="flex items-center justify-center w-7 h-7 rounded-md shrink-0"
      style={{ background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.25)" }}
    >
      <ShieldAlert className="w-4 h-4 text-destructive" />
    </div>
  );
}

function SectionLabel({ label }: { label: string }) {
  return (
    <div className="pt-4 pb-1.5">
      <p className="px-3 text-[9px] font-semibold uppercase tracking-widest text-sidebar-foreground/30">
        {label}
      </p>
    </div>
  );
}

export function AdminSidebar() {
  const [location] = useLocation();
  const { t } = useTranslations("common");
  const { user } = useAuth();

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

  function NavItem({ href, label, icon: Icon, section }: { href: string; label: string; icon: React.ElementType; section?: "governance" }) {
    const active = isActive(href);
    const isGov  = section === "governance";

    return (
      <Link
        href={href}
        data-testid={`admin-nav-${href.replace(/\//g, "-").replace(/^-/, "")}`}
        className={cn(
          "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-150 cursor-pointer relative",
          active
            ? isGov
              ? "bg-yellow-500/10 text-yellow-400 border border-yellow-500/20"
              : "bg-destructive/12 text-destructive border border-destructive/20"
            : "text-sidebar-foreground/55 hover:text-sidebar-foreground hover:bg-white/5 border border-transparent",
        )}
        style={active && !isGov ? { boxShadow: "0 0 12px rgba(239,68,68,0.10), inset 0 0 12px rgba(239,68,68,0.04)" } : {}}
      >
        {active && (
          <span
            className={cn(
              "absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 rounded-full",
              isGov ? "bg-yellow-400" : "bg-destructive",
            )}
            style={{ boxShadow: isGov ? "0 0 8px rgba(234,179,8,0.6)" : "0 0 8px rgba(239,68,68,0.6)" }}
          />
        )}
        <Icon className={cn(
          "w-4 h-4 shrink-0",
          active
            ? isGov ? "text-yellow-400" : "text-destructive"
            : "text-sidebar-foreground/35",
        )} />
        <span className="flex-1">{label}</span>
      </Link>
    );
  }

  return (
    <aside className="flex flex-col w-56 shrink-0 h-screen sidebar-gradient-admin border-r border-sidebar-border/80">

      {/* Brand — admin surface */}
      <div className="flex items-center gap-2.5 px-4 py-5 border-b border-sidebar-border/60">
        <BlissOpsAdminIcon />
        <div className="flex-1 min-w-0">
          <span className="text-sm font-bold text-sidebar-foreground tracking-wide">
            Bliss<span className="text-destructive">Ops</span>
          </span>
          <p className="text-[9px] uppercase tracking-widest text-destructive/60 font-semibold mt-0.5">
            Platform Ops
          </p>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 py-2 space-y-0.5 overflow-y-auto">
        <SectionLabel label={t("nav.platformOps")} />
        {opsItems.map(({ href, label, icon }) => (
          <NavItem key={href} href={href} label={label} icon={icon} />
        ))}

        <SectionLabel label="Admin" />
        {adminItems.map(({ href, label, icon }) => (
          <NavItem key={href} href={href} label={label} icon={icon} />
        ))}

        <SectionLabel label="Governance" />
        {governanceItems.map(({ href, label, icon }) => (
          <NavItem key={href} href={href} label={label} icon={icon} section="governance" />
        ))}
      </nav>

      {/* Footer */}
      <div className="px-3 py-3 border-t border-sidebar-border/60 space-y-2.5 bg-black/15">
        <div className="flex items-center gap-2">
          <div
            className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 text-[10px] font-bold text-destructive"
            style={{ background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.20)" }}
          >
            {initials}
          </div>
          <p className="text-xs font-medium text-sidebar-foreground truncate flex-1" data-testid="text-admin-sidebar-email">
            {displayEmail}
          </p>
          <button
            onClick={handleLogout}
            title="Log ud"
            data-testid="button-admin-logout"
            className="shrink-0 p-1.5 rounded-md text-sidebar-foreground/30 hover:text-destructive hover:bg-destructive/10 transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
        <a
          href={getTenantAppUrl()}
          className="flex items-center gap-1.5 text-xs text-sidebar-foreground/35 hover:text-sidebar-foreground transition-colors"
          data-testid="link-switch-to-tenant"
        >
          <Cpu className="w-3 h-3" />
          Skift til tenant app
        </a>
        <LocaleSwitcher />
      </div>
    </aside>
  );
}
