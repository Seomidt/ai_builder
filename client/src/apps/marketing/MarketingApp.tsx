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
import { Switch, Route, useLocation } from "wouter";
import { Link } from "wouter";
import { redirectAuthToTenantApp } from "@/lib/runtime/urls";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingHeroPreview } from "@/components/marketing/MarketingHeroPreview";
import { MarketingSecurityPanel } from "@/components/marketing/MarketingSecurityPanel";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";

const capabilities = [
  {
    title: "AI assistants on your data",
    text: "Ground AI on your documents, knowledge base and internal systems — keeping context accurate and private.",
  },
  {
    title: "Predictable AI usage and cost",
    text: "Track usage with built-in guardrails and clear visibility into how AI is used across your organization.",
  },
  {
    title: "Tenant-isolated architecture",
    text: "Structured for secure organizational separation across teams, workspaces and data access boundaries.",
  },
  {
    title: "Access control and permissions",
    text: "Support granular roles, scoped permissions and governance-ready access management.",
  },
  {
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
    <main className="min-h-screen bg-[#030711] text-white">
      <div className="pointer-events-none fixed inset-0 opacity-70">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(30,64,175,0.16),transparent_30%),radial-gradient(circle_at_75%_25%,rgba(59,130,246,0.12),transparent_24%),radial-gradient(circle_at_50%_90%,rgba(14,165,233,0.1),transparent_26%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(2,6,23,0.5),rgba(2,6,23,0.9))]" />
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='1600' height='1000' fill='none'><g opacity='0.22'><circle cx='120' cy='110' r='1.2' fill='white'/><circle cx='320' cy='140' r='1.1' fill='white'/><circle cx='580' cy='90' r='1.3' fill='white'/><circle cx='960' cy='180' r='1.1' fill='white'/><circle cx='1260' cy='120' r='1.2' fill='white'/><circle cx='800' cy='60' r='1.0' fill='white'/><circle cx='1480' cy='200' r='1.1' fill='white'/></g></svg>\")",
          }}
        />
      </div>

      <div className="relative pb-16">
        <MarketingNav />

        <section className="mx-auto mt-10 grid max-w-[1440px] gap-6 px-6 md:px-8 xl:grid-cols-[1.55fr_0.75fr]">
          <div className="rounded-[30px] border border-white/10 bg-slate-950/50 px-6 pb-8 pt-10 backdrop-blur-xl md:px-10 md:pt-14">
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
                  className="inline-flex items-center rounded-2xl border border-sky-400/30 bg-slate-950/90 px-8 py-4 text-lg font-medium text-white shadow-[0_0_20px_rgba(59,130,246,0.24)] transition hover:border-sky-300/50 hover:shadow-[0_0_28px_rgba(59,130,246,0.28)]"
                  data-testid="link-hero-early-access"
                >
                  Join Early Access
                </Link>
              </div>

              <MarketingHeroPreview />
            </div>

            <div id="product" className="mx-auto mt-20 max-w-5xl">
              <div className="text-center text-[12px] uppercase tracking-[0.35em] text-sky-400/75">
                Platform capabilities
              </div>

              <h2 className="mt-6 text-center text-4xl font-semibold tracking-tight text-white md:text-5xl">
                Everything you need to run AI securely
              </h2>

              <div className="mt-12 grid gap-8 md:grid-cols-2 xl:grid-cols-3">
                {capabilities.map((item, idx) => (
                  <div key={item.title} className="flex gap-4">
                    <div className="mt-1 grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-sky-400/20 bg-slate-950/80 text-sky-300 text-lg">
                      {idx === 0 && "⌂"}
                      {idx === 1 && "$"}
                      {idx === 2 && "▣"}
                      {idx === 3 && "🔒"}
                      {idx === 4 && "☰"}
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
