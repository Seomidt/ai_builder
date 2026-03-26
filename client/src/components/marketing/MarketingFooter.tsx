import { Link } from "wouter";
import { ArrowRight } from "lucide-react";
import { MarketingLogo } from "./MarketingLogo";

export function MarketingFooter() {
  return (
    <footer
      id="contact"
      className="mt-16 rounded-2xl border border-white/10 bg-[#060d1f]/60 p-6 backdrop-blur-xl"
    >
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Left: logo + description */}
        <div className="rounded-xl border border-white/8 bg-[#0a1628]/60 p-5">
          <MarketingLogo small />
          <p className="mt-4 text-sm leading-6 text-slate-400">
            BlissOps is in private rollout. Be among the first to gain access and help shape the platform.
          </p>
          <div className="mt-3 flex flex-wrap gap-4 text-xs text-slate-300">
            {["Limited rollout","No spam","Priority onboarding"].map((item) => (
              <span key={item} className="flex items-center gap-1">
                <span className="text-sky-400">✓</span> {item}
              </span>
            ))}
          </div>
          <div className="mt-5 text-xs text-slate-500">© 2026 BlissOps. All rights reserved.</div>
        </div>

        {/* Right: email input + nav links */}
        <div className="flex flex-col gap-5">
          <div className="rounded-xl border border-white/8 bg-[#0a1628]/60 p-4">
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="email"
                placeholder="Enter your work email"
                className="h-11 flex-1 rounded-xl border border-white/10 bg-[#060d1f] px-4 text-sm text-white placeholder:text-slate-500 outline-none focus:border-sky-500/40"
                data-testid="input-footer-email"
              />
              <Link
                href="/early-access"
                className="inline-flex h-11 items-center justify-center gap-1.5 rounded-xl border border-sky-500/40 bg-[#060d1f] px-5 text-sm font-medium text-white shadow-[0_0_16px_rgba(56,189,248,0.15)] transition hover:border-sky-400/60 whitespace-nowrap"
              >
                Join Early Access <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-6 px-1">
            {[
              { title: "Product", items: ["Overview","Features","How it works","Use cases"] },
              { title: "Security", items: ["Security","Compliance","Data privacy","Architecture"] },
              { title: "Company", items: ["About","Contact","Privacy Policy","Terms"] },
            ].map((col) => (
              <div key={col.title}>
                <div className="mb-3 text-sm font-semibold text-white">{col.title}</div>
                <div className="space-y-2">
                  {col.items.map((item) => (
                    <div key={item} className="text-xs text-slate-400 transition hover:text-slate-200 cursor-pointer">{item}</div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}
