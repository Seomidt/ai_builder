import { Link } from "wouter";
import { MarketingLogo } from "./MarketingLogo";

const earlyAccessBullets = ["Limited rollout", "No spam", "Priority onboarding"];

export function MarketingFooter() {
  return (
    <footer
      id="contact"
      className="mt-12 rounded-[26px] border border-white/10 bg-slate-950/72 p-8 backdrop-blur-xl"
    >
      <div className="grid gap-8 lg:grid-cols-[1.2fr_1fr]">
        <div className="rounded-2xl border border-white/10 bg-slate-950/60 p-6">
          <MarketingLogo small />

          <p className="mt-6 max-w-md text-base leading-7 text-slate-400">
            BlissOps is in private rollout. Be among the first to gain access and help shape the platform.
          </p>

          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm text-slate-300">
            {earlyAccessBullets.map((item) => (
              <span key={item}>✓ {item}</span>
            ))}
          </div>

          <div className="mt-6 text-sm text-slate-500">© 2026 BlissOps. All rights reserved.</div>
        </div>

        <div className="flex flex-col justify-between gap-6">
          <div className="rounded-2xl border border-white/10 bg-slate-950/60 p-5">
            <div className="flex flex-col gap-3 sm:flex-row">
              <input
                type="email"
                placeholder="Enter your work email"
                className="h-12 flex-1 rounded-xl border border-white/10 bg-slate-950 px-4 text-white placeholder:text-slate-500 outline-none ring-0"
                data-testid="input-footer-email"
              />

              <Link
                href="/early-access"
                className="inline-flex h-12 items-center justify-center rounded-xl border border-sky-400/30 bg-slate-950 px-6 text-sm font-medium text-white shadow-[0_0_18px_rgba(59,130,246,0.18)] transition hover:border-sky-300/50"
              >
                Join Early Access
              </Link>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-8 px-1">
            <div>
              <div className="mb-3 text-lg font-medium text-white">Product</div>
              <div className="space-y-2 text-sm text-slate-400">
                <div>Overview</div>
                <div>Features</div>
                <div>How it works</div>
                <div>Use cases</div>
              </div>
            </div>

            <div>
              <div className="mb-3 text-lg font-medium text-white">Security</div>
              <div className="space-y-2 text-sm text-slate-400">
                <div>Security</div>
                <div>Compliance</div>
                <div>Data privacy</div>
                <div>Architecture</div>
              </div>
            </div>

            <div>
              <div className="mb-3 text-lg font-medium text-white">Company</div>
              <div className="space-y-2 text-sm text-slate-400">
                <div>About</div>
                <div>Contact</div>
                <div>Privacy Policy</div>
                <div>Terms</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
