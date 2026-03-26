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
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { redirectAuthToTenantApp } from "@/lib/runtime/urls";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingHeroPreview } from "@/components/marketing/MarketingHeroPreview";
import { MarketingSecurityPanel } from "@/components/marketing/MarketingSecurityPanel";
import { MarketingCapabilities } from "@/components/marketing/MarketingCapabilities";
import { MarketingEarlyAccessBlock } from "@/components/marketing/MarketingEarlyAccessBlock";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import EarlyAccessPage from "@/pages/marketing/EarlyAccessPage";

const trustItems = ["SOC 2 ready", "GDPR readiness", "EU data residency", "Tenant-isolated"];

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
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: [
              "radial-gradient(circle, rgba(255,255,255,0.75) 1px, transparent 1px)",
              "radial-gradient(circle, rgba(255,255,255,0.5) 1px, transparent 1px)",
            ].join(","),
            backgroundSize: "120px 120px, 60px 60px",
            backgroundPosition: "0 0, 30px 30px",
            opacity: 0.18,
          }}
        />
        <div className="absolute left-1/4 top-0 h-[500px] w-[600px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(30,64,175,0.35),transparent_65%)] blur-2xl" />
        <div className="absolute right-0 top-1/4 h-[400px] w-[400px] rounded-full bg-[radial-gradient(circle,rgba(56,189,248,0.10),transparent_65%)] blur-2xl" />
        <div className="absolute bottom-0 left-1/2 h-[300px] w-[500px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(14,165,233,0.08),transparent_65%)] blur-2xl" />
        <div className="absolute inset-0 bg-[#030711]/50" />
      </div>

      {/* ── Page content ───────────────────────────────────────────────── */}
      <div className="relative z-10">
        <MarketingNav />

        {/* Two-column grid */}
        <div className="mx-auto mt-6 grid max-w-[1440px] gap-5 px-6 pb-16 md:px-8 xl:grid-cols-[1fr_360px]">

          {/* ── Left column ── */}
          <div className="relative min-h-0">
            {/* Glass panel background */}
            <div className="pointer-events-none absolute inset-0 rounded-[28px] border border-white/10 bg-[#060d1f]/50 backdrop-blur-2xl" />

            {/* Content */}
            <div className="relative z-10 overflow-visible px-6 pt-10 pb-10 md:px-10 md:pt-14">

              {/* Hero */}
              <div className="mx-auto max-w-2xl text-center">
                <h1 className="text-5xl font-semibold leading-[1.1] tracking-tight text-white md:text-6xl lg:text-7xl">
                  Control AI Across<br />Your Organization
                </h1>

                <p className="mx-auto mt-6 max-w-lg text-lg leading-8 text-slate-300">
                  Full control of AI usage, cost and access — across your organization.
                </p>

                {/* Primary CTA */}
                <div className="mt-8 flex justify-center">
                  <Link
                    href="/early-access"
                    className="inline-flex items-center gap-2 rounded-xl border border-sky-500/40 bg-[#060d1f]/80 px-7 py-3.5 text-base font-medium text-white transition hover:border-sky-400/60 hover:bg-sky-500/10"
                    data-testid="link-hero-primary-cta"
                  >
                    Get Early Access <ArrowRight className="h-4 w-4" />
                  </Link>
                </div>

                {/* Trust signals */}
                <div className="mt-7 flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
                  {trustItems.map((item) => (
                    <span key={item} className="flex items-center gap-1.5 text-xs text-slate-400">
                      <CheckCircle2 className="h-3.5 w-3.5 text-sky-400/70" />
                      {item}
                    </span>
                  ))}
                </div>
              </div>

              {/* App preview */}
              <MarketingHeroPreview />

              {/* Platform capabilities */}
              <MarketingCapabilities />

              {/* Early access capture */}
              <MarketingEarlyAccessBlock />
            </div>
          </div>

          {/* ── Right column (Security panel) ── */}
          <MarketingSecurityPanel />
        </div>

        {/* ── Footer — always at the very bottom ── */}
        <div className="mx-auto max-w-[1440px] px-6 md:px-8">
          <MarketingFooter />
        </div>
      </div>
    </div>
  );
}

export function MarketingApp() {
  return (
    <Switch>
      <Route path="/auth/:rest*" component={AuthRedirect} />
      <Route path="/early-access" component={EarlyAccessPage} />
      <Route component={MarketingHome} />
    </Switch>
  );
}
