import React from "react";
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
  Clock,
  Webhook,
  Plug,
  Settings,
  DollarSign,
  BarChart3,
  Bell,
  Zap,
  Lock,
  LogOut,
  AlertTriangle,
  ChevronRight,
} from "lucide-react";

export function CompactDark() {
  return (
    <div
      className="flex h-[800px] w-[1280px] font-sans text-slate-300 overflow-hidden"
      style={{ backgroundColor: "hsl(218 30% 10%)" }}
    >
      {/* SIDEBAR */}
      <div
        className="w-56 h-full flex flex-col flex-shrink-0 border-r border-white/5"
        style={{ backgroundColor: "hsl(218 32% 10%)" }}
      >
        {/* Brand Header */}
        <div className="flex items-center gap-3 px-4 h-14 shrink-0">
          <div className="flex items-center justify-center w-7 h-7 rounded bg-red-500/10 text-red-500">
            <ShieldAlert size={16} />
          </div>
          <div className="flex flex-col leading-tight">
            <div className="flex items-center text-sm">
              <span className="font-bold text-white">Bliss</span>
              <span className="font-bold text-red-500">Ops</span>
            </div>
            <span className="text-[9px] font-bold text-red-500 tracking-wider">
              PLATFORM OPS
            </span>
          </div>
        </div>

        {/* Navigation */}
        <div className="flex-1 overflow-y-auto py-2 no-scrollbar space-y-4">
          {/* OPS Section */}
          <div>
            <div className="px-4 mb-1.5 text-[10px] font-bold text-slate-500 tracking-wider">
              OPS
            </div>
            <nav className="space-y-0.5">
              <NavItem
                icon={<ShieldAlert size={14} />}
                label="Ops Console"
                active
              />
              <NavItem icon={<Building2 size={14} />} label="Tenants" />
              <NavItem icon={<BrainCircuit size={14} />} label="AI Operations" />
              <NavItem icon={<CreditCard size={14} />} label="Billing Ops" />
              <NavItem icon={<Shield size={14} />} label="Security" />
              <NavItem
                icon={<DatabaseBackup size={14} />}
                label="Recovery"
              />
              <NavItem icon={<Rocket size={14} />} label="Release" />
              <NavItem icon={<UserCheck size={14} />} label="Auth" />
              <NavItem icon={<HardDrive size={14} />} label="Storage" />
              <NavItem icon={<Bot size={14} />} label="Assistant" />
              <NavItem icon={<Clock size={14} />} label="Jobs" />
              <NavItem icon={<Webhook size={14} />} label="Webhooks" />
            </nav>
          </div>

          {/* ADMIN Section */}
          <div>
            <div className="px-4 mb-1.5 text-[10px] font-bold text-slate-500 tracking-wider">
              ADMIN
            </div>
            <nav className="space-y-0.5">
              <NavItem icon={<Plug size={14} />} label="Integrations" />
              <NavItem icon={<Settings size={14} />} label="Settings" />
            </nav>
          </div>

          {/* GOVERNANCE Section */}
          <div>
            <div className="px-4 mb-1.5 text-[10px] font-bold text-[#F59E0B] tracking-wider">
              GOVERNANCE
            </div>
            <nav className="space-y-0.5">
              <NavItem
                icon={<DollarSign size={14} />}
                label="Budgets"
                governance
              />
              <NavItem
                icon={<BarChart3 size={14} />}
                label="Usage"
                governance
              />
              <NavItem icon={<Bell size={14} />} label="Alerts" governance />
              <NavItem icon={<Zap size={14} />} label="Anomalies" governance />
              <NavItem icon={<Lock size={14} />} label="Runaway" governance />
            </nav>
          </div>
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-white/5">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-red-500/20 text-red-500 flex items-center justify-center text-xs font-bold shrink-0">
              <img src="/__mockup/images/icon.png" alt="Avatar" className="w-full h-full object-cover rounded-full opacity-80 mix-blend-screen" />
            </div>
            <div className="flex flex-col flex-1 min-w-0">
              <span className="text-xs text-slate-300 truncate">
                admin@blissops.io
              </span>
              <a
                href="#"
                className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
              >
                ← Tenant App
              </a>
            </div>
            <button className="text-slate-500 hover:text-white transition-colors shrink-0">
              <LogOut size={14} />
            </button>
          </div>
        </div>
      </div>

      {/* MAIN CONTENT */}
      <div
        className="flex-1 flex flex-col min-w-0"
        style={{ backgroundColor: "hsl(218 28% 14%)" }}
      >
        {/* Header */}
        <header className="h-14 px-6 flex items-center justify-between border-b border-white/5 shrink-0">
          <div className="flex items-center gap-3">
            <h1 className="text-base font-semibold text-white">
              Platform Ops Console
            </h1>
            <div className="flex items-center gap-2">
              <span className="px-2 py-0.5 rounded-full bg-[#EF4444] text-white text-[10px] font-bold tracking-wider">
                ADMIN
              </span>
              <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-green-500/10 text-green-400 text-[10px] font-bold tracking-wider border border-green-500/20">
                <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>
                LIVE
              </div>
            </div>
          </div>
          <div className="text-xs text-slate-400">
            {new Date().toLocaleDateString("da-DK", {
              weekday: "long",
              year: "numeric",
              month: "short",
              day: "numeric",
            })}
          </div>
        </header>

        {/* Content Area */}
        <div className="flex-1 p-5 overflow-y-auto">
          {/* Alert Banner */}
          <div className="flex items-center justify-between bg-red-500/8 border-l-4 border-red-500 rounded-lg p-3">
            <div className="flex items-center gap-2">
              <AlertTriangle className="text-red-500" size={16} />
              <span className="text-sm font-medium text-red-200">
                3 aktive sikkerhedsadvarsler kræver opmærksomhed
              </span>
            </div>
            <a
              href="#"
              className="text-xs font-semibold text-red-400 hover:text-red-300 flex items-center gap-1"
            >
              Se advarsler <ChevronRight size={14} />
            </a>
          </div>

          {/* Stats Grid */}
          <div className="grid grid-cols-3 gap-3 mt-4">
            <StatCard
              title="Aktive Tenants"
              value="47"
              color="cyan"
              icon={<Building2 size={16} />}
            />
            <StatCard
              title="AI Runs/time"
              value="1.2K"
              color="cyan"
              icon={<BrainCircuit size={16} />}
            />
            <StatCard
              title="Fejlrate"
              value="0.8%"
              color="red"
              icon={<AlertTriangle size={16} />}
            />
            <StatCard
              title="Lager"
              value="78%"
              color="gold"
              icon={<HardDrive size={16} />}
            />
            <StatCard
              title="Auth Events"
              value="234"
              color="slate"
              icon={<UserCheck size={16} />}
            />
            <StatCard
              title="Åbne Jobs"
              value="12"
              color="slate"
              icon={<Clock size={16} />}
            />
          </div>

          {/* Bottom Grid */}
          <div className="grid grid-cols-3 gap-4 mt-4">
            {/* Tenant Table */}
            <div className="col-span-2">
              <h2 className="text-sm font-semibold text-white mb-2">
                Aktive Tenants
              </h2>
              <div
                className="rounded-lg border border-white/5 overflow-hidden"
                style={{ backgroundColor: "hsl(218 25% 18%)" }}
              >
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-white/5 text-slate-400">
                    <tr>
                      <th className="px-4 py-2 font-medium">Navn</th>
                      <th className="px-4 py-2 font-medium">Plan</th>
                      <th className="px-4 py-2 font-medium">Runs</th>
                      <th className="px-4 py-2 font-medium">Status</th>
                      <th className="px-4 py-2 font-medium text-right">
                        Sidst Aktiv
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {[
                      {
                        name: "BlissOps-main",
                        plan: "Enterprise",
                        runs: "1,247",
                        status: "Active",
                        time: "Lige nu",
                      },
                      {
                        name: "Acme Corp",
                        plan: "Pro",
                        runs: "234",
                        status: "Active",
                        time: "2m siden",
                      },
                      {
                        name: "TechFlow Ltd",
                        plan: "Enterprise",
                        runs: "892",
                        status: "Warning",
                        time: "5m siden",
                      },
                      {
                        name: "Beta Testers",
                        plan: "Free",
                        runs: "45",
                        status: "Active",
                        time: "1t siden",
                      },
                      {
                        name: "Global Industries",
                        plan: "Enterprise",
                        runs: "3,402",
                        status: "Active",
                        time: "1t siden",
                      },
                    ].map((row, i) => (
                      <tr
                        key={i}
                        className="hover:bg-white/[0.02] transition-colors"
                      >
                        <td className="px-4 py-2 font-medium text-slate-200">
                          {row.name}
                        </td>
                        <td className="px-4 py-2">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] border ${
                              row.plan === "Enterprise"
                                ? "bg-cyan-500/10 text-[#22D3EE] border-cyan-500/20"
                                : row.plan === "Pro"
                                ? "bg-purple-500/10 text-purple-400 border-purple-500/20"
                                : "bg-slate-500/10 text-slate-400 border-slate-500/20"
                            }`}
                          >
                            {row.plan}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-slate-300">
                          {row.runs}
                        </td>
                        <td className="px-4 py-2">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`w-1.5 h-1.5 rounded-full ${
                                row.status === "Active"
                                  ? "bg-green-500"
                                  : "bg-amber-500"
                              }`}
                            ></span>
                            <span className="text-slate-300">
                              {row.status}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-2 text-right text-slate-400">
                          {row.time}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Events List */}
            <div className="col-span-1">
              <h2 className="text-sm font-semibold text-white mb-2">
                Seneste System Events
              </h2>
              <div
                className="rounded-lg border border-white/5 p-3 space-y-3"
                style={{ backgroundColor: "hsl(218 25% 18%)" }}
              >
                {[
                  {
                    type: "CRITICAL",
                    text: "Database CPU spike i eu-central-1",
                    time: "10m siden",
                  },
                  {
                    type: "WARNING",
                    text: "Høj API latency på Auth service",
                    time: "14m siden",
                  },
                  {
                    type: "INFO",
                    text: "Ny release v2.4.1 deployet",
                    time: "1t siden",
                  },
                  {
                    type: "INFO",
                    text: "Daglig backup fuldført",
                    time: "3t siden",
                  },
                ].map((event, i) => (
                  <div key={i} className="flex flex-col gap-1 pb-3 border-b border-white/5 last:border-0 last:pb-0">
                    <div className="flex items-center justify-between">
                      <span
                        className={`text-[9px] font-bold tracking-wider px-1.5 py-0.5 rounded ${
                          event.type === "CRITICAL"
                            ? "bg-red-500/10 text-red-500"
                            : event.type === "WARNING"
                            ? "bg-amber-500/10 text-amber-500"
                            : "bg-[#22D3EE]/10 text-[#22D3EE]"
                        }`}
                      >
                        {event.type}
                      </span>
                      <span className="text-[10px] text-slate-500">
                        {event.time}
                      </span>
                    </div>
                    <p className="text-xs text-slate-300 leading-tight">{event.text}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function NavItem({
  icon,
  label,
  active,
  governance,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  governance?: boolean;
}) {
  const baseClasses =
    "flex items-center gap-2 px-3 py-1.5 mx-2 rounded-md text-xs transition-colors cursor-pointer relative";
  const activeClasses =
    "bg-red-500/10 text-red-400 border border-red-500/20 before:absolute before:left-0 before:top-1 before:bottom-1 before:w-0.5 before:bg-red-500 before:rounded-r-full";
  const defaultClasses = governance
    ? "text-slate-400 hover:text-[#F59E0B] hover:bg-white/5"
    : "text-slate-400 hover:text-slate-200 hover:bg-white/5";

  return (
    <div className={`${baseClasses} ${active ? activeClasses : defaultClasses}`}>
      <span
        className={
          active ? "text-red-400" : governance ? "text-[#F59E0B]" : ""
        }
      >
        {icon}
      </span>
      <span className="font-medium">{label}</span>
    </div>
  );
}

function StatCard({
  title,
  value,
  color,
  icon,
}: {
  title: string;
  value: string;
  color: "cyan" | "red" | "gold" | "slate";
  icon: React.ReactNode;
}) {
  const colorMap = {
    cyan: "text-[#22D3EE]",
    red: "text-[#EF4444]",
    gold: "text-[#F59E0B]",
    slate: "text-slate-300",
  };

  return (
    <div
      className="rounded-lg p-4 border border-white/5 flex flex-col gap-1.5"
      style={{ backgroundColor: "hsl(218 25% 18%)" }}
    >
      <div className="flex items-center gap-2 text-slate-400">
        <span className="opacity-70">{icon}</span>
        <span className="text-xs font-medium">{title}</span>
      </div>
      <div className={`text-2xl font-semibold ${colorMap[color]}`}>
        {value}
      </div>
    </div>
  );
}
