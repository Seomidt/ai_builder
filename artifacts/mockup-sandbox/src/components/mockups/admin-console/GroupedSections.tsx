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
  RefreshCw 
} from "lucide-react";

export function GroupedSections() {
  return (
    <div className="flex h-screen w-full bg-[#1e2330] text-slate-300 font-sans overflow-hidden">
      {/* SIDEBAR */}
      <div className="w-60 h-full bg-[#131720] flex flex-col border-r border-white/5 flex-shrink-0">
        {/* Brand header */}
        <div className="px-4 py-4 border-b border-white/5 flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <div className="bg-red-500 rounded-md p-1.5 flex items-center justify-center">
              <ShieldAlert className="w-4 h-4 text-white" />
            </div>
            <div className="flex items-baseline gap-1">
              <span className="font-bold text-white tracking-tight">BlissOps Platform</span>
              <span className="text-red-500 font-medium text-xs tracking-tight">Ops</span>
            </div>
          </div>
          <div className="mt-1">
            <span className="text-[10px] uppercase tracking-wider font-bold bg-red-500/20 text-red-400 px-2 py-0.5 rounded-full inline-block">
              Superadmin
            </span>
          </div>
        </div>

        {/* Navigation Scroll Area */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden py-2 custom-scrollbar">
          {/* OPS GROUP */}
          <div className="mb-4">
            <div className="bg-red-500/5 border-b border-red-500/10 px-4 py-1.5 mb-1">
              <span className="text-[10px] font-bold text-red-500 uppercase tracking-widest">Platform Ops</span>
            </div>
            <nav className="flex flex-col gap-0.5">
              <a href="#" className="flex items-center gap-3 px-4 py-2 bg-red-500/10 text-red-400 border-l-2 border-red-500 hover:bg-red-500/20 transition-colors">
                <ShieldAlert className="w-4 h-4" />
                <span className="text-sm font-medium">Ops Console</span>
              </a>
              <NavItem icon={Building2} label="Tenants" />
              <NavItem icon={BrainCircuit} label="AI Operations" />
              <NavItem icon={CreditCard} label="Billing Ops" />
              <NavItem icon={Shield} label="Security" />
              <NavItem icon={DatabaseBackup} label="Recovery" />
              <NavItem icon={Rocket} label="Release" />
              <NavItem icon={UserCheck} label="Auth" />
              <NavItem icon={HardDrive} label="Storage" />
              <NavItem icon={Bot} label="Assistant" />
              <NavItem icon={Clock} label="Jobs" />
              <NavItem icon={Webhook} label="Webhooks" />
            </nav>
          </div>

          {/* ADMIN GROUP */}
          <div className="mb-4">
            <div className="px-4 py-1.5 mb-1">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Admin</span>
            </div>
            <nav className="flex flex-col gap-0.5">
              <NavItem icon={Plug} label="Integrations" />
              <NavItem icon={Settings} label="Settings" />
            </nav>
          </div>

          {/* GOVERNANCE GROUP */}
          <div className="mb-2">
            <div className="bg-amber-500/5 border-b border-amber-500/10 px-4 py-1.5 mb-1">
              <span className="text-[10px] font-bold text-amber-500 uppercase tracking-widest">Governance</span>
            </div>
            <nav className="flex flex-col gap-0.5">
              <NavItem icon={DollarSign} label="Budgets" colorClass="text-amber-500/80 hover:text-amber-400" iconColorClass="text-amber-500/70" />
              <NavItem icon={BarChart3} label="Usage" colorClass="text-amber-500/80 hover:text-amber-400" iconColorClass="text-amber-500/70" />
              <NavItem icon={Bell} label="Alerts" colorClass="text-amber-500/80 hover:text-amber-400" iconColorClass="text-amber-500/70" />
              <NavItem icon={Zap} label="Anomalies" colorClass="text-amber-500/80 hover:text-amber-400" iconColorClass="text-amber-500/70" />
              <NavItem icon={Lock} label="Runaway" colorClass="text-amber-500/80 hover:text-amber-400" iconColorClass="text-amber-500/70" />
            </nav>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-white/5 bg-[#10141b] mt-auto">
          <div className="flex items-center justify-between w-full">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-red-500/20 text-red-500 border border-red-500/30 flex items-center justify-center font-bold text-xs">
                JD
              </div>
              <div className="flex flex-col">
                <span className="text-xs font-medium text-white truncate w-24">john@blissops.io</span>
                <a href="#" className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors">← App</a>
              </div>
            </div>
            <button className="text-slate-500 hover:text-white transition-colors p-1.5 rounded hover:bg-white/5">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* MAIN CONTENT */}
      <div className="flex-1 flex flex-col h-full overflow-hidden">
        {/* Header */}
        <header className="h-16 px-6 border-b border-white/5 flex flex-shrink-0 items-center justify-between bg-[#1e2330]/80 backdrop-blur-sm sticky top-0 z-10">
          <div className="flex items-center gap-4">
            <h1 className="text-xl font-bold text-white tracking-tight">Ops Console</h1>
            <span className="text-[10px] font-bold bg-red-500/10 text-red-400 px-2 py-1 rounded border border-red-500/20 tracking-wider uppercase">
              Platform Admin
            </span>
            <span className="text-xs font-medium text-slate-400 bg-white/5 px-2 py-1 rounded flex items-center gap-1.5">
              <Clock className="w-3 h-3" />
              13:27
            </span>
          </div>
          <button className="flex items-center gap-2 text-sm text-slate-300 hover:text-white px-3 py-1.5 rounded-md hover:bg-white/5 transition-colors font-medium">
            <RefreshCw className="w-4 h-4 text-slate-400" />
            Refresh
          </button>
        </header>

        {/* Content Scroll Area */}
        <main className="flex-1 overflow-y-auto p-6 custom-scrollbar">
          <div className="max-w-6xl mx-auto space-y-6">
            
            {/* KPI ROW */}
            <div className="grid grid-cols-4 gap-4">
              <KpiCard value="47" label="Tenants" valueColor="text-cyan-400" />
              <KpiCard value="1,247" label="Runs/hr" valueColor="text-cyan-400" />
              <KpiCard value="0.8%" label="Fejlrate" valueColor="text-red-400" />
              <KpiCard value="99.9%" label="Uptime" valueColor="text-green-400" />
            </div>

            {/* MIDDLE GRID */}
            <div className="grid grid-cols-2 gap-4">
              {/* System Health */}
              <div className="bg-[#1a1f2b] rounded-xl p-5 border border-white/5 shadow-lg">
                <h2 className="text-base font-semibold text-white mb-4">System Health</h2>
                <div className="space-y-1">
                  <HealthRow name="API Server" status="green" value="12ms" />
                  <HealthRow name="Database" status="green" value="3ms" />
                  <HealthRow name="Auth" status="green" value="8ms" />
                  <HealthRow name="Storage" status="gold" value="45ms" />
                  <HealthRow name="AI Engine" status="cyan" value="Kørende" isText />
                </div>
              </div>

              {/* Aktive Advarsler */}
              <div className="bg-[#1a1f2b] rounded-xl p-5 border border-white/5 shadow-lg">
                <h2 className="text-base font-semibold text-white mb-4 flex items-center gap-2">
                  <Bell className="w-4 h-4 text-slate-400" />
                  Aktive Advarsler
                </h2>
                <div className="space-y-3">
                  <AlertRow 
                    severity="CRITICAL" 
                    title="Uautoriseret adgang forsøgt" 
                    time="2m" 
                  />
                  <AlertRow 
                    severity="WARNING" 
                    title="CPU spike 94% — ops/ai" 
                    time="8m" 
                  />
                  <AlertRow 
                    severity="INFO" 
                    title="Ny tenant onboardet" 
                    time="1t" 
                  />
                </div>
              </div>
            </div>

            {/* BOTTOM "Top Tenants — Forbrug" */}
            <div className="bg-[#1a1f2b] rounded-xl p-5 border border-white/5 shadow-lg">
              <h2 className="text-base font-semibold text-white mb-5">Top Tenants — Forbrug</h2>
              <div className="space-y-4">
                <TenantUsageRow name="BlissOps-main" runs="1,247" percent={100} />
                <TenantUsageRow name="Acme Corp" runs="876" percent={70} />
                <TenantUsageRow name="Stark Industries" runs="642" percent={52} />
                <TenantUsageRow name="Wayne Enterprises" runs="412" percent={33} />
                <TenantUsageRow name="Globex" runs="156" percent={12} />
              </div>
            </div>

          </div>
        </main>
      </div>

      <style dangerouslySetInnerHTML={{__html: `
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
          height: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.1);
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      `}} />
    </div>
  );
}

// Subcomponents

function NavItem({ 
  icon: Icon, 
  label, 
  colorClass = "text-slate-400 hover:text-slate-200 hover:bg-white/5 border-l-2 border-transparent",
  iconColorClass = "text-slate-500 group-hover:text-slate-300"
}: { 
  icon: React.ElementType, 
  label: string,
  colorClass?: string,
  iconColorClass?: string
}) {
  return (
    <a href="#" className={\`flex items-center gap-3 px-4 py-2 transition-colors group \${colorClass}\`}>
      <Icon className={\`w-4 h-4 transition-colors \${iconColorClass}\`} />
      <span className="text-sm font-medium">{label}</span>
    </a>
  );
}

function KpiCard({ value, label, valueColor }: { value: string, label: string, valueColor: string }) {
  return (
    <div className="bg-[#1a1f2b] rounded-xl p-5 border border-white/5 shadow-sm flex flex-col justify-between h-28 hover:bg-[#1d2230] transition-colors">
      <div className="text-sm text-slate-400 font-medium uppercase tracking-wide">{label}</div>
      <div className={\`text-3xl font-bold tracking-tight \${valueColor}\`}>{value}</div>
    </div>
  );
}

function HealthRow({ name, status, value, isText = false }: { name: string, status: 'green' | 'gold' | 'cyan', value: string, isText?: boolean }) {
  const statusColors = {
    green: "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.4)]",
    gold: "bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.4)]",
    cyan: "bg-cyan-500 shadow-[0_0_8px_rgba(6,182,212,0.4)]"
  };
  
  const valueColors = {
    green: "text-slate-300",
    gold: "text-amber-400 font-medium",
    cyan: "text-cyan-400 font-medium"
  };

  return (
    <div className="flex items-center justify-between py-2 border-b border-white/5 last:border-0 hover:bg-white/[0.02] px-2 rounded -mx-2 transition-colors">
      <div className="flex items-center gap-3">
        <div className={\`w-2 h-2 rounded-full \${statusColors[status]}\`}></div>
        <span className="text-sm font-medium text-slate-200">{name}</span>
      </div>
      <span className={\`text-sm \${isText ? valueColors[status] : 'text-slate-400 font-mono'}\`}>
        {value}
      </span>
    </div>
  );
}

function AlertRow({ severity, title, time }: { severity: 'CRITICAL' | 'WARNING' | 'INFO', title: string, time: string }) {
  const styles = {
    CRITICAL: { bg: "bg-red-500/10", text: "text-red-400", border: "border-red-500/20" },
    WARNING: { bg: "bg-amber-500/10", text: "text-amber-400", border: "border-amber-500/20" },
    INFO: { bg: "bg-blue-500/10", text: "text-blue-400", border: "border-blue-500/20" }
  };
  
  const currentStyle = styles[severity];

  return (
    <div className="flex items-start gap-3 p-3 rounded-lg bg-white/[0.02] border border-white/5 hover:bg-white/[0.04] transition-colors">
      <div className={\`text-[10px] font-bold px-1.5 py-0.5 rounded border \${currentStyle.bg} \${currentStyle.text} \${currentStyle.border} mt-0.5\`}>
        {severity}
      </div>
      <div className="flex-1">
        <div className="text-sm text-slate-200 font-medium leading-tight mb-1">{title}</div>
        <div className="text-xs text-slate-500 flex items-center gap-1.5">
          <Clock className="w-3 h-3" />
          {time}
        </div>
      </div>
    </div>
  );
}

function TenantUsageRow({ name, runs, percent }: { name: string, runs: string, percent: number }) {
  return (
    <div className="flex items-center gap-4 group">
      <div className="w-36 text-sm font-medium text-slate-300 truncate group-hover:text-white transition-colors">{name}</div>
      <div className="flex-1 h-3 bg-[#131720] rounded-full overflow-hidden border border-white/5">
        <div 
          className="h-full bg-cyan-500/70 rounded-full relative overflow-hidden" 
          style={{ width: \`\${percent}%\` }}
        >
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent translate-x-[-100%] animate-[shimmer_2s_infinite]"></div>
        </div>
      </div>
      <div className="w-16 text-right text-sm font-mono text-slate-400">{runs}</div>
      
      <style dangerouslySetInnerHTML={{__html: \`
        @keyframes shimmer {
          100% { transform: translateX(100%); }
        }
      \`}} />
    </div>
  );
}
