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
  ChevronRight,
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

  async function handleLogout() {
    await signOut();
    window.location.href = getPostLogoutUrl();
  }

  const initials    = user?.email ? user.email.slice(0, 2).toUpperCase() : "??";
  const displayEmail = user?.email ?? "—";

  function isActive(href: string): boolean {
    if (href === "/ops") return location === "/ops";
    return location.startsWith(href);
  }

  function navClass(active: boolean) {
    if (active) return "bg-destructive/15 text-destructive border border-destructive/25";
    return "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent";
  }

  function SectionLabel({ label }: { label: string }) {
    return (
      <div className="pt-3 pb-1">
        <p className="px-3 text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/40">
          {label}
        </p>
      </div>
    );
  }

  return (
    <aside className="flex flex-col w-56 shrink-0 h-screen bg-sidebar border-r border-sidebar-border">
      {/* Brand — admin surface */}
      <div className="flex items-center gap-2.5 px-4 py-5 border-b border-sidebar-border">
        <div className="flex items-center justify-center w-7 h-7 rounded-md bg-destructive/80">
          <ShieldAlert className="w-4 h-4 text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <span className="text-sm font-semibold text-sidebar-foreground tracking-wide">
            {t("brand.name")}
          </span>
          <p className="text-[10px] text-destructive font-medium">Platform Ops</p>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        <SectionLabel label={t("nav.platformOps")} />
        {opsItems.map(({ href, label, icon: Icon }) => {
          const active = isActive(href);
          return (
            <Link
              key={href}
              href={href}
              data-testid={`admin-nav-${href.replace(/\//g, "-").replace(/^-/, "")}`}
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

        <SectionLabel label="Admin" />
        {adminItems.map(({ href, label, icon: Icon }) => {
          const active = isActive(href);
          return (
            <Link
              key={href}
              href={href}
              data-testid={`admin-nav-${href.replace(/\//g, "-").replace(/^-/, "")}`}
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

        <SectionLabel label="Governance" />
        {governanceItems.map(({ href, label, icon: Icon }) => {
          const active = isActive(href);
          return (
            <Link
              key={href}
              href={href}
              data-testid={`admin-nav-gov-${label.toLowerCase()}`}
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
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-destructive/20 flex items-center justify-center shrink-0">
            <span className="text-[10px] font-semibold text-destructive">{initials}</span>
          </div>
          <p className="text-xs font-medium text-sidebar-foreground truncate flex-1" data-testid="text-admin-sidebar-email">
            {displayEmail}
          </p>
          <button
            onClick={handleLogout}
            title="Log ud"
            data-testid="button-admin-logout"
            className="shrink-0 p-1 rounded text-sidebar-foreground/40 hover:text-destructive hover:bg-destructive/10 transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
        {/* Cross-surface link: switch to tenant product app */}
        <a
          href={getTenantAppUrl()}
          className="flex items-center gap-1.5 text-xs text-sidebar-foreground/50 hover:text-sidebar-foreground transition-colors"
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
