import React from "react";
import { ArrowRight, BarChart3, CheckCircle2, ChevronRight, Github, Linkedin, Lock, PlayCircle, Plus, Shield, Twitter, Zap } from "lucide-react";

export function AsymHero() {
  return (
    <div className="min-h-screen bg-[#0A0F1C] text-slate-200 font-sans selection:bg-cyan-500/30 overflow-x-hidden">
      {/* NAVBAR */}
      <nav className="fixed top-0 w-full z-50 border-b border-white/5 bg-[#0A0F1C]/80 backdrop-blur-md">
        <div className="max-w-[1280px] mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src="/__mockup/images/icon.png" alt="BlissOps Icon" className="h-8 w-8 object-contain" />
            <span className="text-white font-bold text-xl tracking-tight">BlissOps</span>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-500 border border-amber-500/20">BETA</span>
          </div>
          
          <div className="hidden md:flex items-center gap-8">
            <a href="#" className="text-sm font-medium text-slate-400 hover:text-white transition-colors">Platform</a>
            <a href="#" className="text-sm font-medium text-slate-400 hover:text-white transition-colors">Priser</a>
            <a href="#" className="text-sm font-medium text-slate-400 hover:text-white transition-colors">Om os</a>
          </div>

          <div className="flex items-center gap-4">
            <a href="#" className="hidden sm:block text-sm font-medium text-slate-300 hover:text-white transition-colors">Log ind</a>
            <a href="#" className="text-sm font-medium text-white px-5 py-2 rounded-full bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 transition-all shadow-[0_0_15px_rgba(34,211,238,0.3)] hover:shadow-[0_0_25px_rgba(34,211,238,0.5)] flex items-center gap-2 group">
              Start gratis
              <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
            </a>
          </div>
        </div>
      </nav>

      {/* HERO SECTION */}
      <main className="pt-32 pb-20 px-6 max-w-[1280px] mx-auto min-h-[90vh] flex items-center">
        <div className="grid grid-cols-1 lg:grid-cols-[55%_45%] gap-16 items-center w-full">
          
          {/* Left Column */}
          <div className="flex flex-col items-start relative z-10">
            <div className="absolute -top-32 -left-32 w-96 h-96 bg-cyan-500/20 rounded-full blur-[120px] pointer-events-none" />
            
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 text-xs font-semibold mb-8 backdrop-blur-sm">
              <span className="text-amber-400">✦</span> Ny: AI Workflow Builder
            </div>
            
            <h1 className="text-5xl sm:text-6xl lg:text-7xl font-black text-white leading-[1.1] tracking-tight mb-4">
              Automatiser din virksomhed med<br/>
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 via-cyan-300 to-blue-500">
                næste generations AI
              </span>
            </h1>
            
            <p className="text-lg sm:text-xl text-slate-400 max-w-xl mb-10 leading-relaxed font-light">
              Byg komplekse enterprise workflows på minutter. Forbind dine systemer, træn din AI, og lad BlissOps håndtere driften.
            </p>
            
            <div className="flex flex-col sm:flex-row items-center gap-4 mb-16 w-full sm:w-auto">
              <button className="w-full sm:w-auto px-8 py-4 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-lg transition-all hover:-translate-y-0.5 hover:shadow-[0_10px_30px_rgba(34,211,238,0.3)] flex items-center justify-center gap-2">
                Prøv gratis <Zap className="w-5 h-5" />
              </button>
              <button className="w-full sm:w-auto px-8 py-4 rounded-xl border border-white/10 hover:border-white/20 bg-white/5 hover:bg-white/10 text-white font-semibold text-lg transition-all flex items-center justify-center gap-2">
                Book demo
              </button>
            </div>
            
            <div className="w-full pt-8 border-t border-white/10">
              <p className="text-sm text-slate-500 font-medium mb-4 uppercase tracking-wider">Betroet af enterprise ledere</p>
              <div className="flex items-center gap-6 sm:gap-10 text-slate-400 font-bold text-lg sm:text-xl grayscale opacity-70">
                <span>Novo Nordisk</span>
                <span className="w-1.5 h-1.5 rounded-full bg-slate-600"></span>
                <span>Maersk</span>
                <span className="w-1.5 h-1.5 rounded-full bg-slate-600"></span>
                <span>DSB</span>
              </div>
            </div>
          </div>
          
          {/* Right Column (Visual) */}
          <div className="relative w-full h-full min-h-[500px] hidden lg:block perspective-1000">
            {/* Glow effect */}
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[120%] h-[120%] bg-gradient-to-tr from-cyan-500/20 to-blue-600/20 blur-[100px] rounded-full z-0" />
            
            {/* Dashboard Mockup Card */}
            <div 
              className="absolute right-0 top-1/2 -translate-y-1/2 w-[500px] bg-[#0F1629] border border-white/10 rounded-2xl shadow-[0_20px_60px_rgba(0,0,0,0.6)] z-10 overflow-hidden backdrop-blur-sm transition-transform duration-700 hover:rotate-0"
              style={{
                transform: 'perspective(1200px) rotateY(-8deg) rotateX(4deg)',
                transformStyle: 'preserve-3d'
              }}
            >
              {/* Fake Browser/App Header */}
              <div className="flex items-center px-4 py-3 border-b border-white/5 bg-[#161F33]">
                <div className="flex gap-1.5 mr-4">
                  <div className="w-3 h-3 rounded-full bg-slate-700/50" />
                  <div className="w-3 h-3 rounded-full bg-slate-700/50" />
                  <div className="w-3 h-3 rounded-full bg-slate-700/50" />
                </div>
                <div className="flex-1 text-center font-mono text-xs text-slate-500">blissops.ai/dashboard</div>
              </div>
              
              <div className="p-6">
                <div className="flex items-center justify-between mb-8">
                  <h3 className="text-white font-semibold text-lg flex items-center gap-2">
                    AI Runs — Live
                    <span className="relative flex h-2.5 w-2.5 ml-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500"></span>
                    </span>
                  </h3>
                  <button className="text-xs bg-white/5 hover:bg-white/10 border border-white/10 px-3 py-1.5 rounded-md text-slate-300 transition-colors">
                    View All
                  </button>
                </div>
                
                {/* Run Items */}
                <div className="space-y-3 mb-8">
                  <div className="bg-[#1A233A] border border-white/5 rounded-xl p-4 flex items-center justify-between group hover:border-cyan-500/30 transition-colors">
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-lg bg-green-500/10 flex items-center justify-center text-green-400">
                        <CheckCircle2 className="w-5 h-5" />
                      </div>
                      <div>
                        <div className="text-slate-200 font-medium text-sm">Customer Support Triage</div>
                        <div className="text-slate-500 text-xs mt-0.5">ID: bls_8f92a • 2m ago</div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-green-500/10 text-green-400 border border-green-500/20">
                        COMPLETED
                      </div>
                      <div className="text-slate-500 text-xs mt-1">1.2s</div>
                    </div>
                  </div>
                  
                  <div className="bg-[#1A233A] border border-white/5 rounded-xl p-4 flex items-center justify-between group hover:border-cyan-500/30 transition-colors">
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-lg bg-cyan-500/10 flex items-center justify-center text-cyan-400">
                        <PlayCircle className="w-5 h-5 animate-pulse" />
                      </div>
                      <div>
                        <div className="text-slate-200 font-medium text-sm">Invoice Data Extraction</div>
                        <div className="text-slate-500 text-xs mt-0.5">ID: bls_4a19x • Just now</div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                        RUNNING
                      </div>
                      <div className="text-slate-500 text-xs mt-1">...</div>
                    </div>
                  </div>
                  
                  <div className="bg-[#1A233A] border border-white/5 rounded-xl p-4 flex items-center justify-between opacity-60">
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-lg bg-slate-700/30 flex items-center justify-center text-slate-500">
                        <span className="w-2 h-2 bg-slate-500 rounded-full" />
                      </div>
                      <div>
                        <div className="text-slate-400 font-medium text-sm">Weekly Report Gen</div>
                        <div className="text-slate-600 text-xs mt-0.5">Scheduled</div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-800 text-slate-400 border border-slate-700">
                        QUEUED
                      </div>
                    </div>
                  </div>
                </div>
                
                {/* Mini Chart */}
                <div className="bg-[#1A233A] border border-white/5 rounded-xl p-4 h-32 flex flex-col justify-end gap-1 relative overflow-hidden">
                  <div className="absolute top-4 left-4 flex items-center gap-2">
                    <BarChart3 className="w-4 h-4 text-slate-400" />
                    <span className="text-xs font-medium text-slate-400">Throughput (last 1h)</span>
                  </div>
                  <div className="flex items-end gap-2 h-16 mt-auto px-2">
                    {[30, 45, 25, 60, 40, 75, 50, 85, 45, 95].map((height, i) => (
                      <div key={i} className="flex-1 bg-cyan-500/20 hover:bg-cyan-400/40 transition-colors rounded-t-sm relative group" style={{ height: `${height}%` }}>
                        <div className="absolute top-0 left-0 w-full h-0.5 bg-cyan-400" />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
            
            {/* Decorative elements around card */}
            <div className="absolute top-20 right-20 w-16 h-16 bg-gradient-to-br from-amber-500/20 to-orange-600/20 rounded-xl border border-amber-500/30 backdrop-blur-md flex items-center justify-center -rotate-12 translate-z-10 animate-pulse">
              <Zap className="w-6 h-6 text-amber-400" />
            </div>
          </div>
        </div>
      </main>

      {/* STATS ROW */}
      <section className="border-y border-white/5 bg-[#0F1629]">
        <div className="max-w-[1280px] mx-auto px-6 py-12">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 divide-x divide-white/5">
            {[
              { num: "10K+", label: "Workflows Executed" },
              { num: "99.9%", label: "Uptime SLA" },
              { num: "200+", label: "Enterprise Clients" },
              { num: "4.9★", label: "Average Rating" }
            ].map((stat, i) => (
              <div key={i} className={`flex flex-col items-center justify-center text-center ${i % 2 === 0 ? '' : 'border-l-0 md:border-l'}`}>
                <div className="text-4xl md:text-5xl font-black text-cyan-400 mb-2 tracking-tight drop-shadow-[0_0_10px_rgba(34,211,238,0.2)]">{stat.num}</div>
                <div className="text-sm font-medium text-slate-500 uppercase tracking-widest">{stat.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FEATURES SECTION (Alternating) */}
      <section className="py-32 relative">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full h-[500px] bg-gradient-to-b from-[#0F1629] to-transparent z-0" />
        
        <div className="max-w-[1000px] mx-auto px-6 relative z-10 space-y-32">
          
          {/* Feature 1 */}
          <div className="grid md:grid-cols-2 gap-16 items-center">
            <div>
              <div className="w-12 h-12 rounded-xl bg-cyan-500/10 flex items-center justify-center mb-6 border border-cyan-500/20">
                <Zap className="w-6 h-6 text-cyan-400" />
              </div>
              <h2 className="text-3xl font-bold text-white mb-4">Visuel AI Builder</h2>
              <p className="text-slate-400 leading-relaxed mb-6">
                Design komplekse processer uden at skrive kode. Vores drag-and-drop interface lader dig bygge, teste og deploye AI workflows på minutter frem for måneder.
              </p>
              <ul className="space-y-3">
                {['No-code interface', 'Real-time testing', 'Version control'].map((item, i) => (
                  <li key={i} className="flex items-center gap-3 text-slate-300 text-sm font-medium">
                    <CheckCircle2 className="w-4 h-4 text-cyan-500" /> {item}
                  </li>
                ))}
              </ul>
            </div>
            <div className="relative">
              <div className="absolute inset-0 bg-gradient-to-tr from-cyan-500/10 to-transparent blur-2xl rounded-full" />
              <div className="relative aspect-square rounded-2xl border border-white/10 bg-[#161F33] overflow-hidden p-6 shadow-2xl">
                {/* Mockup visualization */}
                <div className="absolute top-1/4 left-1/4 w-1/2 h-12 bg-[#1A233A] border border-white/10 rounded-lg flex items-center justify-center gap-2 shadow-lg">
                  <div className="w-2 h-2 rounded-full bg-cyan-400" />
                  <span className="text-xs font-mono text-slate-300">Trigger: Email</span>
                </div>
                <div className="absolute top-1/2 left-1/4 w-px h-16 bg-cyan-500/30" />
                <div className="absolute top-[60%] left-[10%] w-[80%] h-16 bg-gradient-to-r from-cyan-500 to-blue-600 rounded-lg flex items-center justify-center gap-2 shadow-lg shadow-cyan-500/20">
                  <Zap className="w-4 h-4 text-white" />
                  <span className="text-sm font-bold text-white">LLM Processing</span>
                </div>
              </div>
            </div>
          </div>

          {/* Feature 2 */}
          <div className="grid md:grid-cols-2 gap-16 items-center">
            <div className="order-2 md:order-1 relative">
               <div className="absolute inset-0 bg-gradient-to-tr from-amber-500/10 to-transparent blur-2xl rounded-full" />
               <div className="relative aspect-square rounded-2xl border border-white/10 bg-[#161F33] overflow-hidden p-6 shadow-2xl flex items-center justify-center">
                 <div className="grid grid-cols-2 gap-4 w-full h-full p-4">
                   <div className="bg-[#1A233A] rounded-xl border border-white/5 flex items-center justify-center"><img src="/__mockup/images/icon.png" alt="icon" className="w-8 h-8 opacity-50" /></div>
                   <div className="bg-[#1A233A] rounded-xl border border-white/5 flex items-center justify-center"><Github className="w-8 h-8 text-slate-500" /></div>
                   <div className="bg-[#1A233A] rounded-xl border border-white/5 flex items-center justify-center"><div className="text-2xl font-bold text-slate-500">API</div></div>
                   <div className="bg-[#1A233A] rounded-xl border border-white/5 flex items-center justify-center"><div className="text-slate-500 font-bold">SQL</div></div>
                 </div>
               </div>
            </div>
            <div className="order-1 md:order-2">
              <div className="w-12 h-12 rounded-xl bg-amber-500/10 flex items-center justify-center mb-6 border border-amber-500/20">
                <Plus className="w-6 h-6 text-amber-500" />
              </div>
              <h2 className="text-3xl font-bold text-white mb-4">Ubegrænsede Integrationer</h2>
              <p className="text-slate-400 leading-relaxed mb-6">
                Forbind BlissOps til hele din tech stack. Med over 100 native integrationer og understøttelse af custom APIs, er der ingen grænser for hvad du kan automatisere.
              </p>
              <ul className="space-y-3">
                {['REST & GraphQL', 'OAuth 2.0 support', 'Custom webhooks'].map((item, i) => (
                  <li key={i} className="flex items-center gap-3 text-slate-300 text-sm font-medium">
                    <CheckCircle2 className="w-4 h-4 text-amber-500" /> {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Feature 3 */}
          <div className="grid md:grid-cols-2 gap-16 items-center">
            <div>
              <div className="w-12 h-12 rounded-xl bg-blue-500/10 flex items-center justify-center mb-6 border border-blue-500/20">
                <BarChart3 className="w-6 h-6 text-blue-400" />
              </div>
              <h2 className="text-3xl font-bold text-white mb-4">Avanceret Analytics</h2>
              <p className="text-slate-400 leading-relaxed mb-6">
                Få fuld indsigt i dine AI operationer. Monitorer performance, omkostninger og throughput i realtid, og identificer flaskehalse før de opstår.
              </p>
              <ul className="space-y-3">
                {['Real-time dashboards', 'Cost tracking', 'Custom alerts'].map((item, i) => (
                  <li key={i} className="flex items-center gap-3 text-slate-300 text-sm font-medium">
                    <CheckCircle2 className="w-4 h-4 text-blue-500" /> {item}
                  </li>
                ))}
              </ul>
            </div>
            <div className="relative">
              <div className="absolute inset-0 bg-gradient-to-tr from-blue-500/10 to-transparent blur-2xl rounded-full" />
              <div className="relative aspect-[4/3] rounded-2xl border border-white/10 bg-[#161F33] overflow-hidden shadow-2xl p-6 flex flex-col justify-end gap-2">
                <div className="flex items-end gap-2 h-full w-full">
                  {[20, 30, 25, 40, 35, 60, 50, 80, 70, 95].map((h, i) => (
                    <div key={i} className="flex-1 bg-blue-500/20 rounded-t-sm relative" style={{ height: `${h}%` }}>
                      <div className="absolute top-0 left-0 w-full h-1 bg-blue-400 rounded-t-sm" />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Feature 4 */}
          <div className="grid md:grid-cols-2 gap-16 items-center">
            <div className="order-2 md:order-1 relative">
               <div className="absolute inset-0 bg-gradient-to-tr from-emerald-500/10 to-transparent blur-2xl rounded-full" />
               <div className="relative aspect-square rounded-2xl border border-white/10 bg-[#161F33] overflow-hidden p-6 shadow-2xl flex items-center justify-center">
                 <Shield className="w-32 h-32 text-emerald-500/20" />
                 <Lock className="w-12 h-12 text-emerald-400 absolute" />
               </div>
            </div>
            <div className="order-1 md:order-2">
              <div className="w-12 h-12 rounded-xl bg-emerald-500/10 flex items-center justify-center mb-6 border border-emerald-500/20">
                <Shield className="w-6 h-6 text-emerald-500" />
              </div>
              <h2 className="text-3xl font-bold text-white mb-4">Enterprise Sikkerhed</h2>
              <p className="text-slate-400 leading-relaxed mb-6">
                Designet med sikkerhed som førsteprioritet. Vi overholder de strengeste compliance krav, så du trygt kan håndtere følsom data i dine workflows.
              </p>
              <ul className="space-y-3">
                {['SOC2 Type II', 'End-to-end encryption', 'RBAC & SSO'].map((item, i) => (
                  <li key={i} className="flex items-center gap-3 text-slate-300 text-sm font-medium">
                    <CheckCircle2 className="w-4 h-4 text-emerald-500" /> {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>

        </div>
      </section>

      {/* CTA SECTION */}
      <section className="py-24 relative overflow-hidden">
        <div className="absolute inset-0 bg-cyan-900/20" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-cyan-500/10 blur-[100px] rounded-full" />
        
        <div className="max-w-[800px] mx-auto px-6 relative z-10 text-center">
          <h2 className="text-4xl md:text-5xl font-black text-white mb-6">Klar til at transformere din virksomhed?</h2>
          <p className="text-xl text-slate-300 mb-10 font-light">Join hundredevis af enterprise teams der allerede bruger BlissOps.</p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
             <button className="w-full sm:w-auto px-10 py-4 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-lg transition-all shadow-lg hover:shadow-cyan-500/30">
               Start gratis i dag
             </button>
             <button className="w-full sm:w-auto px-10 py-4 rounded-xl bg-[#161F33] hover:bg-[#1A233A] text-white font-semibold text-lg border border-white/10 transition-all">
               Kontakt salg
             </button>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="border-t border-white/10 bg-[#0A0F1C] pt-16 pb-8">
        <div className="max-w-[1280px] mx-auto px-6 grid grid-cols-1 md:grid-cols-3 gap-12 mb-12">
          
          <div className="space-y-6">
            <div className="flex items-center gap-3">
               <img src="/__mockup/images/logo-full.png" alt="BlissOps Logo" className="h-8 object-contain opacity-90" />
            </div>
            <p className="text-slate-400 text-sm leading-relaxed max-w-sm">
              AI-Builder Platform for enterprises. Automatiser komplekse processer sikkert og skalerbart.
            </p>
          </div>
          
          <div className="grid grid-cols-2 gap-8">
            <div>
              <h4 className="text-white font-semibold mb-4">Platform</h4>
              <ul className="space-y-2 text-sm text-slate-400">
                <li><a href="#" className="hover:text-cyan-400 transition-colors">Features</a></li>
                <li><a href="#" className="hover:text-cyan-400 transition-colors">Integrationer</a></li>
                <li><a href="#" className="hover:text-cyan-400 transition-colors">Priser</a></li>
                <li><a href="#" className="hover:text-cyan-400 transition-colors">Changelog</a></li>
              </ul>
            </div>
            <div>
              <h4 className="text-white font-semibold mb-4">Virksomhed</h4>
              <ul className="space-y-2 text-sm text-slate-400">
                <li><a href="#" className="hover:text-cyan-400 transition-colors">Om os</a></li>
                <li><a href="#" className="hover:text-cyan-400 transition-colors">Karriere</a></li>
                <li><a href="#" className="hover:text-cyan-400 transition-colors">Kontakt</a></li>
                <li><a href="#" className="hover:text-cyan-400 transition-colors">Blog</a></li>
              </ul>
            </div>
          </div>
          
          <div className="flex flex-col items-start md:items-end justify-between">
            <div className="flex items-center gap-4">
              <a href="#" className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/10 transition-all">
                <Twitter className="w-5 h-5" />
              </a>
              <a href="#" className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/10 transition-all">
                <Github className="w-5 h-5" />
              </a>
              <a href="#" className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/10 transition-all">
                <Linkedin className="w-5 h-5" />
              </a>
            </div>
            <div className="text-slate-500 text-sm mt-8 md:mt-0">
              © {new Date().getFullYear()} BlissOps Inc. All rights reserved.
            </div>
          </div>
          
        </div>
      </footer>
    </div>
  );
}
