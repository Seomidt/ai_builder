import { Link, useLocation } from "wouter";
import {
  LayoutDashboard, Database, BrainCircuit, BarChart2,
  CreditCard, Plug, Users, Settings, ScrollText,
} from "lucide-react";
import { cn } from "@/lib/utils";

export const tenantNavItems = [
  { href: "/workspace",              label: "Oversigt",        icon: LayoutDashboard },
  { href: "/workspace/data",         label: "Data",            icon: Database        },
  { href: "/workspace/ai",           label: "AI Ops",          icon: BrainCircuit    },
  { href: "/workspace/usage",        label: "Forbrug",         icon: BarChart2       },
  { href: "/workspace/billing",      label: "Billing",         icon: CreditCard      },
  { href: "/workspace/integrations", label: "Integrationer",   icon: Plug            },
  { href: "/team",                   label: "Team",            icon: Users           },
  { href: "/workspace/settings",     label: "Indstillinger",   icon: Settings        },
  { href: "/workspace/audit",        label: "Audit",           icon: ScrollText      },
];

export function TenantNav() {
  const [location] = useLocation();

  return (
    <div className="border-b border-border bg-card">
      <div className="px-6">
        <nav className="flex items-center gap-0.5 overflow-x-auto scrollbar-none" data-testid="tenant-nav">
          {tenantNavItems.map(({ href, label, icon: Icon }) => {
            const isActive = href === "/workspace"
              ? location === "/workspace"
              : location.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                data-testid={`tenant-nav-${label.toLowerCase().replace(/\s/g, "-")}`}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap",
                  isActive
                    ? "border-primary text-primary"
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
