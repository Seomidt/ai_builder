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

import { useState, useEffect } from "react";
import { Switch, Route, useLocation } from "wouter";
import {
  ArrowRight, Shield, Zap, BarChart3, Users,
  Database, DollarSign, Bot, Mail, CheckCircle, ChevronRight,
  Cpu, Lock, TrendingUp
} from "lucide-react";
import { getTenantLoginUrl, redirectAuthToTenantApp } from "@/lib/runtime/urls";

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
        <p className="text-sm text-muted-foreground">Redirecting to login…</p>
      </div>
    </div>
  );
}

// ─── Brand Logo ───────────────────────────────────────────────────────────────

function Logo({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const dim = size === "lg" ? 40 : size === "sm" ? 26 : 32;
  return (
    <img
      src="/brand/icon.png"
      alt="BlissOps"
      width={dim}
      height={dim}
      style={{ objectFit: "contain" }}
    />
  );
}

// ─── Feature Card ─────────────────────────────────────────────────────────────

interface FeatureCardProps {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  accent?: "cyan" | "gold";
}

function FeatureCard({ icon: Icon, title, description, accent = "cyan" }: FeatureCardProps) {
  const isCyan = accent === "cyan";
  return (
    <div
      className="group relative rounded-2xl p-6 space-y-4 transition-all duration-200 hover:-translate-y-1"
      style={{
        background: "rgba(255,255,255,0.025)",
        border: "1px solid rgba(255,255,255,0.07)",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.borderColor = isCyan ? "rgba(34,211,238,0.20)" : "rgba(245,158,11,0.20)";
        (e.currentTarget as HTMLDivElement).style.boxShadow = isCyan ? "0 8px 32px rgba(34,211,238,0.07)" : "0 8px 32px rgba(245,158,11,0.07)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.borderColor = "rgba(255,255,255,0.07)";
        (e.currentTarget as HTMLDivElement).style.boxShadow = "none";
      }}
    >
      <div
        className="flex items-center justify-center w-11 h-11 rounded-xl shrink-0 transition-all duration-200"
        style={{ background: isCyan ? "rgba(34,211,238,0.10)" : "rgba(245,158,11,0.10)" }}
      >
        <Icon className={`w-5 h-5 ${isCyan ? "text-primary" : "text-secondary"}`} />
      </div>
      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <p className="text-sm text-muted-foreground leading-relaxed">{description}</p>
      </div>
    </div>
  );
}

// ─── Waitlist Section ─────────────────────────────────────────────────────────

function WaitlistSection() {
  const [email, setEmail]       = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), source: "marketing" }),
      });
      if (res.ok || res.status === 200) {
        setSubmitted(true);
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Der skete en fejl. Prøv igen.");
      }
    } catch {
      setError("Ingen forbindelse. Prøv igen.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section id="early-access" className="py-28 px-6">
      <div className="max-w-2xl mx-auto text-center space-y-8">
        <div
          className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-xs font-semibold"
          style={{ background: "rgba(34,211,238,0.10)", border: "1px solid rgba(34,211,238,0.20)", color: "#22D3EE" }}
        >
          <Zap className="w-3 h-3" />
          Early Access — Limited spots
        </div>

        <h2 className="text-3xl md:text-4xl font-bold text-foreground leading-tight">
          Get early access to BlissOps
        </h2>
        <p className="text-muted-foreground text-lg leading-relaxed">
          Join the waitlist to be among the first to build AI-powered workflows on your own data —
          with full control over cost, access and execution.
        </p>

        {submitted ? (
          <div
            className="inline-flex items-center gap-3 px-6 py-4 rounded-2xl font-medium text-primary"
            style={{ background: "rgba(34,211,238,0.08)", border: "1px solid rgba(34,211,238,0.20)" }}
          >
            <CheckCircle className="w-5 h-5" />
            You're on the list — we'll be in touch.
          </div>
        ) : (
          <div className="space-y-3 max-w-md mx-auto">
            <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-3">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="your@email.com"
                required
                data-testid="input-waitlist-email"
                className="flex-1 px-4 py-3 text-sm rounded-xl text-foreground placeholder:text-muted-foreground focus:outline-none transition-all"
                style={{
                  background: "rgba(255,255,255,0.05)",
                  border: "1px solid rgba(255,255,255,0.10)",
                }}
                onFocus={(e) => { (e.target as HTMLInputElement).style.borderColor = "rgba(34,211,238,0.40)"; (e.target as HTMLInputElement).style.boxShadow = "0 0 0 3px rgba(34,211,238,0.08)"; }}
                onBlur={(e) => { (e.target as HTMLInputElement).style.borderColor = "rgba(255,255,255,0.10)"; (e.target as HTMLInputElement).style.boxShadow = "none"; }}
              />
              <button
                type="submit"
                disabled={loading}
                data-testid="button-waitlist-submit"
                className="inline-flex items-center justify-center gap-2 px-6 py-3 text-sm font-semibold rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60 transition-colors whitespace-nowrap"
                style={{ boxShadow: "0 0 20px rgba(34,211,238,0.25)" }}
              >
                {loading ? (
                  <span className="h-4 w-4 rounded-full border-2 border-primary-foreground border-t-transparent animate-spin" />
                ) : (
                  <>Join waitlist <ArrowRight className="w-3.5 h-3.5" /></>
                )}
              </button>
            </form>
            {error && (
              <p className="text-sm text-red-400 text-center" data-testid="text-waitlist-error">{error}</p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// ─── Landing Page ─────────────────────────────────────────────────────────────

function MarketingLanding() {
  const loginUrl = getTenantLoginUrl();

  const FEATURES = [
    {
      icon: Zap,
      title: "AI Workflows",
      description: "Design and execute AI workflows with built-in retry safety, cost control and full execution history.",
      accent: "cyan" as const,
    },
    {
      icon: Bot,
      title: "AI Agents (Experts)",
      description: "Create domain-specific AI experts powered by your own knowledge base and business logic.",
      accent: "cyan" as const,
    },
    {
      icon: Database,
      title: "Knowledge & Retrieval",
      description: "Upload documents, build knowledge bases with embeddings, and enable intelligent retrieval.",
      accent: "cyan" as const,
    },
    {
      icon: DollarSign,
      title: "Monetization & Billing",
      description: "Track usage, enforce cost limits and monetize AI with built-in pricing and wallet infrastructure.",
      accent: "gold" as const,
    },
    {
      icon: Shield,
      title: "Governance & Security",
      description: "Role-based access, audit logs, anomaly detection and tenant isolation — out of the box.",
      accent: "gold" as const,
    },
    {
      icon: Users,
      title: "Multi-tenant Platform",
      description: "Run multiple organizations with strict isolation, centralized control and per-tenant billing.",
      accent: "gold" as const,
    },
  ];

  const TRUST_POINTS = [
    { icon: Lock,      label: "Full data sovereignty"      },
    { icon: TrendingUp, label: "Built-in cost governance"   },
    { icon: Cpu,       label: "No infrastructure to manage" },
  ];

  const HOW_IT_WORKS = [
    { step: "01", title: "Connect your data", desc: "Upload documents, connect integrations, define your knowledge base." },
    { step: "02", title: "Build your workflows", desc: "Design AI workflows using a visual builder with built-in execution safety." },
    { step: "03", title: "Deploy and govern", desc: "Run at scale with full control over cost, access and performance." },
  ];

  return (
    <div className="min-h-screen bg-background flex flex-col overflow-x-hidden">

      {/* ── Navigation ── */}
      <header className="sticky top-0 z-50" style={{ borderBottom: "1px solid rgba(255,255,255,0.08)", background: "hsl(218 28% 15% / 0.92)", backdropFilter: "blur(14px)" }}>
        <div className="max-w-[1200px] mx-auto px-6 h-16 flex items-center justify-between">

          {/* Logo */}
          <a href="/" className="flex items-center gap-2.5 group" aria-label="BlissOps home">
            <Logo size="md" />
            <span className="text-sm font-bold text-foreground tracking-wide">
              Bliss<span className="text-primary">Ops</span>
            </span>
          </a>

          {/* Nav links */}
          <nav className="hidden md:flex items-center gap-8 text-sm text-muted-foreground">
            <a href="#features"     className="hover:text-foreground transition-colors">Features</a>
            <a href="#how-it-works" className="hover:text-foreground transition-colors">How it works</a>
            <a href="#early-access" className="hover:text-foreground transition-colors">Early access</a>
            <a href="#contact"      className="hover:text-foreground transition-colors">Contact</a>
          </nav>

          {/* CTA */}
          <a
            href={loginUrl}
            className="hidden sm:inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            data-testid="link-marketing-login"
            style={{ boxShadow: "0 0 16px rgba(34,211,238,0.20)" }}
          >
            Log in
            <ArrowRight className="w-3.5 h-3.5" />
          </a>
        </div>
      </header>

      {/* ── Hero ── */}
      <section className="relative overflow-hidden">
        {/* Background radial glows */}
        <div aria-hidden className="pointer-events-none absolute inset-0" style={{
          background: "radial-gradient(ellipse 80% 70% at 50% -5%, rgba(34,211,238,0.10) 0%, transparent 65%)",
        }} />
        <div aria-hidden className="pointer-events-none absolute inset-0" style={{
          background: "radial-gradient(ellipse 50% 40% at 85% 90%, rgba(245,158,11,0.05) 0%, transparent 55%)",
        }} />

        <div className="relative max-w-[1200px] mx-auto px-6 pt-24 pb-24 text-center">

          {/* Hero logo */}
          <div className="flex justify-center mb-8">
            <img
              src="/brand/logo-full.png"
              alt="BlissOps"
              className="w-72 h-auto object-contain"
              style={{ filter: "drop-shadow(0 0 40px rgba(34,211,238,0.30))" }}
            />
          </div>

          {/* Badge */}
          <div
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-xs font-semibold mb-8"
            style={{ background: "rgba(34,211,238,0.08)", border: "1px solid rgba(34,211,238,0.18)", color: "#22D3EE" }}
          >
            <Zap className="w-3 h-3" />
            AI Platform — Early Access
          </div>

          {/* H1 */}
          <h1 className="text-4xl sm:text-5xl lg:text-[60px] font-bold text-foreground leading-[1.08] tracking-tight mb-7 max-w-4xl mx-auto">
            Build, run{" "}
            <span style={{ color: "#22D3EE", textShadow: "0 0 40px rgba(34,211,238,0.30)" }}>and monetize</span>
            {" "}intelligent AI workflows
          </h1>

          {/* Sub */}
          <p className="text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto leading-relaxed mb-10">
            Enterprise AI platform for building powerful workflows on your own data —
            with full governance, cost control and built-in monetization infrastructure.
          </p>

          {/* Trust points */}
          <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-3 mb-12">
            {TRUST_POINTS.map(({ icon: Icon, label }) => (
              <div key={label} className="flex items-center gap-2 text-sm text-muted-foreground">
                <Icon className="w-3.5 h-3.5 text-primary flex-shrink-0" />
                {label}
              </div>
            ))}
          </div>

          {/* CTAs */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <a
              href="#early-access"
              className="inline-flex items-center gap-2 px-7 py-3.5 text-sm font-bold rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
              data-testid="link-marketing-cta-primary"
              style={{ boxShadow: "0 0 24px rgba(34,211,238,0.30)" }}
            >
              Request early access
              <ArrowRight className="w-4 h-4" />
            </a>
            <a
              href="#features"
              className="inline-flex items-center gap-2 px-7 py-3.5 text-sm font-semibold rounded-xl text-foreground transition-all hover:-translate-y-0.5"
              data-testid="link-marketing-cta-secondary"
              style={{ border: "1px solid rgba(255,255,255,0.10)", background: "rgba(255,255,255,0.03)" }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.borderColor = "rgba(34,211,238,0.25)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.borderColor = "rgba(255,255,255,0.10)"; }}
            >
              See how it works
              <ChevronRight className="w-4 h-4" />
            </a>
          </div>
        </div>
      </section>

      {/* ── How it works ── */}
      <section id="how-it-works" className="py-24 px-6" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
        <div className="max-w-[1200px] mx-auto">
          <div className="text-center mb-16">
            <p className="text-xs font-semibold uppercase tracking-widest text-primary mb-3">How it works</p>
            <h2 className="text-2xl md:text-3xl font-bold text-foreground mb-4">
              From data to production in three steps
            </h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {HOW_IT_WORKS.map(({ step, title, desc }) => (
              <div key={step} className="relative pl-14">
                <span
                  className="absolute left-0 top-0 text-4xl font-black tabular-nums leading-none"
                  style={{ color: "rgba(34,211,238,0.12)", fontVariantNumeric: "tabular-nums" }}
                >
                  {step}
                </span>
                <h3 className="text-base font-semibold text-foreground mb-2">{title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Features ── */}
      <section id="features" className="py-24 px-6" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
        <div className="max-w-[1200px] mx-auto">
          <div className="text-center mb-16">
            <p className="text-xs font-semibold uppercase tracking-widest text-primary mb-3">Platform capabilities</p>
            <h2 className="text-2xl md:text-3xl font-bold text-foreground mb-4">
              Everything your organization needs
            </h2>
            <p className="text-muted-foreground text-lg max-w-xl mx-auto">
              One platform to build, govern and scale AI across your entire organization.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {FEATURES.map((f) => (
              <FeatureCard key={f.title} icon={f.icon} title={f.title} description={f.description} accent={f.accent} />
            ))}
          </div>
        </div>
      </section>

      {/* ── Core promise ── */}
      <section className="py-16 px-6">
        <div className="max-w-[1200px] mx-auto">
          <div
            className="relative rounded-3xl overflow-hidden px-10 py-16 text-center"
            style={{
              background: "linear-gradient(135deg, rgba(34,211,238,0.06) 0%, rgba(255,255,255,0.01) 50%, rgba(245,158,11,0.04) 100%)",
              border: "1px solid rgba(34,211,238,0.12)",
            }}
          >
            <div aria-hidden className="absolute inset-0 pointer-events-none" style={{ background: "radial-gradient(ellipse 60% 60% at 50% 50%, rgba(34,211,238,0.05) 0%, transparent 70%)" }} />
            <div className="relative">
              <BarChart3 className="w-8 h-8 text-primary/50 mx-auto mb-6" />
              <blockquote className="text-xl md:text-2xl font-semibold text-foreground max-w-3xl mx-auto leading-snug">
                "Build, run and monetize AI — on your own data — with full control over cost, access and execution."
              </blockquote>
              <p className="mt-6 text-sm text-muted-foreground font-medium">BlissOps core promise</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Waitlist / Early access ── */}
      <WaitlistSection />

      {/* ── Contact ── */}
      <section id="contact" className="py-16 px-6" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
        <div className="max-w-[1200px] mx-auto text-center space-y-6">
          <p className="text-xs font-semibold uppercase tracking-widest text-primary">Contact</p>
          <h2 className="text-2xl font-bold text-foreground">Talk to us</h2>
          <p className="text-muted-foreground max-w-md mx-auto">
            For questions, enterprise pilots, partnerships or early access requests — reach out directly.
          </p>
          <a
            href="mailto:support@blissops.com"
            data-testid="link-contact-email"
            className="inline-flex items-center gap-2.5 px-6 py-3 rounded-xl text-sm font-medium text-foreground transition-all hover:-translate-y-0.5"
            style={{ border: "1px solid rgba(255,255,255,0.10)", background: "rgba(255,255,255,0.03)" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.borderColor = "rgba(34,211,238,0.25)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.borderColor = "rgba(255,255,255,0.10)"; }}
          >
            <Mail className="w-4 h-4 text-primary" />
            support@blissops.com
          </a>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer style={{ borderTop: "1px solid rgba(255,255,255,0.08)", background: "hsl(218 28% 13% / 0.80)" }}>
        <div className="max-w-[1200px] mx-auto px-6 py-8">
          <div className="flex flex-col md:flex-row items-center justify-between gap-6">

            {/* Brand */}
            <div className="flex items-center gap-2.5">
              <Logo size="sm" />
              <span className="text-sm font-bold text-foreground">Bliss<span className="text-primary">Ops</span></span>
              <span className="text-xs text-muted-foreground/60">— AI Platform</span>
            </div>

            {/* Links */}
            <nav className="flex items-center gap-6 text-xs text-muted-foreground flex-wrap justify-center">
              <a href="#features"     className="hover:text-foreground transition-colors">Features</a>
              <a href="#early-access" className="hover:text-foreground transition-colors">Early access</a>
              <a href="#"             className="hover:text-foreground transition-colors">Terms</a>
              <a href="#"             className="hover:text-foreground transition-colors">Privacy</a>
              <a
                href="mailto:support@blissops.com"
                className="hover:text-foreground transition-colors"
                data-testid="link-footer-email"
              >
                support@blissops.com
              </a>
            </nav>

            {/* Copyright */}
            <p className="text-xs text-muted-foreground/50">
              © {new Date().getFullYear()} BlissOps
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}

// ─── App Router ───────────────────────────────────────────────────────────────

export function MarketingApp() {
  return (
    <Switch>
      <Route path="/auth/:rest*" component={AuthRedirect} />
      <Route component={MarketingLanding} />
    </Switch>
  );
}
