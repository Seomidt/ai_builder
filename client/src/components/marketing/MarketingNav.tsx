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

          <nav className="hidden items-center gap-8 text-sm text-slate-400 md:flex">
            <a href="#product" className="transition-colors hover:text-white">Product</a>
            <a href="#security" className="transition-colors hover:text-white">Security</a>
            <a href="#contact" className="transition-colors hover:text-white">Contact</a>
            <Link href="/blog" className="transition-colors hover:text-white" data-testid="link-nav-blog">Blog</Link>
          </nav>

          <Link
            href="/early-access"
            className="inline-flex items-center gap-1 rounded-lg border border-sky-500/50 bg-sky-500/15 px-3 py-1.5 text-xs font-medium text-sky-300 transition hover:border-sky-400/70 hover:bg-sky-500/25 hover:text-white"
            data-testid="link-nav-early-access"
          >
            Get Early Access <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
        <div className="h-px bg-white/[0.06]" />
      </div>
    </header>
  );
}
