import { Link, useLocation } from "wouter";
import {
  LayoutDashboard, Building2, Cpu, Webhook,
  BrainCircuit, CreditCard, ShieldAlert, RefreshCcw, Bot, ShieldCheck, KeyRound, Database,
} from "lucide-react";
import { cn } from "@/lib/utils";

export const opsNavItems = [
  { href: "/ops",            label: "Dashboard",      icon: LayoutDashboard },
  { href: "/ops/tenants",    label: "Tenants",        icon: Building2       },
  { href: "/ops/jobs",       label: "Jobs",           icon: Cpu             },
  { href: "/ops/webhooks",   label: "Webhooks",       icon: Webhook         },
  { href: "/ops/ai",         label: "AI Govern",      icon: BrainCircuit    },
  { href: "/ops/billing",    label: "Billing",        icon: CreditCard      },
  { href: "/ops/recovery",   label: "Recovery",       icon: RefreshCcw      },
  { href: "/ops/security",   label: "Security",       icon: ShieldAlert     },
  { href: "/ops/assistant",  label: "AI Assistant",   icon: Bot             },
  { href: "/ops/release",    label: "Release Health", icon: ShieldCheck     },
  { href: "/ops/auth",       label: "Auth Security",  icon: KeyRound        },
  { href: "/ops/storage",    label: "R2 Storage",     icon: Database        },
];

export function OpsNav() {
  const [location] = useLocation();

  return (
    <div className="border-b border-border bg-card">
      <div className="px-6">
        <nav className="flex items-center gap-0.5 overflow-x-auto scrollbar-none" data-testid="ops-nav">
          {opsNavItems.map(({ href, label, icon: Icon }) => {
            const isActive = href === "/ops"
              ? location === "/ops"
              : location.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                data-testid={`ops-nav-${label.toLowerCase().replace(/\s/g, "-")}`}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap",
                  isActive
                    ? "border-destructive text-destructive"
                    : "border-transparent text-muted-foreground hover:text-foreground hover:border-border",
                )}
              >
                <Icon className="w-3.5 h-3.5 shrink-0" />
                {label}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
