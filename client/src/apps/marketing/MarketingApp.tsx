/**
 * MarketingApp — Public/Marketing Surface (blissops.com)
 *
 * Rules:
 *   - NO authenticated app shell / sidebar
 *   - Auth routes (/auth/*) → redirect to app.blissops.com/auth/*
 *   - Primary CTA = early access signup
 *
 * SECURITY: No private data. Entirely public. Hostname NOT trusted for authz.
 */

import { useEffect } from "react";
import { Switch, Route, Link, useLocation } from "wouter";
import { Lock, Eye, FolderLock, ShieldCheck, Building2, ArrowRight } from "lucide-react";
import { redirectAuthToTenantApp } from "@/lib/runtime/urls";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingHeroPreview } from "@/components/marketing/MarketingHeroPreview";
import { MarketingSecurityPanel } from "@/components/marketing/MarketingSecurityPanel";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";

const capabilities = [
  {
    icon: <Lock className="h-5 w-5" />,
    title: "AI assistants on your data",
    text: "Ground AI on your documents, knowledge base and internal systems — keeping context accurate and private.",
  },
  {
    icon: <ShieldCheck className="h-5 w-5" />,
    title: "Predictable AI usage and cost",
    text: "Track usage with built-in guardrails and clear visibility into how AI is used across your organization.",
  },
  {
    icon: <Building2 className="h-5 w-5" />,
    title: "Tenant-isolated architecture",
    text: "Structured for secure organizational separation across teams, workspaces and data access boundaries.",
  },
  {
    icon: <Eye className="h-5 w-5" />,
    title: "Access control and permissions",
    text: "Support granular roles, scoped permissions and governance-ready access management.",
  },
  {
    icon: <FolderLock className="h-5 w-5" />,
    title: "Audit logs and governance",
    text: "Maintain visibility into activity, access and changes with audit-friendly operational control.",
  },
];

function AuthRedirect() {
  const [location] = useLocation();
  useEffect(() => { redirectAuthToTenantApp(location); }, [location]);
  return (
    <div className="flex h-screen items-center justify-center bg-[#030711]">
      <div className="space-y-2 text-center">
        <div className="mx-auto h-5 w-5 animate-spin rounded-full border-2 border-sky-400 border-t-transparent" />
        <p className="text-sm text-slate-400">Redirecting…</p>
      </div>
    </div>
  );
}

function MarketingHome() {
  return (
    <div className="min-h-screen bg-[#030711] text-white">
      {/* ── Fixed background ───────────────────────────────────────────── */}
      <div className="pointer-events-none fixed inset-0 z-0" aria-hidden="true">
        {/* Stars: tiny white dots */}
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: [
              "radial-gradient(circle, rgba(255,255,255,0.75) 1px, transparent 1px)",
              "radial-gradient(circle, rgba(255,255,255,0.5) 1px, transparent 1px)",
            ].join(","),
            backgroundSize: "120px 120px, 60px 60px",
            backgroundPosition: "0 0, 30px 30px",
            opacity: 0.25,
          }}
        />
        {/* Blue glow top */}
        <div className="absolute left-1/4 top-0 h-[500px] w-[600px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(30,64,175,0.35),transparent_65%)] blur-2xl" />
        {/* Blue glow right */}
        <div className="absolute right-0 top-1/4 h-[400px] w-[400px] rounded-full bg-[radial-gradient(circle,rgba(56,189,248,0.12),transparent_65%)] blur-2xl" />
        {/* Bottom glow */}
        <div className="absolute bottom-0 left-1/2 h-[300px] w-[500px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(14,165,233,0.1),transparent_65%)] blur-2xl" />
        {/* Dark overlay to deepen blacks */}
        <div className="absolute inset-0 bg-[#030711]/50" />
      </div>

      {/* ── Page content ───────────────────────────────────────────────── */}
      <div className="relative z-10">
        <MarketingNav />

        {/* Two-column grid */}
        <div className="mx-auto mt-6 grid max-w-[1440px] gap-5 px-6 pb-16 md:px-8 xl:grid-cols-[1fr_380px]">

          {/* ── Left column ── */}
          {/*
            IMPORTANT: We use a relative wrapper + absolute glass background
            so that backdrop-blur never clips the HeroPreview floating cards.
          */}
          <div className="relative min-h-0">
            {/* Glass panel background (does NOT wrap content, so it can't clip it) */}
            <div className="pointer-events-none absolute inset-0 rounded-[28px] border border-white/10 bg-[#060d1f]/50 backdrop-blur-2xl" />

            {/* Actual content — z-10 so it sits above background, overflow-visible so cards show */}
            <div className="relative z-10 overflow-visible px-6 pt-8 pb-10 md:px-10 md:pt-12">

              {/* Hero */}
              <div className="mx-auto max-w-2xl text-center">
                <h1 className="text-5xl font-semibold leading-[1.1] tracking-tight text-white md:text-6xl lg:text-7xl">
                  Control AI Across<br />Your Organization
                </h1>

                <p className="mx-auto mt-6 max-w-lg text-lg leading-8 text-slate-300">
                  Full control of AI usage, cost and access — across your organization.
                </p>

                <div className="mt-8">
                  <Link
                    href="/early-access"
                    className="inline-flex items-center gap-2 rounded-2xl border border-sky-500/40 bg-[#060d1f]/80 px-8 py-4 text-base font-medium text-white shadow-[0_0_24px_rgba(56,189,248,0.2)] transition hover:border-sky-400/60 hover:shadow-[0_0_32px_rgba(56,189,248,0.3)]"
                    data-testid="link-hero-cta"
                  >
                    Join Early Access <ArrowRight className="h-4 w-4" />
                  </Link>
                </div>
              </div>

              {/* App preview mock */}
              <MarketingHeroPreview />

              {/* Platform capabilities */}
              <div id="product" className="mt-8 pt-4">
                <div className="text-center text-[11px] font-bold uppercase tracking-[0.3em] text-sky-400/80">
                  Platform capabilities
                </div>
                <h2 className="mt-4 text-center text-3xl font-semibold tracking-tight text-white md:text-4xl">
                  Everything you need to run AI securely
                </h2>

                <div className="mt-10 grid gap-6 md:grid-cols-2">
                  {capabilities.map((item) => (
                    <div key={item.title} className="flex gap-4">
                      <div className="mt-0.5 grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-sky-400/20 bg-[#0a1628] text-sky-300">
                        {item.icon}
                      </div>
                      <div>
                        <div className="text-base font-semibold text-white">{item.title}</div>
                        <div className="mt-1 text-sm leading-6 text-slate-400">{item.text}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <MarketingFooter />
            </div>
          </div>

          {/* ── Right column (Security panel) ── */}
          <MarketingSecurityPanel />
        </div>
      </div>
    </div>
  );
}

export function MarketingApp() {
  return (
    <Switch>
      <Route path="/auth/:rest*" component={AuthRedirect} />
      <Route component={MarketingHome} />
    </Switch>
  );
}
