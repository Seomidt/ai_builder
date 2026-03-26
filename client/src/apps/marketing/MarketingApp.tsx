/**
 * MarketingApp — Public/Marketing Surface
 *
 * Rendered exclusively on blissops.com and www.blissops.com.
 *
 * Rules:
 *   - NO authenticated app shell
 *   - NO sidebar (TenantSidebar or AdminSidebar)
 *   - NO tenant or admin routes registered here
 *   - Auth routes (/auth/*) redirect to app.blissops.com/auth/*
 *   - Primary CTA = early access signup (pre-launch)
 *
 * SECURITY:
 *   - This surface has no access to private data
 *   - No session checks required — entirely public
 *   - Hostname is NOT trusted for authorization
 */

import { useEffect } from "react";
import { Switch, Route, useLocation, Link } from "wouter";
import { ArrowRight } from "lucide-react";
import { redirectAuthToTenantApp } from "@/lib/runtime/urls";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingHeroPreview } from "@/components/marketing/MarketingHeroPreview";
import { MarketingSecurityPanel } from "@/components/marketing/MarketingSecurityPanel";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";

const capabilities = [
  {
    icon: "⌂",
    title: "AI assistants on your data",
    text: "Ground AI on your documents, knowledge base and internal systems — keeping context accurate and private.",
  },
  {
    icon: "$",
    title: "Predictable AI usage and cost",
    text: "Track usage with built-in guardrails and clear visibility into how AI is used across your organization.",
  },
  {
    icon: "▣",
    title: "Tenant-isolated architecture",
    text: "Structured for secure organizational separation across teams, workspaces and data access boundaries.",
  },
  {
    icon: "🔒",
    title: "Access control and permissions",
    text: "Support granular roles, scoped permissions and governance-ready access management.",
  },
  {
    icon: "☰",
    title: "Audit logs and governance",
    text: "Maintain visibility into activity, access and changes with audit-friendly operational control.",
  },
];

/** Intercept /auth/* on marketing host and send to tenant app */
function AuthRedirect() {
  const [location] = useLocation();
  useEffect(() => {
    redirectAuthToTenantApp(location);
  }, [location]);
  return (
    <div className="flex items-center justify-center h-screen bg-[#030711]">
      <div className="text-center space-y-2">
        <div className="h-5 w-5 rounded-full border-2 border-sky-400 border-t-transparent animate-spin mx-auto" />
        <p className="text-sm text-slate-400">Redirecting to login…</p>
      </div>
    </div>
  );
}

function MarketingHome() {
  return (
    <main className="min-h-screen bg-[#030711] text-white overflow-x-hidden">
      {/* ── Fixed background layers ─────────────────────────────────── */}
      <div className="pointer-events-none fixed inset-0 z-0">
        {/* Deep blue radial glows */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_20%_20%,rgba(30,64,175,0.25),transparent_40%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_75%_10%,rgba(56,189,248,0.15),transparent_30%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_80%,rgba(14,165,233,0.12),transparent_35%)]" />
        {/* Subtle star dots using box-shadow trick via pseudo-element alternative */}
        <div
          className="absolute inset-0 opacity-30"
          style={{
            backgroundImage:
              "radial-gradient(circle, rgba(255,255,255,0.8) 1px, transparent 1px)",
            backgroundSize: "80px 80px",
            backgroundPosition: "0 0, 40px 40px",
          }}
        />
        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(3,7,17,0.3)_0%,rgba(3,7,17,0.7)_100%)]" />
      </div>

      <div className="relative z-10 pb-16">
        <MarketingNav />

        <section className="mx-auto mt-10 grid max-w-[1440px] gap-6 px-6 md:px-8 xl:grid-cols-[1.55fr_0.75fr]">
          {/* ── Left main column ─────────────────────────────────────── */}
          <div className="overflow-visible rounded-[30px] border border-white/10 bg-slate-950/50 px-6 pb-8 pt-10 backdrop-blur-xl md:px-10 md:pt-14">

            {/* Hero text */}
            <div className="mx-auto max-w-4xl text-center">
              <h1 className="mx-auto max-w-4xl text-5xl font-semibold tracking-tight text-white md:text-7xl">
                Control AI Across
                <br />
                Your Organization
              </h1>

              <p className="mx-auto mt-8 max-w-3xl text-xl leading-9 text-slate-300">
                Full control of AI usage, cost and access — across your organization.
              </p>

              <div className="mt-8">
                <Link
                  href="/early-access"
                  className="inline-flex items-center gap-2 rounded-2xl border border-sky-400/30 bg-slate-950/90 px-8 py-4 text-lg font-medium text-white shadow-[0_0_20px_rgba(59,130,246,0.24)] transition hover:border-sky-300/50 hover:shadow-[0_0_28px_rgba(59,130,246,0.28)]"
                  data-testid="link-hero-early-access"
                >
                  Join Early Access <ArrowRight className="h-5 w-5" />
                </Link>
              </div>

              {/* App preview mock — floating cards extend beyond this container intentionally */}
              <div className="overflow-visible">
                <MarketingHeroPreview />
              </div>
            </div>

            {/* Platform capabilities */}
            <div id="product" className="mx-auto mt-32 max-w-5xl">
              <div className="text-center text-[12px] uppercase tracking-[0.35em] text-sky-400/75">
                Platform capabilities
              </div>

              <h2 className="mt-6 text-center text-4xl font-semibold tracking-tight text-white md:text-5xl">
                Everything you need to run AI securely
              </h2>

              <div className="mt-12 grid gap-8 md:grid-cols-2 xl:grid-cols-3">
                {capabilities.map((item) => (
                  <div key={item.title} className="flex gap-4">
                    <div className="mt-1 grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-sky-400/20 bg-slate-950/80 text-sky-300 text-lg">
                      {item.icon}
                    </div>
                    <div>
                      <div className="text-xl font-medium text-white">{item.title}</div>
                      <div className="mt-2 text-sm leading-6 text-slate-400">{item.text}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <MarketingFooter />
          </div>

          {/* ── Right security panel ─────────────────────────────────── */}
          <MarketingSecurityPanel />
        </section>
      </div>
    </main>
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
