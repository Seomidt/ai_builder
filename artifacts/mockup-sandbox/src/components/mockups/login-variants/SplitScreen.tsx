import React from "react";
import { Check } from "lucide-react";

export function SplitScreen() {
  return (
    <div className="flex h-full w-full min-h-[780px] font-sans antialiased overflow-hidden">
      {/* Left Panel - Brand (60%) */}
      <div 
        className="relative hidden md:flex md:w-[60%] flex-col justify-center items-start p-16 overflow-hidden"
        style={{ backgroundColor: "hsl(218 30% 12%)" }}
      >
        {/* Ambient Glows */}
        <div 
          className="absolute -top-32 -right-32 w-96 h-96 rounded-full blur-[128px] opacity-30 pointer-events-none"
          style={{ background: "radial-gradient(circle, #22D3EE 0%, transparent 70%)" }}
        />
        <div 
          className="absolute -bottom-32 -left-32 w-96 h-96 rounded-full blur-[128px] opacity-20 pointer-events-none"
          style={{ background: "radial-gradient(circle, #F59E0B 0%, transparent 70%)" }}
        />
        
        {/* Grid Overlay */}
        <div 
          className="absolute inset-0 opacity-[0.03] pointer-events-none"
          style={{ 
            backgroundImage: "linear-gradient(to right, #ffffff 1px, transparent 1px), linear-gradient(to bottom, #ffffff 1px, transparent 1px)",
            backgroundSize: "40px 40px"
          }}
        />

        <div className="relative z-10 w-full max-w-lg">
          <img 
            src="/__mockup/images/logo-full.png" 
            alt="BlissOps Logo" 
            className="w-56 mb-12"
          />
          
          <h1 className="text-white text-3xl md:text-4xl font-light mb-12 leading-tight">
            Byg din fremtid <br/> med <span className="font-semibold text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-blue-500">AI</span>
          </h1>

          <div className="space-y-6">
            {[
              "Automatiser workflows",
              "AI-drevne projekter",
              "Enterprise-sikkerhed"
            ].map((feature, i) => (
              <div key={i} className="flex items-center space-x-4">
                <div className="flex-shrink-0 w-6 h-6 rounded-full bg-cyan-500/10 flex items-center justify-center border border-cyan-500/20">
                  <Check className="w-3.5 h-3.5 text-cyan-400" />
                </div>
                <span className="text-slate-300 text-lg font-light">{feature}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Right Panel - Form (40%) */}
      <div className="flex-1 bg-white dark:bg-slate-50 flex flex-col items-center justify-center p-8 md:p-12 relative">
        <div className="w-full max-w-sm flex flex-col h-full justify-center">
          
          <div className="mb-8 text-center md:text-left">
            <h2 className="text-2xl font-bold text-slate-900 mb-2">Velkommen tilbage</h2>
            <p className="text-slate-500">Log ind på din BlissOps konto</p>
          </div>

          <form className="space-y-5 flex-1 flex flex-col justify-center" onSubmit={(e) => e.preventDefault()}>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-slate-700" htmlFor="email">Email</label>
              <input 
                id="email"
                type="email" 
                placeholder="navn@firma.dk"
                className="w-full px-4 py-2.5 rounded-lg border border-slate-200 bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500 transition-all placeholder:text-slate-400"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-slate-700" htmlFor="password">Adgangskode</label>
              <input 
                id="password"
                type="password" 
                placeholder="••••••••"
                className="w-full px-4 py-2.5 rounded-lg border border-slate-200 bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500 transition-all placeholder:text-slate-400"
              />
            </div>

            <div className="pt-2">
              <button 
                type="submit"
                className="w-full py-2.5 px-4 bg-[#22D3EE] hover:bg-[#06b6d4] text-white font-medium rounded-lg transition-colors shadow-sm focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-cyan-500"
              >
                Log ind
              </button>
            </div>

            <div className="text-center pt-4">
              <a href="#" className="text-sm font-medium text-slate-500 hover:text-cyan-600 transition-colors">
                Glemt adgangskode?
              </a>
            </div>
          </form>

        </div>
        
        {/* Footer */}
        <div className="absolute bottom-8 text-center w-full">
          <p className="text-xs text-slate-400">© 2026 BlissOps</p>
        </div>
      </div>
    </div>
  );
}
