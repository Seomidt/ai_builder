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
 *   - CTAs link to app.blissops.com for signup/login
 *
 * SECURITY:
 *   - This surface has no access to private data
 *   - No session checks required — entirely public
 *   - Hostname is NOT trusted for authorization
 */

import { useEffect } from "react";
import { Switch, Route, useLocation } from "wouter";
import { Cpu, ArrowRight, Shield, Zap, BarChart3, Globe } from "lucide-react";
import { getTenantLoginUrl, getTenantAppUrl, redirectAuthToTenantApp } from "@/lib/runtime/urls";

/** Intercept /auth/* on marketing host and send to tenant app */
function AuthRedirect() {
  const [location] = useLocation();
  useEffect(() => {
    redirectAuthToTenantApp(location);
  }, [location]);
  return (
    <div className="flex items-center justify-center h-screen bg-background">
      <div className="text-center space-y-2">
        <div className="h-5 w-5 rounded-full border-2 border-primary border-t-transparent animate-spin mx-auto" />
        <p className="text-sm text-muted-foreground">Viderestiller til login…</p>
      </div>
    </div>
  );
}

function FeatureCard({
  icon: Icon,
  title,
  description,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-6 space-y-3">
      <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-primary/10">
        <Icon className="w-5 h-5 text-primary" />
      </div>
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="text-sm text-muted-foreground leading-relaxed">{description}</p>
    </div>
  );
}

function MarketingLanding() {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Nav */}
      <header className="border-b border-border/50">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex items-center justify-center w-7 h-7 rounded-md bg-primary">
              <Cpu className="w-4 h-4 text-primary-foreground" />
            </div>
            <span className="text-sm font-semibold text-foreground tracking-wide">BlissOps</span>
          </div>
          <nav className="hidden md:flex items-center gap-6 text-sm text-muted-foreground">
            <a href="#features" className="hover:text-foreground transition-colors">Features</a>
            <a href="#about" className="hover:text-foreground transition-colors">Om os</a>
          </nav>
          <a
            href={getTenantLoginUrl()}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            data-testid="link-marketing-login"
          >
            Log ind
            <ArrowRight className="w-3.5 h-3.5" />
          </a>
        </div>
      </header>

      {/* Hero */}
      <section className="flex-1 flex flex-col items-center justify-center text-center px-6 py-24 max-w-4xl mx-auto w-full">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 text-primary text-xs font-medium mb-8 border border-primary/20">
          <Zap className="w-3 h-3" />
          AI Builder Platform
        </div>

        <h1 className="text-4xl md:text-5xl font-bold text-foreground leading-tight mb-6">
          Byg AI-drevne workflows
          <br />
          <span className="text-primary">uden at skrive kode</span>
        </h1>

        <p className="text-lg text-muted-foreground max-w-2xl leading-relaxed mb-10">
          BlissOps er en intern AI-builder platform til virksomheder der ønsker at
          automatisere processer, analysere data og bygge intelligente workflows —
          sikkert og skalerbart.
        </p>

        <div className="flex flex-col sm:flex-row gap-3">
          <a
            href={getTenantAppUrl()}
            className="inline-flex items-center gap-2 px-6 py-3 text-sm font-semibold rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            data-testid="link-marketing-cta-primary"
          >
            Kom i gang
            <ArrowRight className="w-4 h-4" />
          </a>
          <a
            href={getTenantLoginUrl()}
            className="inline-flex items-center gap-2 px-6 py-3 text-sm font-semibold rounded-xl border border-border text-foreground hover:bg-accent transition-colors"
            data-testid="link-marketing-cta-login"
          >
            Log ind på din konto
          </a>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="max-w-6xl mx-auto px-6 pb-24 w-full">
        <div className="text-center mb-12">
          <h2 className="text-2xl font-bold text-foreground mb-3">Alt hvad din virksomhed behøver</h2>
          <p className="text-muted-foreground">Fuld kontrol over AI, data og brugerrettigheder</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <FeatureCard
            icon={Zap}
            title="AI Workflows"
            description="Byg og kør AI-pipelines med vores visuelle editor. Integrer med OpenAI, Anthropic og egne modeller."
          />
          <FeatureCard
            icon={Shield}
            title="Enterprise Security"
            description="Role-based access control, MFA, audit logs og GDPR-compliance out of the box."
          />
          <FeatureCard
            icon={BarChart3}
            title="Realtids Analytics"
            description="Overvåg AI-forbrug, costs og performance på tværs af alle projekter og teams."
          />
          <FeatureCard
            icon={Globe}
            title="Multi-tenant"
            description="Administrer flere organisationer fra et enkelt admin-panel med fuld isolation."
          />
        </div>
      </section>

      {/* Footer */}
      <footer id="about" className="border-t border-border/50">
        <div className="max-w-6xl mx-auto px-6 py-8 flex flex-col md:flex-row items-center justify-between gap-4 text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <div className="flex items-center justify-center w-5 h-5 rounded bg-primary/20">
              <Cpu className="w-3 h-3 text-primary" />
            </div>
            <span className="font-medium text-foreground">BlissOps</span>
            <span>— Internal AI Builder Platform</span>
          </div>
          <p>© {new Date().getFullYear()} BlissOps. Alle rettigheder forbeholdes.</p>
        </div>
      </footer>
    </div>
  );
}

export function MarketingApp() {
  return (
    <Switch>
      {/* Auth on marketing host → redirect to tenant app */}
      <Route path="/auth/:rest*" component={AuthRedirect} />

      {/* Public landing page */}
      <Route component={MarketingLanding} />
    </Switch>
  );
}
