import { Link } from "wouter";
import { ArrowRight } from "lucide-react";
import { MarketingLogo } from "./MarketingLogo";

export function MarketingNav() {
  return (
    <header className="sticky top-0 z-40 px-6 pt-5 md:px-8">
      <div className="rounded-2xl border border-white/10 bg-[#060d1f]/80 backdrop-blur-2xl shadow-[0_4px_32px_rgba(0,0,0,0.4)]">
        <div className="flex items-center justify-between px-5 py-3.5 md:px-6">
          <Link href="/" className="block shrink-0">
            <MarketingLogo />
          </Link>

          <nav className="hidden items-center gap-8 text-sm text-slate-300 md:flex">
            <a href="#product" className="transition-colors hover:text-white">Product</a>
            <a href="#security" className="transition-colors hover:text-white">Security</a>
          </nav>

          <Link
            href="/early-access"
            className="inline-flex items-center gap-1.5 rounded-xl border border-sky-500/40 bg-[#060d1f]/80 px-4 py-2.5 text-sm font-medium text-white shadow-[0_0_18px_rgba(56,189,248,0.18)] transition hover:border-sky-400/60 hover:shadow-[0_0_26px_rgba(56,189,248,0.28)]"
            data-testid="link-nav-early-access"
          >
            Join Early Access <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
        <div className="h-px bg-white/[0.06]" />
      </div>
    </header>
  );
}
