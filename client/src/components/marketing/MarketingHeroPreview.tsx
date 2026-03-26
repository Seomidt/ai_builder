export function MarketingHeroPreview() {
  return (
    <div className="relative mx-auto mt-12 w-full max-w-3xl pb-4 md:pb-28">
      {/* Glow behind preview */}
      <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-[500px] w-[700px] rounded-full bg-[radial-gradient(circle,rgba(56,189,248,0.12),transparent_60%)] blur-3xl" />

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
              <span className="hidden rounded-full border border-sky-500/20 bg-sky-500/10 px-2 py-0.5 text-[10px] text-sky-300 sm:inline">Private rollout</span>
            </div>
          </div>

          {/* Preview layout — sidebar hidden on mobile */}
          <div className="grid gap-3 md:grid-cols-[160px_1fr]">
            {/* Sidebar — desktop only */}
            <aside className="hidden rounded-xl border border-white/8 bg-[#0a1628] p-3 md:block">
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
              <div className="grid gap-3 grid-cols-2">
                <div className="rounded-xl border border-white/8 bg-[#0a1628] p-3">
                  <div className="text-xs text-slate-400">AI Usage</div>
                  <div className="mt-1.5 flex items-end justify-between">
                    <div>
                      <div className="text-2xl font-semibold text-white">1.6M</div>
                      <div className="text-[10px] text-slate-500">Monthly requests</div>
                    </div>
                    <div className="flex h-10 items-end gap-0.5">
                      {[26,34,30,46,52,48,58,63].map((h, i) => (
                        <div key={i} className="w-1.5 rounded-t bg-sky-400/60" style={{ height: `${h}%` }} />
                      ))}
                    </div>
                  </div>
                </div>
                <div className="rounded-xl border border-white/8 bg-[#0a1628] p-3">
                  <div className="text-xs text-slate-400">Cost</div>
                  <div className="mt-1.5 text-2xl font-semibold text-white">$2,771</div>
                  <div className="mt-2 flex h-8 items-end gap-0.5">
                    {[20,28,26,39,48,44,58].map((h, i) => (
                      <div key={i} className="flex-1 rounded-t bg-sky-500/50" style={{ height: `${h}%` }} />
                    ))}
                  </div>
                </div>
              </div>

              <div className="grid gap-3 grid-cols-2">
                <div className="hidden rounded-xl border border-white/8 bg-[#0a1628] p-3 sm:block">
                  <div className="mb-2 text-xs text-slate-400">Tenant sources</div>
                  <div className="space-y-2">
                    {[["Acme Corp","89,576","$1,046"],["Global Ventures","58,017","$842"],["Innovate Ltd.","22,176","$541"]].map(([name,req,cost]) => (
                      <div key={name} className="grid grid-cols-[1fr_auto_auto] items-center gap-2 text-xs">
                        <span className="truncate text-slate-200">{name}</span>
                        <span className="text-slate-400">{req}</span>
                        <span className="text-slate-300">{cost}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="rounded-xl border border-white/8 bg-[#0a1628] p-3">
                  <div className="mb-2 text-xs text-slate-400">Audit Logs</div>
                  <div className="space-y-2 text-xs">
                    {[["Policy updated","2m ago"],["Member invited","5m ago"],["Source added","12m ago"]].map(([item, time]) => (
                      <div key={item} className="flex items-center justify-between gap-2">
                        <span className="truncate text-slate-200">{item}</span>
                        <span className="shrink-0 text-slate-500">{time}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>

      {/* Floating card: AI Usage — desktop only */}
      <div className="pointer-events-none absolute -right-6 top-6 hidden w-[190px] md:block">
        {/* Separate bg div to avoid backdrop-blur clipping content */}
        <div className="absolute inset-0 rounded-2xl border border-sky-400/20 bg-[#060d1f]/95 backdrop-blur-md" />
        <div className="relative z-10 overflow-visible p-4">
          <div className="text-[10px] text-slate-400">AI Usage</div>
          <div className="mt-2 grid grid-cols-3 gap-1 text-white">
            {[["184","Teams"],["2380","Sources"],["$5.9K","Monthly"]].map(([val, label]) => (
              <div key={label}>
                <div className="text-base font-semibold leading-tight">{val}</div>
                <div className="text-[9px] text-slate-500">{label}</div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex h-14 items-end gap-1">
            {[20,34,29,45,40,54,66,78].map((h, i) => (
              <div key={i} className="flex-1 rounded-t bg-sky-300/70" style={{ height: `${h}%` }} />
            ))}
          </div>
        </div>
      </div>

      {/* Floating card: Cost Guardrails — desktop only */}
      <div className="pointer-events-none absolute -bottom-10 left-4 hidden w-[210px] md:block">
        <div className="absolute inset-0 rounded-2xl border border-sky-400/20 bg-[#060d1f]/95 backdrop-blur-md" />
        <div className="relative z-10 overflow-visible p-4">
          <div className="text-[10px] text-slate-400">Cost Guardrails</div>
          <div className="mt-3 space-y-3">
            <div>
              <div className="mb-1 flex justify-between text-[10px] text-slate-300">
                <span>Monthly budget</span><span>68%</span>
              </div>
              <div className="h-1.5 rounded-full bg-slate-800">
                <div className="h-1.5 w-[68%] rounded-full bg-sky-400" />
              </div>
            </div>
            <div>
              <div className="mb-1 flex justify-between text-[10px] text-slate-300">
                <span>AI route protection</span><span>Active</span>
              </div>
              <div className="h-1.5 rounded-full bg-slate-800">
                <div className="h-1.5 w-[92%] rounded-full bg-emerald-400" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
