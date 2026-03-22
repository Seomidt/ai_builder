import React from "react";
import { 
  Bot, 
  BarChart3, 
  ShieldCheck, 
  Workflow, 
  Users, 
  Zap,
  Star
} from "lucide-react";

export function CenteredHero() {
  return (
    <div className="min-h-screen font-sans text-slate-200" style={{ backgroundColor: "#0f172a" }}>
      {/* NAVBAR */}
      <nav 
        className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 py-4"
        style={{ 
          backgroundColor: "hsl(218 30% 12%)", 
          borderBottom: "1px solid rgba(255,255,255,0.06)" 
        }}
      >
        <div className="flex items-center gap-3">
          <img src="/__mockup/images/icon.png" alt="BlissOps Icon" className="h-8 w-8 object-contain" />
          <span className="text-white font-bold text-xl tracking-tight">BlissOps</span>
        </div>
        <div className="flex items-center gap-4">
          <button className="text-sm font-medium text-slate-300 hover:text-white transition-colors px-4 py-2 rounded-md hover:bg-white/5">
            Log ind
          </button>
          <button className="text-sm font-medium bg-cyan-400 hover:bg-cyan-300 text-slate-900 px-5 py-2 rounded-md transition-colors shadow-[0_0_15px_rgba(34,211,238,0.3)]">
            Kom i gang
          </button>
        </div>
      </nav>

      {/* HERO SECTION */}
      <main className="pt-32 pb-24 px-6 relative overflow-hidden">
        {/* Radial Glow */}
        <div 
          className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] rounded-full pointer-events-none opacity-20 blur-[100px]"
          style={{ background: "radial-gradient(circle, #22D3EE 0%, transparent 70%)" }}
        />

        <div className="max-w-5xl mx-auto flex flex-col items-center text-center relative z-10">
          
          <img 
            src="/__mockup/images/logo-full.png" 
            alt="BlissOps Logo" 
            className="w-48 mb-12 drop-shadow-[0_0_25px_rgba(34,211,238,0.4)]"
          />

          <h1 className="text-5xl md:text-7xl font-extrabold tracking-tight mb-6 text-white leading-tight">
            Byg intelligente <br />
            <span className="bg-clip-text text-transparent bg-gradient-to-r from-cyan-400 to-blue-500">
              AI-workflows
            </span>
          </h1>

          <p className="text-xl text-slate-400 max-w-2xl mb-10 leading-relaxed">
            Fra idé til produktion. BlissOps er AI-platformen der automatiserer din virksomheds kerneopgaver.
          </p>

          <div className="flex flex-col sm:flex-row items-center gap-4 mb-14">
            <button className="w-full sm:w-auto text-base font-semibold bg-cyan-400 hover:bg-cyan-300 text-slate-900 px-8 py-4 rounded-lg transition-all shadow-[0_0_20px_rgba(34,211,238,0.4)] hover:shadow-[0_0_30px_rgba(34,211,238,0.6)] hover:-translate-y-0.5">
              Kom i gang gratis
            </button>
            <button className="w-full sm:w-auto text-base font-semibold text-white border border-white/20 hover:bg-white/5 px-8 py-4 rounded-lg transition-all">
              Se demo
            </button>
          </div>

          {/* Social Proof */}
          <div className="flex flex-col items-center gap-3 mb-20">
            <div className="flex -space-x-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="w-10 h-10 rounded-full border-2 border-[#0f172a] bg-slate-700 overflow-hidden">
                  <img src={`https://i.pravatar.cc/100?img=${i + 10}`} alt={`User ${i}`} className="w-full h-full object-cover" />
                </div>
              ))}
            </div>
            <div className="flex items-center gap-1 text-amber-500">
              {[1, 2, 3, 4, 5].map((i) => (
                <Star key={i} className="w-4 h-4 fill-current" />
              ))}
            </div>
            <span className="text-sm font-medium text-slate-400">Trusted by 200+ enterprises</span>
          </div>

          {/* Dashboard Mockup */}
          <div className="w-full max-w-4xl relative rounded-xl border border-white/10 bg-slate-900/50 backdrop-blur-sm p-4 shadow-2xl overflow-hidden">
            <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-cyan-400/0 via-cyan-400/50 to-cyan-400/0" />
            
            {/* Fake Dashboard Header */}
            <div className="flex items-center gap-2 mb-6 border-b border-white/5 pb-4">
              <div className="w-3 h-3 rounded-full bg-red-500/80" />
              <div className="w-3 h-3 rounded-full bg-amber-500/80" />
              <div className="w-3 h-3 rounded-full bg-green-500/80" />
            </div>

            {/* Fake Dashboard Content */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
              {[
                { label: "Active Workflows", value: "1,204", trend: "+12%" },
                { label: "Tasks Automated", value: "842k", trend: "+24%" },
                { label: "Time Saved (hrs)", value: "12,450", trend: "+8%" }
              ].map((stat, i) => (
                <div key={i} className="bg-slate-800/50 rounded-lg p-4 border border-white/5">
                  <div className="text-sm text-slate-400 mb-1">{stat.label}</div>
                  <div className="flex items-end justify-between">
                    <div className="text-3xl font-bold text-cyan-400">{stat.value}</div>
                    <div className="text-sm text-emerald-400 mb-1">{stat.trend}</div>
                  </div>
                </div>
              ))}
            </div>
            
            <div className="h-48 bg-slate-800/30 rounded-lg border border-white/5 flex items-center justify-center relative overflow-hidden">
              <div className="absolute inset-0 opacity-20" style={{ backgroundImage: 'linear-gradient(rgba(34, 211, 238, 0.2) 1px, transparent 1px), linear-gradient(90deg, rgba(34, 211, 238, 0.2) 1px, transparent 1px)', backgroundSize: '20px 20px' }}></div>
              <div className="w-full h-full flex items-end px-4 gap-2 opacity-50">
                {[40, 70, 45, 90, 65, 85, 120, 95, 110, 80].map((h, i) => (
                  <div key={i} className="flex-1 bg-cyan-500 rounded-t-sm" style={{ height: `${h}px` }} />
                ))}
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* FEATURES GRID */}
      <section className="py-24 px-6 relative z-10" style={{ backgroundColor: "#0b1121" }}>
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">Alt du behøver i én platform</h2>
            <p className="text-lg text-slate-400 max-w-2xl mx-auto">
              Skalér dine operationer med enterprise-grade værktøjer designet til fremtidens teams.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[
              { icon: Zap, title: "Automation", desc: "Sæt manuelle opgaver på autopilot med intelligente triggere." },
              { icon: Bot, title: "AI-Modeller", desc: "Integrer de nyeste sprogmodeller direkte i dine workflows." },
              { icon: BarChart3, title: "Analytics", desc: "Dybdegående indsigt i performance og ROI på dine automatiseringer." },
              { icon: ShieldCheck, title: "Security", desc: "Enterprise-grade sikkerhed med SOC2 compliance og SSO." },
              { icon: Workflow, title: "Integrations", desc: "Forbind med 100+ af dine yndlingsværktøjer out-of-the-box." },
              { icon: Users, title: "Team Collab", desc: "Arbejd sammen med adgangskontrol og audit logs." },
            ].map((feat, i) => (
              <div 
                key={i} 
                className="bg-slate-800/40 backdrop-blur-sm border border-white/5 hover:border-cyan-500/30 p-8 rounded-xl transition-all hover:bg-slate-800/60 group"
              >
                <div className="w-12 h-12 bg-cyan-500/10 text-cyan-400 rounded-lg flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                  <feat.icon className="w-6 h-6" />
                </div>
                <h3 className="text-xl font-semibold text-white mb-3">{feat.title}</h3>
                <p className="text-slate-400 leading-relaxed">{feat.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="py-12 px-6 border-t border-white/5" style={{ backgroundColor: "#080c17" }}>
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-2 text-slate-400">
            <img src="/__mockup/images/icon.png" alt="BlissOps" className="h-6 w-6 opacity-70 grayscale" />
            <span className="text-sm font-medium">© 2026 BlissOps. Alle rettigheder forbeholdt.</span>
          </div>
          <div className="flex items-center gap-6 text-sm text-slate-500 hover:text-slate-300 transition-colors">
            <a href="#">Privatlivspolitik</a>
            <a href="#">Vilkår</a>
            <a href="#">Kontakt</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
