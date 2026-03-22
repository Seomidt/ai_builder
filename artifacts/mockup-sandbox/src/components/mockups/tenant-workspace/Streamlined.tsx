import React from "react";
import { 
  LayoutDashboard, 
  FolderKanban, 
  Cpu, 
  PlayCircle, 
  Building2, 
  Zap, 
  LogOut, 
  Plus, 
  ArrowRight, 
  CheckCircle2 
} from "lucide-react";

export function Streamlined() {
  return (
    <div 
      className="flex w-full overflow-hidden text-sm"
      style={{ width: "1280px", height: "800px", fontFamily: "Inter, sans-serif" }}
    >
      {/* SIDEBAR */}
      <div 
        className="w-56 h-full flex flex-col"
        style={{ backgroundColor: "hsl(218 28% 15%)" }}
      >
        {/* Brand header */}
        <div className="flex items-center gap-3 px-6 h-16 shrink-0 mt-2">
          <img src="/__mockup/images/icon.png" alt="BlissOps Icon" className="w-7 h-7 object-contain" />
          <div className="flex flex-col">
            <span className="text-white font-bold text-lg leading-none flex items-center tracking-tight">
              Bliss<span className="text-cyan-400">Ops</span>
            </span>
            <span className="text-[10px] uppercase text-slate-400 font-semibold tracking-wider mt-0.5">
              AI Platform
            </span>
          </div>
        </div>

        {/* Nav Items */}
        <div className="flex-1 px-3 mt-6">
          <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest px-3 mb-3">
            Workspace
          </div>
          
          <div className="space-y-1">
            {/* Active Nav Item */}
            <div className="relative flex items-center gap-3 px-3 py-2 bg-cyan-500/10 text-cyan-400 rounded-md border border-cyan-500/20 cursor-pointer">
              <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-5 bg-cyan-400 rounded-r-md"></div>
              <LayoutDashboard className="w-4 h-4" />
              <span className="font-medium">Dashboard</span>
            </div>

            {/* Inactive Nav Items */}
            {[
              { icon: FolderKanban, label: "Projekter" },
              { icon: Cpu, label: "Arkitekturer" },
              { icon: PlayCircle, label: "Runs" },
              { icon: Building2, label: "Workspace" }
            ].map((item, i) => (
              <div key={i} className="flex items-center gap-3 px-3 py-2 text-slate-400 hover:text-white hover:bg-white/5 rounded-md cursor-pointer transition-colors">
                <item.icon className="w-4 h-4" />
                <span className="font-medium">{item.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-white/5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-cyan-500/20 text-cyan-400 flex items-center justify-center font-bold shrink-0 border border-cyan-500/30">
              SM
            </div>
            <div className="flex flex-col flex-1 min-w-0">
              <span className="text-white font-medium text-sm truncate">blissops-main</span>
              <span className="text-slate-400 text-xs truncate">admin@blissops.com</span>
            </div>
            <button className="text-slate-400 hover:text-white transition-colors">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* MAIN CONTENT */}
      <div 
        className="flex-1 flex flex-col h-full overflow-hidden"
        style={{ backgroundColor: "hsl(218 25% 18%)" }}
      >
        {/* Header Bar */}
        <div className="h-14 px-6 flex items-center justify-between shrink-0 border-b border-white/5">
          <h1 className="text-xl font-bold text-white tracking-tight">Dashboard</h1>
          <div className="text-slate-400 font-medium">22. marts 2026</div>
        </div>

        {/* Content */}
        <div className="p-8 overflow-y-auto">
          {/* Stats Grid */}
          <div className="grid grid-cols-4 gap-4">
            {/* Card 1 */}
            <div 
              className="rounded-xl p-5 flex flex-col relative overflow-hidden"
              style={{ backgroundColor: "hsl(218 22% 22%)", border: "1px solid rgba(255,255,255,0.07)" }}
            >
              <div className="flex items-start justify-between mb-4">
                <div className="text-slate-400 font-medium text-xs uppercase tracking-wider">Aktive Projekter</div>
                <div className="w-8 h-8 rounded-lg bg-cyan-500/10 flex items-center justify-center text-cyan-400">
                  <FolderKanban className="w-4 h-4" />
                </div>
              </div>
              <div className="flex items-end justify-between mt-auto">
                <div className="text-3xl font-bold text-white">12</div>
                <div className="text-emerald-400 text-xs font-medium bg-emerald-400/10 px-2 py-1 rounded-md">+2 denne uge</div>
              </div>
            </div>

            {/* Card 2 */}
            <div 
              className="rounded-xl p-5 flex flex-col relative overflow-hidden"
              style={{ backgroundColor: "hsl(218 22% 22%)", border: "1px solid rgba(255,255,255,0.07)" }}
            >
              <div className="flex items-start justify-between mb-4">
                <div className="text-slate-400 font-medium text-xs uppercase tracking-wider">AI Runs i dag</div>
                <div className="w-8 h-8 rounded-lg bg-cyan-500/10 flex items-center justify-center text-cyan-400">
                  <PlayCircle className="w-4 h-4" />
                </div>
              </div>
              <div className="flex items-end justify-between mt-auto">
                <div className="text-3xl font-bold text-white">247</div>
                <div className="text-emerald-400 text-xs font-medium bg-emerald-400/10 px-2 py-1 rounded-md">98.2% success</div>
              </div>
            </div>

            {/* Card 3 */}
            <div 
              className="rounded-xl p-5 flex flex-col relative overflow-hidden"
              style={{ backgroundColor: "hsl(218 22% 22%)", border: "1px solid rgba(255,255,255,0.07)" }}
            >
              <div className="flex items-start justify-between mb-4">
                <div className="text-slate-400 font-medium text-xs uppercase tracking-wider">Arkitekturer</div>
                <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center text-amber-500">
                  <Cpu className="w-4 h-4" />
                </div>
              </div>
              <div className="flex items-end justify-between mt-auto">
                <div className="text-3xl font-bold text-white">8</div>
              </div>
            </div>

            {/* Card 4 */}
            <div 
              className="rounded-xl p-5 flex flex-col relative overflow-hidden"
              style={{ backgroundColor: "hsl(218 22% 22%)", border: "1px solid rgba(255,255,255,0.07)" }}
            >
              <div className="flex items-start justify-between mb-4">
                <div className="text-slate-400 font-medium text-xs uppercase tracking-wider">Tokens brugt</div>
                <div className="w-8 h-8 rounded-lg bg-slate-500/10 flex items-center justify-center text-slate-400">
                  <Zap className="w-4 h-4" />
                </div>
              </div>
              <div className="flex items-end justify-between mt-auto">
                <div className="text-3xl font-bold text-white">1.2M</div>
              </div>
            </div>
          </div>

          {/* Quick Actions */}
          <div className="mt-8 flex items-center gap-3">
            <button className="flex items-center gap-2 px-4 py-2 bg-cyan-500 hover:bg-cyan-400 text-white font-medium rounded-lg transition-colors">
              <Plus className="w-4 h-4" />
              Nyt Projekt
            </button>
            <button className="flex items-center gap-2 px-4 py-2 bg-transparent border border-white/10 hover:bg-white/5 text-white font-medium rounded-lg transition-colors">
              <Plus className="w-4 h-4" />
              Ny Arkitektur
            </button>
            <button className="flex items-center gap-2 px-4 py-2 text-cyan-400 hover:text-cyan-300 font-medium rounded-lg transition-colors ml-auto">
              Alle Runs
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>

          {/* Recent Runs */}
          <div className="mt-8">
            <h2 className="text-lg font-semibold text-white mb-4">Seneste AI Runs</h2>
            <div 
              className="rounded-xl overflow-hidden"
              style={{ backgroundColor: "hsl(218 22% 22%)", border: "1px solid rgba(255,255,255,0.07)" }}
            >
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-white/5 text-slate-400 text-xs uppercase tracking-wider">
                    <th className="px-6 py-4 font-medium">Navn</th>
                    <th className="px-6 py-4 font-medium">Status</th>
                    <th className="px-6 py-4 font-medium">Varighed</th>
                    <th className="px-6 py-4 font-medium">Tid</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 text-sm">
                  {/* Row 1 */}
                  <tr className="hover:bg-white/[0.02] transition-colors group cursor-pointer">
                    <td className="px-6 py-4 font-medium text-white flex items-center gap-3">
                      <div className="w-8 h-8 rounded-md bg-white/5 flex items-center justify-center text-slate-400 group-hover:bg-white/10 transition-colors">
                        <PlayCircle className="w-4 h-4" />
                      </div>
                      Customer Support Triage
                    </td>
                    <td className="px-6 py-4">
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        COMPLETED
                      </span>
                    </td>
                    <td className="px-6 py-4 text-slate-300 font-mono text-xs">1.2s</td>
                    <td className="px-6 py-4 text-slate-400">2m siden</td>
                  </tr>

                  {/* Row 2 */}
                  <tr className="hover:bg-white/[0.02] transition-colors group cursor-pointer">
                    <td className="px-6 py-4 font-medium text-white flex items-center gap-3">
                      <div className="w-8 h-8 rounded-md bg-cyan-500/10 flex items-center justify-center text-cyan-400 group-hover:bg-cyan-500/20 transition-colors">
                        <PlayCircle className="w-4 h-4" />
                      </div>
                      Invoice Extraction
                    </td>
                    <td className="px-6 py-4">
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 animate-pulse">
                        <div className="w-1.5 h-1.5 rounded-full bg-cyan-400"></div>
                        RUNNING
                      </span>
                    </td>
                    <td className="px-6 py-4 text-slate-500 font-mono text-xs">...</td>
                    <td className="px-6 py-4 text-cyan-400">Just nu</td>
                  </tr>

                  {/* Row 3 */}
                  <tr className="hover:bg-white/[0.02] transition-colors group cursor-pointer">
                    <td className="px-6 py-4 font-medium text-slate-300 flex items-center gap-3">
                      <div className="w-8 h-8 rounded-md bg-white/5 flex items-center justify-center text-slate-500 group-hover:bg-white/10 transition-colors">
                        <PlayCircle className="w-4 h-4" />
                      </div>
                      Weekly Report
                    </td>
                    <td className="px-6 py-4">
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-slate-500/10 text-slate-400 border border-slate-500/20">
                        <div className="w-1.5 h-1.5 rounded-full bg-slate-400"></div>
                        QUEUED
                      </span>
                    </td>
                    <td className="px-6 py-4 text-slate-500 font-mono text-xs">—</td>
                    <td className="px-6 py-4 text-slate-400">Planlagt</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          
        </div>
      </div>
    </div>
  );
}
