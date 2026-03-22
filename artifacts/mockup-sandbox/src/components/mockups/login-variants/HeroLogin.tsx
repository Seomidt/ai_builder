import React, { useState, useEffect } from "react";

export function HeroLogin() {
  const [stars, setStars] = useState<{ id: number; left: string; top: string; delay: string; duration: string }[]>([]);

  useEffect(() => {
    // Generate 15 random stars on mount
    const newStars = Array.from({ length: 15 }).map((_, i) => ({
      id: i,
      left: `${Math.random() * 100}%`,
      top: `${Math.random() * 100}%`,
      delay: `${Math.random() * 5}s`,
      duration: `${3 + Math.random() * 4}s`,
    }));
    setStars(newStars);
  }, []);

  return (
    <div 
      className="min-h-screen w-full flex flex-col relative overflow-hidden font-sans"
      style={{
        background: "radial-gradient(circle at center, hsl(218 40% 8%), hsl(215 35% 4%))"
      }}
    >
      {/* Animated Stars */}
      {stars.map((star) => (
        <div
          key={star.id}
          className="absolute rounded-full bg-white"
          style={{
            width: "2px",
            height: "2px",
            left: star.left,
            top: star.top,
            opacity: 0,
            animation: `twinkle ${star.duration} ease-in-out ${star.delay} infinite`,
          }}
        />
      ))}

      {/* Global styles for animation */}
      <style>{`
        @keyframes twinkle {
          0% { opacity: 0; transform: scale(0.5); }
          50% { opacity: 1; transform: scale(1); }
          100% { opacity: 0; transform: scale(0.5); }
        }
      `}</style>

      <div className="flex-1 flex flex-col items-center justify-center px-6 relative z-10">
        
        {/* Top Section */}
        <div className="flex flex-col items-center mb-12">
          {/* Infinity Icon with Glow Rings */}
          <div className="relative flex items-center justify-center mb-8 w-[200px] h-[200px]">
            {/* Outer Ring */}
            <div className="absolute inset-0 rounded-full border-2 border-amber-400/20 animate-pulse" />
            
            {/* Inner Ring */}
            <div className="absolute w-[160px] h-[160px] rounded-full border border-cyan-400/30" />
            
            {/* Logo */}
            <img 
              src="/__mockup/images/icon.png" 
              alt="BlissOps Logo" 
              className="h-32 object-contain relative z-10"
              style={{
                filter: "drop-shadow(0 0 40px rgba(34,211,238,0.6)) drop-shadow(0 0 80px rgba(245,158,11,0.3))"
              }}
            />
          </div>

          {/* Typography */}
          <div className="text-center space-y-2">
            <h1 className="text-4xl font-bold tracking-tight">
              <span className="text-white">Bliss</span>
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-cyan-200">Ops</span>
            </h1>
            <p className="text-sm tracking-[0.3em] uppercase text-cyan-400/70 font-medium">
              AI Platform
            </p>
          </div>
        </div>

        {/* Form Section */}
        <div className="w-full max-w-sm space-y-6">
          <div className="space-y-4">
            <input 
              type="email" 
              placeholder="Email address"
              className="w-full px-5 py-4 rounded-xl bg-white/5 border border-white/10 text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500/50 transition-all backdrop-blur-sm"
            />
            <input 
              type="password" 
              placeholder="Password"
              className="w-full px-5 py-4 rounded-xl bg-white/5 border border-white/10 text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500/50 transition-all backdrop-blur-sm"
            />
          </div>

          <button className="w-full py-4 rounded-xl font-semibold text-white bg-gradient-to-r from-cyan-500 to-amber-500 shadow-[0_0_20px_rgba(34,211,238,0.3)] hover:shadow-[0_0_30px_rgba(34,211,238,0.5)] transition-all active:scale-[0.98]">
            Log ind
          </button>
        </div>

      </div>

      {/* Footer */}
      <div className="py-6 text-center text-white/30 text-xs tracking-wider relative z-10">
        © 2026 BlissOps
      </div>
    </div>
  );
}
