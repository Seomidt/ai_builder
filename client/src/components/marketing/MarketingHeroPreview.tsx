export function MarketingHeroPreview() {
  return (
    <div className="relative mx-auto mt-12 w-full max-w-3xl pb-4">
      {/* Glow behind preview */}
      <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-[500px] w-[700px] rounded-full bg-[radial-gradient(circle,rgba(56,189,248,0.14),transparent_60%)] blur-3xl" />

      {/* Main preview card */}
      <div className="relative rounded-2xl border border-white/10 bg-[#0a1628]/90 p-3 shadow-[0_40px_100px_rgba(0,0,0,0.7)]">
        <div className="rounded-xl border border-sky-400/10 bg-[#060d1f]/80 p-4">

          {/* Preview header */}
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="grid h-7 w-7 place-items-center rounded-lg border border-sky-400/20 bg-[#0a1628]">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle cx="12" cy="4.5" r="2.2" fill="#38BDF8" />
                  <circle cx="5.25" cy="18" r="2.2" fill="#60A5FA" />
                  <circle cx="18.75" cy="18" r="2.2" fill="#F59E0B" />
                  <path d="M12 6.8L6.8 16.1M12 6.8L17.2 16.1M7.7 18h8.6" stroke="#93C5FD" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </div>
              <div>
                <div className="text-xs font-semibold text-white">BlissOps</div>
                <div className="text-[10px] text-slate-400">AI Infrastructure Platform</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-300">Demo tenant</span>
              <span className="rounded-full border border-sky-500/20 bg-sky-500/10 px-2 py-0.5 text-[10px] text-sky-300">Private rollout</span>
            </div>
          </div>

          {/* Preview layout */}
          <div className="grid gap-3 md:grid-cols-[180px_1fr]">
            {/* Sidebar */}
            <aside className="rounded-xl border border-white/8 bg-[#0a1628] p-3">
              <div className="mb-2 text-[9px] font-bold uppercase tracking-[0.2em] text-slate-500">Core</div>
              <div className="space-y-1 text-xs">
                {["AI Chat","Experts","Storage","Team","Permissions","Usage","AI Operations","Logs","Billing"].map((item, idx) => (
                  <div key={item} className={["rounded-lg px-2.5 py-1.5", idx === 0 ? "border border-sky-500/30 bg-sky-500/10 text-white" : "text-slate-400"].join(" ")}>
                    {item}
                  </div>
                ))}
              </div>
            </aside>

            {/* Main content */}
            <section className="grid gap-3">
              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-xl border border-white/8 bg-[#0a1628] p-3">
                  <div className="text-xs text-slate-400">AI Usage Overview</div>
                  <div className="mt-1.5 flex items-end justify-between">
                    <div>
                      <div className="text-3xl font-semibold text-white">1.6M</div>
                      <div className="text-[10px] text-slate-500">Monthly requests</div>
                    </div>
                    <div className="flex h-12 items-end gap-1">
                      {[26,34,30,46,52,48,58,63].map((h, i) => (
                        <div key={i} className="w-2 rounded-t bg-sky-400/70" style={{ height: `${h}%` }} />
                      ))}
                    </div>
                  </div>
                </div>
                <div className="rounded-xl border border-white/8 bg-[#0a1628] p-3">
                  <div className="text-xs text-slate-400">Cost Overview</div>
                  <div className="mt-1.5 text-2xl font-semibold text-white">$2,771</div>
                  <div className="mt-2 flex h-10 items-end gap-1">
                    {[20,28,26,39,48,44,58].map((h, i) => (
                      <div key={i} className="flex-1 rounded-t bg-sky-500/60" style={{ height: `${h}%` }} />
                    ))}
                  </div>
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-xl border border-white/8 bg-[#0a1628] p-3">
                  <div className="mb-2 text-xs text-slate-400">Flat sources</div>
                  <div className="space-y-2">
                    {[["Acme Corp","89,576","$1,046"],["Global Ventures","58,017","$842"],["Innovate Ltd.","22,176","$541"]].map(([name,req,cost]) => (
                      <div key={name} className="grid grid-cols-[1fr_auto_auto] items-center gap-3 text-xs">
                        <span className="text-slate-200">{name}</span>
                        <span className="text-slate-400">{req}</span>
                        <span className="text-slate-300">{cost}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="rounded-xl border border-white/8 bg-[#0a1628] p-3">
                  <div className="mb-2 text-xs text-slate-400">Audit Logs</div>
                  <div className="space-y-2 text-xs">
                    {[["Policy updated","2m ago"],["New member invited","5m ago"],["Knowledge source added","12m ago"]].map(([item, time]) => (
                      <div key={item} className="flex items-center justify-between">
                        <span className="text-slate-200">{item}</span>
                        <span className="text-slate-500">{time}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>

    </div>
  );
}
