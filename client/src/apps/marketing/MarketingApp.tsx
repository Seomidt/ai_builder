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
  Cpu, ArrowRight, Shield, Zap, BarChart3, Users,
  Database, DollarSign, Bot, Mail, CheckCircle, ChevronRight
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

// ─── Feature Card ─────────────────────────────────────────────────────────────

interface FeatureCardProps {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
}

function FeatureCard({ icon: Icon, title, description }: FeatureCardProps) {
  return (
    <div
      className="group rounded-2xl border border-border bg-card p-6 space-y-4 transition-all duration-200 hover:shadow-md hover:-translate-y-0.5 hover:border-primary/30"
      style={{ willChange: "transform" }}
    >
      <div className="flex items-center justify-center w-11 h-11 rounded-xl bg-primary/10 group-hover:bg-primary/15 transition-colors">
        <Icon className="w-5 h-5 text-primary" />
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
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    <section id="early-access" className="py-24 px-6">
      <div className="max-w-2xl mx-auto text-center space-y-8">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 text-primary text-xs font-medium border border-primary/20">
          <Zap className="w-3 h-3" />
          Coming soon
        </div>
        <h2 className="text-3xl md:text-4xl font-bold text-foreground">
          We are preparing for early access
        </h2>
        <p className="text-muted-foreground text-lg leading-relaxed">
          Join the waitlist to get notified when BlissOps opens — and be among the first to build
          AI-powered workflows on your own data.
        </p>

        {submitted ? (
          <div className="inline-flex items-center gap-3 px-6 py-4 rounded-xl bg-primary/10 border border-primary/25 text-primary font-medium">
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
              className="flex-1 px-4 py-3 text-sm rounded-xl border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-colors"
            />
            <button
              type="submit"
              disabled={loading}
              data-testid="button-waitlist-submit"
              className="inline-flex items-center justify-center gap-2 px-6 py-3 text-sm font-semibold rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60 transition-colors whitespace-nowrap"
            >
              {loading ? (
                <span className="h-4 w-4 rounded-full border-2 border-primary-foreground border-t-transparent animate-spin" />
              ) : (
                <>Join waitlist <ArrowRight className="w-3.5 h-3.5" /></>
              )}
            </button>
          </form>
          {error && (
            <p className="text-sm text-red-500 text-center" data-testid="text-waitlist-error">{error}</p>
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
      description: "Design and run AI workflows with built-in execution, retry safety and cost control.",
    },
    {
      icon: Bot,
      title: "AI Agents (Experts)",
      description: "Create domain-specific AI experts powered by your own data and business logic.",
    },
    {
      icon: Database,
      title: "Knowledge & Retrieval",
      description: "Upload documents and build knowledge bases with embeddings and intelligent retrieval.",
    },
    {
      icon: DollarSign,
      title: "Monetization & Billing",
      description: "Track usage, control cost and monetize AI with built-in pricing and wallet system.",
    },
    {
      icon: Shield,
      title: "Enterprise Security",
      description: "Role-based access, audit logs and tenant isolation out of the box.",
    },
    {
      icon: Users,
      title: "Multi-tenant Platform",
      description: "Run multiple organizations with strict isolation and centralized control.",
    },
  ];

  const TRUST_POINTS = [
    "No infrastructure to manage",
    "Full data sovereignty",
    "Built-in cost governance",
  ];

  return (
    <div className="min-h-screen bg-background flex flex-col">

      {/* ── Navigation ── */}
      <header className="sticky top-0 z-50 border-b border-border/50 bg-background/90 backdrop-blur-sm">
        <div className="max-w-[1200px] mx-auto px-6 h-16 flex items-center justify-between">

          {/* Logo */}
          <a href="/" className="flex items-center gap-2.5 group">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary shadow-sm">
              <Cpu className="w-4 h-4 text-primary-foreground" />
            </div>
            <span className="text-sm font-bold text-foreground tracking-wide">BlissOps</span>
          </a>

          {/* Nav links */}
          <nav className="hidden md:flex items-center gap-8 text-sm text-muted-foreground">
            <a href="#features"      className="hover:text-foreground transition-colors">Features</a>
            <a href="#early-access"  className="hover:text-foreground transition-colors">Early access</a>
            <a href="#contact"       className="hover:text-foreground transition-colors">Contact</a>
          </nav>

          {/* CTA */}
          <a
            href={loginUrl}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            data-testid="link-marketing-login"
          >
            Log in
            <ArrowRight className="w-3.5 h-3.5" />
          </a>
        </div>
      </header>

      {/* ── Hero ── */}
      <section className="relative overflow-hidden">
        {/* Gradient background */}
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              "radial-gradient(ellipse 80% 60% at 50% -10%, hsl(175 75% 38% / 0.12) 0%, transparent 70%)",
          }}
        />

        <div className="relative max-w-[1200px] mx-auto px-6 pt-24 pb-20 text-center">

          {/* Badge */}
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 text-primary text-xs font-semibold mb-8 border border-primary/20">
            <Zap className="w-3 h-3" />
            AI Platform — Early access
          </div>

          {/* H1 */}
          <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold text-foreground leading-[1.1] tracking-tight mb-6 max-w-4xl mx-auto">
            AI platform for building, running{" "}
            <span className="text-primary">and monetizing</span>{" "}
            intelligent workflows
          </h1>

          {/* Subheadline */}
          <p className="text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto leading-relaxed mb-10">
            Run AI on your own data with full control over cost, access and performance —
            without building infrastructure from scratch.
          </p>

          {/* Trust points */}
          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 mb-10">
            {TRUST_POINTS.map((point) => (
              <div key={point} className="flex items-center gap-2 text-sm text-muted-foreground">
                <CheckCircle className="w-3.5 h-3.5 text-primary flex-shrink-0" />
                {point}
              </div>
            ))}
          </div>

          {/* CTAs */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <a
              href="#early-access"
              className="inline-flex items-center gap-2 px-6 py-3.5 text-sm font-semibold rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 transition-colors shadow-sm"
              data-testid="link-marketing-cta-primary"
            >
              Request early access
              <ArrowRight className="w-4 h-4" />
            </a>
            <a
              href="#features"
              className="inline-flex items-center gap-2 px-6 py-3.5 text-sm font-semibold rounded-xl border border-border text-foreground hover:bg-accent hover:border-primary/30 transition-colors"
              data-testid="link-marketing-cta-secondary"
            >
              See how it works
              <ChevronRight className="w-4 h-4" />
            </a>
          </div>
        </div>
      </section>

      {/* ── Features ── */}
      <section id="features" className="py-24 px-6">
        <div className="max-w-[1200px] mx-auto">

          {/* Section heading */}
          <div className="text-center mb-16">
            <h2 className="text-2xl md:text-3xl font-bold text-foreground mb-4">
              Everything your organization needs
            </h2>
            <p className="text-muted-foreground text-lg max-w-xl mx-auto">
              One platform to build, govern and scale AI across your entire organization.
            </p>
          </div>

          {/* 3×2 grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {FEATURES.map((f) => (
              <FeatureCard key={f.title} icon={f.icon} title={f.title} description={f.description} />
            ))}
          </div>
        </div>
      </section>

      {/* ── Core message ── */}
      <section className="py-16 px-6">
        <div className="max-w-[1200px] mx-auto">
          <div
            className="relative rounded-2xl overflow-hidden px-10 py-14 text-center"
            style={{
              background:
                "linear-gradient(135deg, hsl(175 75% 38% / 0.08) 0%, hsl(220 25% 97% / 0.5) 50%, hsl(175 75% 38% / 0.06) 100%)",
              border: "1px solid hsl(175 75% 38% / 0.15)",
            }}
          >
            <blockquote className="text-xl md:text-2xl font-semibold text-foreground max-w-3xl mx-auto leading-snug">
              "Build, run and monetize AI — on your own data — with full control over
              cost, access and execution."
            </blockquote>
            <p className="mt-5 text-sm text-muted-foreground">BlissOps core promise</p>
          </div>
        </div>
      </section>

      {/* ── Waitlist / Coming soon ── */}
      <WaitlistSection />

      {/* ── Contact ── */}
      <section id="contact" className="py-16 px-6 border-t border-border/50">
        <div className="max-w-[1200px] mx-auto text-center space-y-4">
          <div className="flex items-center justify-center gap-2.5 text-foreground">
            <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-primary/10">
              <Mail className="w-4 h-4 text-primary" />
            </div>
            <h2 className="text-xl font-bold">Contact</h2>
          </div>
          <p className="text-muted-foreground max-w-md mx-auto">
            For questions, partnerships or early access requests:
          </p>
          <a
            href="mailto:support@blissops.com"
            data-testid="link-contact-email"
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl border border-border text-foreground hover:bg-accent hover:border-primary/30 transition-colors text-sm font-medium"
          >
            <Mail className="w-3.5 h-3.5 text-primary" />
            support@blissops.com
          </a>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="border-t border-border/50 bg-background">
        <div className="max-w-[1200px] mx-auto px-6 py-8">
          <div className="flex flex-col md:flex-row items-center justify-between gap-6">

            {/* Brand */}
            <div className="flex items-center gap-2.5">
              <div className="flex items-center justify-center w-6 h-6 rounded-md bg-primary/20">
                <Cpu className="w-3.5 h-3.5 text-primary" />
              </div>
              <span className="text-sm font-bold text-foreground">BlissOps</span>
              <span className="text-xs text-muted-foreground">— AI Platform</span>
            </div>

            {/* Footer links */}
            <nav className="flex items-center gap-6 text-xs text-muted-foreground">
              <a href="#" className="hover:text-foreground transition-colors">Terms</a>
              <a href="#" className="hover:text-foreground transition-colors">Privacy</a>
              <a href="#contact" className="hover:text-foreground transition-colors">Contact</a>
              <a
                href="mailto:support@blissops.com"
                className="hover:text-foreground transition-colors"
                data-testid="link-footer-email"
              >
                support@blissops.com
              </a>
            </nav>

            {/* Copyright */}
            <p className="text-xs text-muted-foreground">
              © {new Date().getFullYear()} BlissOps. All rights reserved.
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
      {/* Auth on marketing host → redirect to tenant app */}
      <Route path="/auth/:rest*" component={AuthRedirect} />

      {/* Public landing page */}
      <Route component={MarketingLanding} />
    </Switch>
  );
}
