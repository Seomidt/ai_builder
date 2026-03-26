import { Link } from "wouter";
import { ArrowRight } from "lucide-react";

export function MarketingEarlyAccessBlock() {
  return (
    <div className="mt-16 rounded-2xl border border-white/8 bg-[#0a1628]/40 p-8">
      <div className="mx-auto max-w-lg text-center">
        <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.3em] text-sky-400/70">
          Early access
        </div>
        <h3 className="mt-3 text-2xl font-semibold tracking-tight text-white">
          Private rollout for selected organizations
        </h3>
        <p className="mt-3 text-sm leading-6 text-slate-400">
          Be among the first to gain access and help shape the platform.
        </p>

        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <input
            type="email"
            placeholder="Work email"
            className="h-11 flex-1 rounded-xl border border-white/10 bg-[#060d1f] px-4 text-sm text-white placeholder:text-slate-500 outline-none focus:border-sky-500/30 sm:max-w-[240px]"
            data-testid="input-ea-block-email"
          />
          <Link
            href="/early-access"
            className="inline-flex h-11 items-center justify-center gap-1.5 rounded-xl border border-sky-500/35 bg-[#060d1f] px-5 text-sm font-medium text-white transition hover:border-sky-400/55 hover:bg-sky-500/8 whitespace-nowrap"
            data-testid="link-ea-block-cta"
          >
            Get Early Access <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>

        <p className="mt-4 text-xs text-slate-500">
          No spam · Priority onboarding · Limited seats
        </p>
      </div>
    </div>
  );
}
