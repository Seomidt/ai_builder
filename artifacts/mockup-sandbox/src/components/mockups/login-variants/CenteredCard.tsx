import React from 'react';
import { Mail, Lock, ArrowRight } from 'lucide-react';

export function CenteredCard() {
  return (
    <div className="min-h-screen w-full relative overflow-hidden flex flex-col items-center justify-center font-['Inter']"
         style={{ 
           background: 'linear-gradient(135deg, hsl(218, 30%, 14%), hsl(218, 25%, 20%))'
         }}>
      
      {/* Animated background stars */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-[10%] left-[20%] w-1 h-1 bg-white rounded-full opacity-20 animate-[pulse_3s_ease-in-out_infinite]" />
        <div className="absolute top-[30%] right-[25%] w-1.5 h-1.5 bg-cyan-300 rounded-full opacity-30 animate-[pulse_4s_ease-in-out_infinite_1s]" />
        <div className="absolute bottom-[20%] left-[30%] w-2 h-2 bg-white rounded-full opacity-10 animate-[pulse_5s_ease-in-out_infinite_2s] blur-[1px]" />
        <div className="absolute top-[60%] right-[15%] w-1 h-1 bg-amber-200 rounded-full opacity-20 animate-[pulse_3.5s_ease-in-out_infinite_0.5s]" />
        <div className="absolute bottom-[40%] left-[10%] w-1.5 h-1.5 bg-cyan-400 rounded-full opacity-20 animate-[pulse_4.5s_ease-in-out_infinite_1.5s]" />
      </div>

      {/* Radial Cyan Glow */}
      <div className="absolute top-[-10%] left-1/2 -translate-x-1/2 w-[600px] h-[600px] bg-cyan-500/10 rounded-full blur-[100px] pointer-events-none" />

      {/* Main Container */}
      <div className="relative z-10 w-full max-w-md px-6 flex flex-col items-center">
        
        {/* Header section */}
        <div className="flex flex-col items-center mb-8 text-center">
          <img 
            src="/__mockup/images/icon.png" 
            alt="BlissOps Logo" 
            className="h-28 w-auto mb-4 object-contain"
            style={{ filter: "drop-shadow(0 0 28px rgba(34,211,238,0.5))" }}
          />
          <h1 className="text-3xl font-bold tracking-tight mb-2">
            <span className="text-white">Bliss</span>
            <span className="text-cyan-400">Ops</span>
          </h1>
          <p className="text-slate-400 text-sm font-medium">
            AI Platform — Log ind for at fortsætte
          </p>
        </div>

        {/* Glassmorphism Card */}
        <div className="w-full rounded-2xl p-8 shadow-2xl backdrop-blur-md relative overflow-hidden"
             style={{
               background: 'rgba(255, 255, 255, 0.035)',
               border: '1px solid rgba(255, 255, 255, 0.10)',
               boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 40px rgba(34, 211, 238, 0.1) inset'
             }}>
          
          <form className="space-y-5" onSubmit={(e) => e.preventDefault()}>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-slate-300 ml-1">E-mail</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
                  <Mail className="h-4 w-4 text-slate-500" />
                </div>
                <input 
                  type="email" 
                  placeholder="admin@virksomhed.dk" 
                  className="w-full bg-slate-900/50 border border-slate-700/50 rounded-xl py-2.5 pl-10 pr-4 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500/50 transition-all text-sm"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between ml-1">
                <label className="text-sm font-medium text-slate-300">Adgangskode</label>
                <a href="#" className="text-xs text-cyan-400 hover:text-cyan-300 transition-colors">Glemt adgangskode?</a>
              </div>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
                  <Lock className="h-4 w-4 text-slate-500" />
                </div>
                <input 
                  type="password" 
                  placeholder="••••••••" 
                  className="w-full bg-slate-900/50 border border-slate-700/50 rounded-xl py-2.5 pl-10 pr-4 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500/50 transition-all text-sm"
                />
              </div>
            </div>

            <button 
              type="submit"
              className="w-full mt-6 relative group overflow-hidden rounded-xl font-medium text-slate-900 py-3 transition-all duration-300 flex items-center justify-center space-x-2 shadow-[0_0_20px_rgba(34,211,238,0.3)] hover:shadow-[0_0_30px_rgba(34,211,238,0.5)]"
              style={{
                background: 'linear-gradient(135deg, #22D3EE, #38BDF8)'
              }}>
              <span className="relative z-10 font-semibold">Log ind</span>
              <ArrowRight className="h-4 w-4 relative z-10 group-hover:translate-x-1 transition-transform" />
              
              {/* Gold shimmer hover effect */}
              <div className="absolute inset-0 -translate-x-full group-hover:animate-[shimmer_1.5s_infinite] bg-gradient-to-r from-transparent via-amber-400/30 to-transparent skew-x-12" />
            </button>
          </form>

          {/* Alternative login */}
          <div className="mt-8 flex items-center justify-between">
            <span className="h-px w-full bg-gradient-to-r from-transparent via-slate-700 to-transparent" />
            <span className="px-4 text-xs text-slate-500 font-medium uppercase tracking-wider">Eller</span>
            <span className="h-px w-full bg-gradient-to-r from-transparent via-slate-700 to-transparent" />
          </div>

          <div className="mt-6 flex justify-center">
            <button className="text-sm text-slate-400 hover:text-white transition-colors duration-200">
              Log ind med Single Sign-On (SSO)
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-12 text-center">
          <p className="text-xs text-slate-500">© 2026 BlissOps. Alle rettigheder forbeholdes.</p>
        </div>

      </div>

      <style>{`
        @keyframes shimmer {
          100% {
            transform: translateX(100%);
          }
        }
      `}</style>
    </div>
  );
}