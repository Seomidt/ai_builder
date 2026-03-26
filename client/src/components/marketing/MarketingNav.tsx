import { Link } from "wouter";
import { ArrowRight } from "lucide-react";
import { MarketingLogo } from "./MarketingLogo";

export function MarketingNav() {
  return (
    <header className="sticky top-0 z-30">
      <div className="mx-auto max-w-[1440px] px-6 pt-6 md:px-8">
        <div className="rounded-2xl border border-white/10 bg-slate-950/70 backdrop-blur-xl">
          <div className="flex items-center justify-between px-5 py-4 md:px-7">
            <Link href="/" className="block">
              <MarketingLogo />
            </Link>

            <nav className="hidden items-center gap-10 text-sm text-slate-300 md:flex">
              <a href="#product" className="transition hover:text-white">
                Product
              </a>
              <a href="#security" className="transition hover:text-white">
                Security
              </a>
            </nav>

            <Link
              href="/early-access"
              className="inline-flex items-center gap-2 rounded-xl border border-sky-400/30 bg-slate-950/80 px-5 py-3 text-sm font-medium text-white shadow-[0_0_20px_rgba(59,130,246,0.2)] transition hover:border-sky-300/50 hover:shadow-[0_0_28px_rgba(59,130,246,0.28)]"
            >
              Join Early Access <ArrowRight className="h-4 w-4" />
            </Link>
          </div>

          <div className="h-px bg-white/10" />
        </div>
      </div>
    </header>
  );
}
