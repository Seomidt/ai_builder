import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  FolderKanban,
  Cpu,
  PlayCircle,
  Plug,
  Settings,
  ChevronRight,
  Building2,
} from "lucide-react";
import { cn } from "@/lib/utils";

const platformNav = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/projects", label: "Projects", icon: FolderKanban },
  { href: "/architectures", label: "Architectures", icon: Cpu },
  { href: "/runs", label: "Runs", icon: PlayCircle },
  { href: "/integrations", label: "Integrations", icon: Plug },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const [location] = useLocation();
  const isTenant = location.startsWith("/tenant");

  return (
    <aside className="flex flex-col w-56 shrink-0 h-screen bg-sidebar border-r border-sidebar-border">
      {/* Brand */}
      <div className="flex items-center gap-2.5 px-4 py-5 border-b border-sidebar-border">
        <div className="flex items-center justify-center w-7 h-7 rounded-md bg-sidebar-primary">
          <Cpu className="w-4 h-4 text-sidebar-primary-foreground" />
        </div>
        <span className="text-sm font-semibold text-sidebar-foreground tracking-wide">AI Builder</span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {/* Platform section */}
        <p className="px-3 py-1.5 text-xs font-semibold text-sidebar-foreground/40 uppercase tracking-wider">
          Platform
        </p>
        {platformNav.map(({ href, label, icon: Icon }) => {
          const isActive = href === "/" ? location === "/" : location.startsWith(href) && !isTenant;
          return (
            <Link
              key={href}
              href={href}
              data-testid={`nav-link-${label.toLowerCase()}`}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors cursor-pointer",
                isActive
                  ? "bg-sidebar-primary/15 text-sidebar-primary border border-sidebar-primary/25"
                  : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent",
              )}
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span className="flex-1">{label}</span>
              {isActive && <ChevronRight className="w-3 h-3 opacity-60" />}
            </Link>
          );
        })}

        {/* Tenant App section */}
        <div className="pt-3">
          <p className="px-3 py-1.5 text-xs font-semibold text-sidebar-foreground/40 uppercase tracking-wider">
            Tenant App
          </p>
          <Link
            href="/tenant"
            data-testid="nav-link-tenant-app"
            className={cn(
              "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors cursor-pointer",
              isTenant
                ? "bg-sidebar-primary/15 text-sidebar-primary border border-sidebar-primary/25"
                : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent",
            )}
          >
            <Building2 className="w-4 h-4 shrink-0" />
            <span className="flex-1">Tenant Portal</span>
            {isTenant && <ChevronRight className="w-3 h-3 opacity-60" />}
          </Link>
        </div>
      </nav>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-sidebar-border">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-full bg-sidebar-primary/20 flex items-center justify-center">
            <span className="text-xs font-semibold text-sidebar-primary">DO</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-sidebar-foreground truncate">Demo Org</p>
            <p className="text-xs text-sidebar-foreground/40 truncate">demo-org</p>
          </div>
        </div>
      </div>
    </aside>
  );
}
