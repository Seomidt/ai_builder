import {
  LayoutDashboard,
  FolderKanban,
  Cpu,
  PlayCircle,
  Building2,
  Zap,
  LogOut,
  Plus,
  CheckCircle2,
  Activity,
  TrendingUp,
} from "lucide-react";

export function CommandCenter() {
  return (
    <div
      className="flex font-sans overflow-hidden text-slate-200"
      style={{
        width: "1280px",
        height: "800px",
        backgroundColor: "hsl(218 25% 18%)",
      }}
    >
      {/* SIDEBAR */}
      <div className="w-64 h-full flex shrink-0 border-r border-white/5 shadow-2xl z-10">
        {/* Icon Rail */}
        <div
          className="w-14 h-full flex flex-col items-center py-4 border-r border-white/5 shrink-0"
          style={{ backgroundColor: "hsl(218 32% 10%)" }}
        >
          {/* Brand */}
          <div className="w-8 h-8 rounded-lg overflow-hidden mb-8">
            <img
              src="/__mockup/images/icon.png"
              alt="BlissOps Icon"
              className="w-full h-full object-cover"
            />
          </div>

          {/* Nav Icons */}
          <div className="flex-1 w-full flex flex-col gap-2 px-1.5">
            <div className="h-11 w-full flex items-center justify-center bg-cyan-500/15 rounded-xl text-cyan-400 cursor-pointer transition-colors">
              <LayoutDashboard size={20} strokeWidth={2.5} />
            </div>
            <div className="h-11 w-full flex items-center justify-center text-slate-500 hover:text-slate-300 hover:bg-white/5 rounded-xl cursor-pointer transition-colors">
              <FolderKanban size={20} strokeWidth={2} />
            </div>
            <div className="h-11 w-full flex items-center justify-center text-slate-500 hover:text-slate-300 hover:bg-white/5 rounded-xl cursor-pointer transition-colors">
              <Cpu size={20} strokeWidth={2} />
            </div>
            <div className="h-11 w-full flex items-center justify-center text-slate-500 hover:text-slate-300 hover:bg-white/5 rounded-xl cursor-pointer transition-colors">
              <PlayCircle size={20} strokeWidth={2} />
            </div>
            <div className="h-11 w-full flex items-center justify-center text-slate-500 hover:text-slate-300 hover:bg-white/5 rounded-xl cursor-pointer transition-colors">
              <Building2 size={20} strokeWidth={2} />
            </div>
          </div>

          {/* Bottom Rail */}
          <div className="flex flex-col gap-4 mt-auto w-full items-center">
            <div className="w-7 h-7 rounded-full bg-gradient-to-tr from-cyan-500 to-blue-500 border border-white/10 shrink-0" />
            <div className="h-11 w-full flex items-center justify-center text-slate-500 hover:text-slate-300 cursor-pointer">
              <LogOut size={18} strokeWidth={2} />
            </div>
          </div>
        </div>

        {/* Text Panel */}
        <div
          className="flex-1 h-full flex flex-col py-4 px-3"
          style={{ backgroundColor: "hsl(218 28% 13%)" }}
        >
          <div className="text-[10px] font-bold tracking-wider text-slate-500 mb-6 px-3">
            WORKSPACE
          </div>

          <div className="flex-1 flex flex-col gap-2">
            <div className="h-11 flex items-center px-3 text-sm font-bold text-cyan-400 cursor-pointer">
              Dashboard
            </div>
            <div className="h-11 flex items-center px-3 text-sm text-slate-400 hover:text-slate-200 cursor-pointer transition-colors">
              Projekter
            </div>
            <div className="h-11 flex items-center px-3 text-sm text-slate-400 hover:text-slate-200 cursor-pointer transition-colors">
              Arkitekturer
            </div>
            <div className="h-11 flex items-center px-3 text-sm text-slate-400 hover:text-slate-200 cursor-pointer transition-colors">
              Runs
            </div>
            <div className="h-11 flex items-center px-3 text-sm text-slate-400 hover:text-slate-200 cursor-pointer transition-colors">
              Workspace
            </div>
          </div>

          {/* Bottom Text Panel */}
          <div className="mt-auto px-3 py-2 text-xs text-slate-500 truncate">
            admin@blissops.com
          </div>
        </div>
      </div>

      {/* MAIN CONTENT */}
      <div className="flex-1 flex flex-col h-full overflow-y-auto">
        {/* Header */}
        <header className="h-20 shrink-0 px-8 flex items-center justify-between border-b border-white/5 sticky top-0 bg-inherit z-10 backdrop-blur-sm">
          <div>
            <h1 className="text-2xl font-bold text-white mb-1">Hej, admin 👋</h1>
            <p className="text-sm text-slate-400">Her er hvad der sker i dag</p>
          </div>
          <button className="h-10 px-4 bg-cyan-500 hover:bg-cyan-400 text-slate-900 font-bold text-sm rounded-lg flex items-center gap-2 transition-all shadow-[0_0_15px_rgba(34,211,238,0.2)] hover:shadow-[0_0_20px_rgba(34,211,238,0.4)]">
            <Plus size={16} strokeWidth={3} />
            Nyt Projekt
          </button>
        </header>

        {/* Content Body */}
        <div className="p-8 flex-1">
          {/* STAT CARDS */}
          <div className="grid grid-cols-3 gap-6">
            <div
              className="rounded-2xl p-6 border border-white/5 flex flex-col gap-2 relative overflow-hidden group hover:border-cyan-500/30 transition-colors cursor-pointer shadow-lg"
              style={{ backgroundColor: "hsl(218 22% 22%)" }}
            >
              <div className="absolute top-0 right-0 w-32 h-32 bg-cyan-500/5 rounded-full blur-2xl -mr-10 -mt-10 group-hover:bg-cyan-500/10 transition-colors" />
              <div className="text-sm text-slate-400 font-medium flex items-center gap-2">
                <Activity size={16} className="text-cyan-500" /> AI Runs
              </div>
              <div className="text-4xl font-bold text-cyan-400 tracking-tight mt-1">
                247
              </div>
            </div>

            <div
              className="rounded-2xl p-6 border border-white/5 flex flex-col gap-2 relative overflow-hidden group hover:border-green-500/30 transition-colors cursor-pointer shadow-lg"
              style={{ backgroundColor: "hsl(218 22% 22%)" }}
            >
              <div className="absolute top-0 right-0 w-32 h-32 bg-green-500/5 rounded-full blur-2xl -mr-10 -mt-10 group-hover:bg-green-500/10 transition-colors" />
              <div className="text-sm text-slate-400 font-medium flex items-center gap-2">
                <CheckCircle2 size={16} className="text-green-500" /> Success Rate
              </div>
              <div className="text-4xl font-bold text-green-400 tracking-tight mt-1">
                98.2%
              </div>
            </div>

            <div
              className="rounded-2xl p-6 border border-white/5 flex flex-col gap-2 relative overflow-hidden group hover:border-amber-500/30 transition-colors cursor-pointer shadow-lg"
              style={{ backgroundColor: "hsl(218 22% 22%)" }}
            >
              <div className="absolute top-0 right-0 w-32 h-32 bg-amber-500/5 rounded-full blur-2xl -mr-10 -mt-10 group-hover:bg-amber-500/10 transition-colors" />
              <div className="text-sm text-slate-400 font-medium flex items-center gap-2">
                <FolderKanban size={16} className="text-amber-500" /> Projekter
              </div>
              <div className="text-4xl font-bold text-amber-400 tracking-tight mt-1">
                12
              </div>
            </div>
          </div>

          {/* 2-COLUMN GRID */}
          <div className="mt-8 grid grid-cols-[60%_40%] gap-6">
            {/* Live Activity */}
            <div
              className="rounded-2xl border border-white/5 flex flex-col overflow-hidden shadow-lg"
              style={{ backgroundColor: "hsl(218 22% 22%)" }}
            >
              <div className="p-5 border-b border-white/5 flex items-center justify-between bg-white/[0.02]">
                <h3 className="font-bold text-white flex items-center gap-2">
                  <Zap size={16} className="text-cyan-400" /> Live Activity
                </h3>
              </div>
              <div className="p-3 flex flex-col gap-1">
                <div className="flex items-center justify-between p-3 hover:bg-white/5 rounded-xl transition-colors cursor-pointer">
                  <div className="flex items-center gap-3">
                    <div className="w-2.5 h-2.5 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]" />
                    <span className="text-sm font-medium text-slate-200">
                      Customer Support Triage afsluttet (1.2s)
                    </span>
                  </div>
                  <span className="text-xs font-medium text-slate-500">
                    2m siden
                  </span>
                </div>

                <div className="flex items-center justify-between p-3 hover:bg-white/5 rounded-xl transition-colors cursor-pointer">
                  <div className="flex items-center gap-3">
                    <div className="w-2.5 h-2.5 rounded-full bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.6)] animate-pulse" />
                    <span className="text-sm font-medium text-cyan-100">
                      Invoice Extraction kører...
                    </span>
                  </div>
                  <span className="text-xs font-medium text-cyan-500/80">
                    Netop nu
                  </span>
                </div>

                <div className="flex items-center justify-between p-3 hover:bg-white/5 rounded-xl transition-colors cursor-pointer">
                  <div className="flex items-center gap-3">
                    <div className="w-2.5 h-2.5 rounded-full bg-slate-600" />
                    <span className="text-sm font-medium text-slate-300">
                      Weekly Report planlagt
                    </span>
                  </div>
                  <span className="text-xs font-medium text-slate-500">
                    Om 2t
                  </span>
                </div>

                <div className="flex items-center justify-between p-3 hover:bg-white/5 rounded-xl transition-colors cursor-pointer">
                  <div className="flex items-center gap-3">
                    <div className="w-2.5 h-2.5 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]" />
                    <span className="text-sm font-medium text-slate-200">
                      Security scan afsluttet
                    </span>
                  </div>
                  <span className="text-xs font-medium text-slate-500">
                    15m siden
                  </span>
                </div>
              </div>
            </div>

            {/* Top Projekter */}
            <div
              className="rounded-2xl border border-white/5 flex flex-col overflow-hidden shadow-lg"
              style={{ backgroundColor: "hsl(218 22% 22%)" }}
            >
              <div className="p-5 border-b border-white/5 flex items-center justify-between bg-white/[0.02]">
                <h3 className="font-bold text-white flex items-center gap-2">
                  <TrendingUp size={16} className="text-amber-400" /> Top Projekter
                </h3>
              </div>
              <div className="p-5 flex flex-col gap-4">
                <div className="flex items-center justify-between group cursor-pointer">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-cyan-500/10 flex items-center justify-center text-cyan-400 group-hover:bg-cyan-500/20 transition-colors">
                      <Cpu size={16} />
                    </div>
                    <span className="text-sm font-bold text-slate-200 group-hover:text-white transition-colors">
                      BlissCore
                    </span>
                  </div>
                  <div className="px-2.5 py-1 bg-white/5 rounded-md text-xs font-medium text-cyan-400 border border-white/5">
                    142 runs
                  </div>
                </div>

                <div className="flex items-center justify-between group cursor-pointer">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center text-amber-400 group-hover:bg-amber-500/20 transition-colors">
                      <FolderKanban size={16} />
                    </div>
                    <span className="text-sm font-bold text-slate-200 group-hover:text-white transition-colors">
                      SupportBot
                    </span>
                  </div>
                  <div className="px-2.5 py-1 bg-white/5 rounded-md text-xs font-medium text-amber-400 border border-white/5">
                    89 runs
                  </div>
                </div>

                <div className="flex items-center justify-between group cursor-pointer">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-indigo-500/10 flex items-center justify-center text-indigo-400 group-hover:bg-indigo-500/20 transition-colors">
                      <Building2 size={16} />
                    </div>
                    <span className="text-sm font-bold text-slate-200 group-hover:text-white transition-colors">
                      DataPipe
                    </span>
                  </div>
                  <div className="px-2.5 py-1 bg-white/5 rounded-md text-xs font-medium text-indigo-400 border border-white/5">
                    56 runs
                  </div>
                </div>

                <div className="mt-2 pt-4 border-t border-white/5 flex gap-4">
                  <div className="flex-1 bg-white/5 rounded-xl p-3 border border-white/5">
                    <div className="text-[10px] text-slate-400 uppercase font-bold tracking-wider mb-1">Bedste run</div>
                    <div className="text-lg font-bold text-white">0.8s</div>
                  </div>
                  <div className="flex-1 bg-white/5 rounded-xl p-3 border border-white/5">
                    <div className="text-[10px] text-slate-400 uppercase font-bold tracking-wider mb-1">Gennemsnit</div>
                    <div className="text-lg font-bold text-white">1.4s</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
