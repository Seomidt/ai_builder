import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  FolderKanban,
  Cpu,
  PlayCircle,
  Plug,
  Settings,
  ChevronRight,
  ShieldAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/hooks/use-translations";
import { LocaleSwitcher } from "@/components/i18n/LocaleSwitcher";

export function Sidebar() {
  const [location] = useLocation();
  const { t } = useTranslations("common");
  const isOpsSection = location.startsWith("/ops");

  const navItems = [
    { href: "/",              label: t("nav.dashboard"),     icon: LayoutDashboard },
    { href: "/projects",      label: t("nav.projects"),      icon: FolderKanban },
    { href: "/architectures", label: t("nav.architectures"), icon: Cpu },
    { href: "/runs",          label: t("nav.runs"),          icon: PlayCircle },
    { href: "/integrations",  label: t("nav.integrations"),  icon: Plug },
    { href: "/settings",      label: t("nav.settings"),      icon: Settings },
  ];

  const opsItems = [
    { href: "/ops", label: t("nav.opsConsole"), icon: ShieldAlert },
  ];

  return (
    <aside className="flex flex-col w-56 shrink-0 h-screen bg-sidebar border-r border-sidebar-border">
      {/* Brand */}
      <div className="flex items-center gap-2.5 px-4 py-5 border-b border-sidebar-border">
        <div className="flex items-center justify-center w-7 h-7 rounded-md bg-sidebar-primary">
          <Cpu className="w-4 h-4 text-sidebar-primary-foreground" />
        </div>
        <span className="text-sm font-semibold text-sidebar-foreground tracking-wide">
          {t("brand.name")}
        </span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {navItems.map(({ href, label, icon: Icon }) => {
          const isActive = href === "/" ? location === "/" : location.startsWith(href) && !isOpsSection;
          return (
            <Link
              key={href}
              href={href}
              data-testid={`nav-link-${href.replace("/", "").replace("/", "-") || "dashboard"}`}
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

        {/* Ops Console section */}
        <div className="pt-3 pb-1">
          <p className="px-3 text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/40 mb-0.5">
            {t("nav.platformOps")}
          </p>
        </div>
        {opsItems.map(({ href, label, icon: Icon }) => {
          const isActive = location.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              data-testid={`nav-link-ops`}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors cursor-pointer",
                isActive
                  ? "bg-destructive/15 text-destructive border border-destructive/25"
                  : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent",
              )}
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span className="flex-1">{label}</span>
              {isActive && <ChevronRight className="w-3 h-3 opacity-60" />}
            </Link>
          );
        })}
      </nav>

      {/* Footer: org info + locale switcher */}
      <div className="px-4 py-3 border-t border-sidebar-border space-y-2">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-full bg-sidebar-primary/20 flex items-center justify-center">
            <span className="text-xs font-semibold text-sidebar-primary">DO</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-sidebar-foreground truncate">Demo Org</p>
            <p className="text-xs text-sidebar-foreground/40 truncate">demo-org</p>
          </div>
        </div>
        <LocaleSwitcher />
      </div>
    </aside>
  );
}
