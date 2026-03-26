export function MarketingHeroPreview() {
  return (
    <div className="relative mx-auto mt-14 w-full max-w-4xl">
      <div className="pointer-events-none absolute -inset-8 bg-[radial-gradient(circle_at_center,rgba(59,130,246,0.16),transparent_58%)] blur-2xl" />

      <div className="relative rounded-[26px] border border-white/10 bg-slate-950/85 p-3 shadow-[0_40px_120px_rgba(0,0,0,0.6)] backdrop-blur-md md:p-4">
        <div className="rounded-[20px] border border-sky-400/15 bg-slate-950/90 p-4 md:p-5">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="grid h-8 w-8 place-items-center rounded-lg border border-sky-400/20 bg-slate-950/80">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle cx="12" cy="4.5" r="2.2" fill="#38BDF8" />
                  <circle cx="5.25" cy="18" r="2.2" fill="#60A5FA" />
                  <circle cx="18.75" cy="18" r="2.2" fill="#F59E0B" />
                  <path
                    d="M12 6.8L6.8 16.1M12 6.8L17.2 16.1M7.7 18h8.6"
                    stroke="#93C5FD"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </div>

              <div>
                <div className="text-sm font-medium text-white">BlissOps</div>
                <div className="text-[11px] text-slate-400">AI Infrastructure Platform</div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2.5 py-1 text-[11px] text-emerald-300">
                Demo tenant
              </span>
              <span className="rounded-full border border-sky-400/20 bg-sky-400/10 px-2.5 py-1 text-[11px] text-sky-300">
                Private rollout
              </span>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-[220px_1fr]">
            <aside className="rounded-2xl border border-white/10 bg-slate-950/80 p-4">
              <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">
                Core
              </div>

              <div className="space-y-2 text-sm">
                {[
                  "AI Chat",
                  "Experts",
                  "Storage",
                  "Team",
                  "Permissions",
                  "Usage",
                  "AI Operations",
                  "Logs",
                  "Billing",
                ].map((item, idx) => (
                  <div
                    key={item}
                    className={[
                      "rounded-xl px-3 py-2",
                      idx === 0
                        ? "border border-sky-400/30 bg-sky-400/10 text-white"
                        : "text-slate-400",
                    ].join(" ")}
                  >
                    {item}
                  </div>
                ))}
              </div>
            </aside>

            <section className="grid gap-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-2xl border border-white/10 bg-slate-950/80 p-4">
                  <div className="text-sm text-slate-400">AI Usage Overview</div>

                  <div className="mt-2 flex items-end justify-between">
                    <div>
                      <div className="text-4xl font-semibold text-white">1.6M</div>
                      <div className="text-xs text-slate-500">Monthly requests</div>
                    </div>

                    <div className="h-16 w-36 rounded-xl bg-[linear-gradient(180deg,rgba(59,130,246,0.12),rgba(59,130,246,0.02))] p-2">
                      <div className="flex h-full items-end gap-1.5">
                        {[26, 34, 30, 46, 52, 48, 58, 63].map((h, i) => (
                          <div
                            key={i}
                            className="flex-1 rounded-t bg-sky-400/80"
                            style={{ height: `${h}%` }}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-white/10 bg-slate-950/80 p-4">
                  <div className="text-sm text-slate-400">Cost Overview</div>
                  <div className="mt-2 text-3xl font-semibold text-white">$2,771</div>

                  <div className="mt-4 flex h-16 items-end gap-2">
                    {[20, 28, 26, 39, 48, 44, 58].map((h, i) => (
                      <div
                        key={i}
                        className="flex-1 rounded-t bg-sky-500/75"
                        style={{ height: `${h}%` }}
                      />
                    ))}
                  </div>
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-[1.1fr_0.9fr]">
                <div className="rounded-2xl border border-white/10 bg-slate-950/80 p-4">
                  <div className="mb-3 text-sm text-slate-400">Tenant Usage</div>

                  <div className="space-y-3">
                    {[
                      ["Acme Corp", "89,576", "$1,046"],
                      ["Global Ventures", "58,017", "$842"],
                      ["Innovate Ltd.", "22,176", "$541"],
                    ].map(([name, req, cost]) => (
                      <div
                        key={name}
                        className="grid grid-cols-[1fr_auto_auto] items-center gap-4 text-sm"
                      >
                        <span className="text-slate-200">{name}</span>
                        <span className="text-slate-400">{req}</span>
                        <span className="text-slate-300">{cost}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-2xl border border-white/10 bg-slate-950/80 p-4">
                  <div className="mb-3 text-sm text-slate-400">Audit Logs</div>

                  <div className="space-y-3 text-sm">
                    {[
                      "Policy updated",
                      "New member invited",
                      "Knowledge source added",
                    ].map((item) => (
                      <div key={item} className="flex items-center justify-between">
                        <span className="text-slate-200">{item}</span>
                        <span className="text-slate-500">2m ago</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>

      <div className="absolute right-4 top-24 w-[320px] rounded-2xl border border-sky-300/20 bg-slate-950/82 p-4 shadow-[0_20px_60px_rgba(0,0,0,0.45)] backdrop-blur-md md:right-0 md:top-28">
        <div className="text-[13px] text-slate-400">AI Usage</div>

        <div className="mt-2 grid grid-cols-3 gap-2 text-white">
          <div>
            <div className="text-2xl font-semibold">184</div>
            <div className="text-[11px] text-slate-500">Teams</div>
          </div>
          <div>
            <div className="text-2xl font-semibold">2380</div>
            <div className="text-[11px] text-slate-500">Sources</div>
          </div>
          <div>
            <div className="text-2xl font-semibold">$5.9K</div>
            <div className="text-[11px] text-slate-500">Monthly</div>
          </div>
        </div>

        <div className="mt-4 flex h-24 items-end gap-2">
          {[20, 34, 29, 45, 40, 54, 66, 78].map((h, i) => (
            <div
              key={i}
              className="flex-1 rounded-t bg-sky-300/85"
              style={{ height: `${h}%` }}
            />
          ))}
        </div>
      </div>

      <div className="absolute bottom-4 left-8 w-[260px] rounded-2xl border border-sky-300/20 bg-slate-950/82 p-4 shadow-[0_20px_60px_rgba(0,0,0,0.45)] backdrop-blur-md">
        <div className="text-[13px] text-slate-400">Cost Guardrails</div>

        <div className="mt-3 space-y-3">
          <div>
            <div className="mb-1 flex justify-between text-[12px] text-slate-300">
              <span>Monthly budget</span>
              <span>68%</span>
            </div>
            <div className="h-2 rounded-full bg-slate-800">
              <div className="h-2 w-[68%] rounded-full bg-sky-400" />
            </div>
          </div>

          <div>
            <div className="mb-1 flex justify-between text-[12px] text-slate-300">
              <span>AI route protection</span>
              <span>Active</span>
            </div>
            <div className="h-2 rounded-full bg-slate-800">
              <div className="h-2 w-[92%] rounded-full bg-emerald-400" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
