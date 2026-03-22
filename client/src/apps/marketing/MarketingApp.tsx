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
 *   - Primary CTA = waitlist signup (pre-launch)
 *   - NO "Start free" / "Book demo" — product not publicly available yet
 *
 * SECURITY:
 *   - This surface has no access to private data
 *   - No session checks required — entirely public
 *   - Hostname is NOT trusted for authorization
 */

import { useEffect, useRef, useState } from "react";
import { Switch, Route, useLocation } from "wouter";
import {
  ArrowRight, ArrowDown, CheckCircle2, Github, Linkedin,
  Lock, Shield, Twitter, Upload, Settings2, Cpu, Layers, FileText, Scale, Headphones, Database,
} from "lucide-react";
import { redirectAuthToTenantApp } from "@/lib/runtime/urls";
import { BrandMark } from "@/components/brand/BrandMark";

/** Intercept /auth/* on marketing host and send to tenant app */
function AuthRedirect() {
  const [location] = useLocation();
  useEffect(() => {
    redirectAuthToTenantApp(location);
  }, [location]);
  return (
    <div className="flex items-center justify-center h-screen bg-[#0A0F1C]">
      <div className="text-center space-y-2">
        <div className="h-5 w-5 rounded-full border-2 border-cyan-400 border-t-transparent animate-spin mx-auto" />
        <p className="text-sm text-slate-400">Redirecting to login…</p>
      </div>
    </div>
  );
}

/** Inline waitlist form — no external service dependency */
function WaitlistForm({ compact = false }: { compact?: boolean }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;
    setState("loading");
    // TODO: wire to real waitlist endpoint
    await new Promise((r) => setTimeout(r, 900));
    setState("done");
  }

  if (state === "done") {
    return (
      <div className={`flex flex-col items-center gap-3 ${compact ? "" : "max-w-md mx-auto"}`}>
        <div className="w-12 h-12 rounded-full bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center">
          <CheckCircle2 className="w-6 h-6 text-cyan-400" />
        </div>
        <p className="text-white font-semibold text-lg">Du er på listen</p>
        <p className="text-slate-400 text-sm text-center">Vi kontakter dig så snart der er early access tilgængeligt.</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className={`flex flex-col sm:flex-row gap-3 ${compact ? "" : "max-w-md mx-auto"} w-full`}>
      <input
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="din@email.com"
        className="flex-1 px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/30 text-sm transition-all"
        data-testid="input-waitlist-email"
      />
      <button
        type="submit"
        disabled={state === "loading"}
        className="px-6 py-3 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-sm transition-all hover:-translate-y-0.5 hover:shadow-[0_10px_30px_rgba(34,211,238,0.3)] disabled:opacity-60 disabled:cursor-not-allowed whitespace-nowrap flex items-center justify-center gap-2"
        data-testid="button-waitlist-submit"
      >
        {state === "loading" ? (
          <span className="h-4 w-4 rounded-full border-2 border-slate-950/40 border-t-slate-950 animate-spin" />
        ) : (
          <>Join waitlist <ArrowRight className="w-4 h-4" /></>
        )}
      </button>
    </form>
  );
}

function MarketingHome() {
  const waitlistRef = useRef<HTMLDivElement>(null);

  function scrollToWaitlist() {
    waitlistRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  return (
    <div className="min-h-screen bg-[#0A0F1C] text-slate-200 font-sans selection:bg-cyan-500/30 overflow-x-hidden">

      {/* NAVBAR */}
      <nav className="fixed top-0 w-full z-50 border-b border-white/5 bg-[#0A0F1C]/90 backdrop-blur-sm">
        <div className="max-w-[1280px] mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <BrandMark size={32} />
            <span className="text-white font-bold text-xl tracking-tight">BlissOps</span>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-500 border border-amber-500/20">
              EARLY ACCESS
            </span>
          </div>

          <div className="hidden md:flex items-center gap-8">
            <a href="#how-it-works" className="text-sm font-medium text-slate-400 hover:text-white transition-colors">How it works</a>
            <a href="#use-cases" className="text-sm font-medium text-slate-400 hover:text-white transition-colors">Use cases</a>
            <a href="#trust" className="text-sm font-medium text-slate-400 hover:text-white transition-colors">Security</a>
          </div>

          <button
            onClick={scrollToWaitlist}
            className="text-sm font-bold text-slate-950 px-5 py-2 rounded-full bg-gradient-to-r from-cyan-400 to-cyan-500 hover:from-cyan-300 hover:to-cyan-400 transition-all shadow-[0_0_15px_rgba(34,211,238,0.25)] hover:shadow-[0_0_25px_rgba(34,211,238,0.45)] flex items-center gap-2 group"
            data-testid="button-nav-cta"
          >
            Get early access
            <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
          </button>
        </div>
      </nav>

      {/* HERO */}
      <main className="pt-36 pb-20 px-6 max-w-[1280px] mx-auto">
        <div className="flex flex-col items-center text-center relative">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[900px] h-[600px] pointer-events-none" style={{ background: "radial-gradient(ellipse at center top, rgba(34,211,238,0.12) 0%, transparent 65%)" }} />

          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 text-xs font-semibold mb-8 relative z-10">
            <span className="text-amber-400">✦</span> New: AI Expert Builder
          </div>

          <h1 className="relative z-10 text-5xl sm:text-6xl lg:text-7xl font-black text-white leading-[1.08] tracking-tight mb-6 max-w-4xl">
            Build AI experts trained on{" "}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 via-cyan-300 to-blue-500">
              your own data
            </span>
          </h1>

          <p className="relative z-10 text-lg sm:text-xl text-slate-400 max-w-2xl mb-10 leading-relaxed font-light">
            Turn your documents, rules and internal knowledge into AI systems that actually understand your business — and act on it.
          </p>

          <div className="relative z-10 flex flex-col items-center gap-4 mb-6">
            <button
              onClick={scrollToWaitlist}
              className="px-10 py-4 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-lg transition-all hover:-translate-y-0.5 hover:shadow-[0_12px_36px_rgba(34,211,238,0.35)] flex items-center gap-2"
              data-testid="button-hero-cta"
            >
              Get early access <ArrowRight className="w-5 h-5" />
            </button>
            <p className="text-slate-500 text-sm">Limited early access · Be among the first teams to use BlissOps</p>
          </div>

          <button
            onClick={scrollToWaitlist}
            className="mt-10 flex flex-col items-center gap-2 text-slate-600 hover:text-slate-400 transition-colors group"
            data-testid="button-hero-scroll"
          >
            <span className="text-xs font-medium uppercase tracking-widest">Learn more</span>
            <ArrowDown className="w-4 h-4 group-hover:translate-y-1 transition-transform" />
          </button>
        </div>
      </main>

      {/* PROBLEM */}
      <section className="py-24 border-t border-white/5">
        <div className="max-w-[800px] mx-auto px-6">
          <h2 className="text-3xl md:text-4xl font-black text-white mb-12 text-center">
            Generic AI doesn't understand your business
          </h2>
          <div className="grid sm:grid-cols-2 gap-4">
            {[
              "Doesn't know your documents",
              "Ignores your rules and policies",
              "Produces inconsistent answers",
              "Can't be trusted in real workflows",
            ].map((problem, i) => (
              <div key={i} className="flex items-start gap-4 bg-[#0F1629] border border-white/5 rounded-xl p-5">
                <div className="w-6 h-6 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center shrink-0 mt-0.5">
                  <span className="text-red-400 text-xs font-bold">✕</span>
                </div>
                <p className="text-slate-300 text-sm leading-relaxed">{problem}</p>
              </div>
            ))}
          </div>
          <p className="text-center text-slate-500 text-base mt-10 font-medium">
            That's why teams still rely on manual work.
          </p>
        </div>
      </section>

      {/* SOLUTION */}
      <section className="py-24 border-t border-white/5 bg-[#0F1629]">
        <div className="max-w-[1000px] mx-auto px-6">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-black text-white mb-4">
              BlissOps turns your data into AI experts
            </h2>
            <p className="text-slate-400 text-lg max-w-xl mx-auto">
              Upload your data. Define your rules. Deploy AI that works your way.
            </p>
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            {[
              { icon: <FileText className="w-5 h-5 text-cyan-400" />, bg: "bg-cyan-500/10 border-cyan-500/20", text: "Train AI on your own documents and knowledge" },
              { icon: <Settings2 className="w-5 h-5 text-amber-400" />, bg: "bg-amber-500/10 border-amber-500/20", text: "Enforce business rules and logic" },
              { icon: <CheckCircle2 className="w-5 h-5 text-emerald-400" />, bg: "bg-emerald-500/10 border-emerald-500/20", text: "Ensure consistent, reliable outputs" },
              { icon: <Shield className="w-5 h-5 text-blue-400" />, bg: "bg-blue-500/10 border-blue-500/20", text: "Use AI safely in real operations" },
            ].map((item, i) => (
              <div key={i} className="flex items-start gap-4 bg-[#161F33] border border-white/5 rounded-xl p-6">
                <div className={`w-10 h-10 rounded-lg border flex items-center justify-center shrink-0 ${item.bg}`}>
                  {item.icon}
                </div>
                <p className="text-slate-200 font-medium leading-relaxed">{item.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section id="how-it-works" className="py-24 border-t border-white/5">
        <div className="max-w-[800px] mx-auto px-6 text-center">
          <h2 className="text-3xl md:text-4xl font-black text-white mb-4">
            From data to AI expert — in one system
          </h2>
          <p className="text-slate-500 mb-16">Three steps. No fragile prompts. No complex setup.</p>

          <div className="relative flex flex-col gap-0">
            {[
              {
                n: "1",
                icon: <Upload className="w-6 h-6 text-cyan-400" />,
                title: "Upload your data",
                desc: "Documents, PDFs, images, internal knowledge",
                color: "cyan",
              },
              {
                n: "2",
                icon: <Settings2 className="w-6 h-6 text-amber-400" />,
                title: "Define rules and logic",
                desc: "Policies, constraints, workflows",
                color: "amber",
              },
              {
                n: "3",
                icon: <Cpu className="w-6 h-6 text-emerald-400" />,
                title: "Deploy AI experts",
                desc: "AI that answers, decides and acts correctly",
                color: "emerald",
              },
            ].map((step, i) => (
              <div key={i} className="relative flex items-start gap-6 text-left pb-12 last:pb-0">
                {i < 2 && (
                  <div className="absolute left-[23px] top-14 bottom-0 w-px bg-gradient-to-b from-white/10 to-transparent" />
                )}
                <div className={`w-12 h-12 rounded-full border-2 flex items-center justify-center shrink-0 z-10
                  ${step.color === "cyan" ? "bg-cyan-500/10 border-cyan-500/30" : ""}
                  ${step.color === "amber" ? "bg-amber-500/10 border-amber-500/30" : ""}
                  ${step.color === "emerald" ? "bg-emerald-500/10 border-emerald-500/30" : ""}
                `}>
                  {step.icon}
                </div>
                <div className="pt-2">
                  <h3 className="text-white font-bold text-xl mb-2">{step.title}</h3>
                  <p className="text-slate-400">{step.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* DIFFERENTIATION */}
      <section className="py-24 border-t border-white/5 bg-[#0F1629]">
        <div className="max-w-[1000px] mx-auto px-6">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-black text-white mb-4">Why BlissOps is different</h2>
            <p className="text-slate-500">This is not a generic AI tool. This is not ChatGPT.</p>
          </div>
          <div className="grid sm:grid-cols-2 gap-5">
            {[
              {
                icon: <Database className="w-5 h-5 text-cyan-400" />,
                bg: "bg-cyan-500/10 border-cyan-500/20",
                title: "Your data, not generic models",
                desc: "AI trained on your actual documents and knowledge — not on the internet.",
              },
              {
                icon: <Layers className="w-5 h-5 text-amber-400" />,
                bg: "bg-amber-500/10 border-amber-500/20",
                title: "Rule-based AI behavior",
                desc: "Not just prompts — enforce real business logic that holds in production.",
              },
              {
                icon: <Settings2 className="w-5 h-5 text-blue-400" />,
                bg: "bg-blue-500/10 border-blue-500/20",
                title: "Built for real workflows",
                desc: "From input → decision → action. Designed for operations, not experiments.",
              },
              {
                icon: <CheckCircle2 className="w-5 h-5 text-emerald-400" />,
                bg: "bg-emerald-500/10 border-emerald-500/20",
                title: "Production-ready from day one",
                desc: "Not a prototype tool — built for teams that need reliability at scale.",
              },
            ].map((card, i) => (
              <div key={i} className="bg-[#161F33] border border-white/5 rounded-2xl p-7 flex flex-col gap-4 hover:border-white/10 transition-colors">
                <div className={`w-10 h-10 rounded-lg border flex items-center justify-center ${card.bg}`}>
                  {card.icon}
                </div>
                <div>
                  <h3 className="text-white font-bold text-lg mb-2">{card.title}</h3>
                  <p className="text-slate-400 text-sm leading-relaxed">{card.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* USE CASES */}
      <section id="use-cases" className="py-24 border-t border-white/5">
        <div className="max-w-[1000px] mx-auto px-6">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-black text-white mb-4">What teams use BlissOps for</h2>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[
              { icon: <Headphones className="w-5 h-5 text-cyan-400" />, label: "Customer support trained on internal policies" },
              { icon: <Database className="w-5 h-5 text-amber-400" />, label: "Internal AI assistants for company knowledge" },
              { icon: <Scale className="w-5 h-5 text-blue-400" />, label: "Compliance AI following legal rules" },
              { icon: <FileText className="w-5 h-5 text-emerald-400" />, label: "Insurance & finance experts trained on documents" },
              { icon: <Settings2 className="w-5 h-5 text-violet-400" />, label: "Workflow automation with decision logic" },
            ].map((uc, i) => (
              <div key={i} className="bg-[#0F1629] border border-white/5 rounded-xl p-5 flex items-start gap-4 hover:border-white/10 transition-colors">
                <div className="w-9 h-9 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center shrink-0">
                  {uc.icon}
                </div>
                <p className="text-slate-300 text-sm leading-relaxed font-medium">{uc.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* VISUAL BUILDER */}
      <section className="py-24 border-t border-white/5 bg-[#0F1629]">
        <div className="max-w-[1000px] mx-auto px-6">
          <div className="grid md:grid-cols-2 gap-16 items-center">
            <div>
              <div className="w-12 h-12 rounded-xl bg-cyan-500/10 flex items-center justify-center mb-6 border border-cyan-500/20">
                <Layers className="w-6 h-6 text-cyan-400" />
              </div>
              <h2 className="text-3xl font-bold text-white mb-4">Design AI experts visually</h2>
              <p className="text-slate-400 leading-relaxed mb-6">
                Define how your AI thinks — what data it uses, which rules it follows, how it responds.
              </p>
              <ul className="space-y-3">
                {[
                  "No complex setup",
                  "No fragile prompts",
                  "Full control over behavior",
                ].map((item, i) => (
                  <li key={i} className="flex items-center gap-3 text-slate-300 text-sm font-medium">
                    <CheckCircle2 className="w-4 h-4 text-cyan-500 shrink-0" /> {item}
                  </li>
                ))}
              </ul>
            </div>
            <div className="relative">
              <div className="absolute inset-0 bg-gradient-to-tr from-cyan-500/10 to-transparent blur-2xl rounded-full" />
              <div className="relative aspect-[4/3] rounded-2xl border border-white/10 bg-[#161F33] overflow-hidden p-6 shadow-2xl">
                <div className="h-full flex flex-col gap-3 justify-center">
                  <div className="bg-[#1A233A] border border-white/5 rounded-lg px-4 py-3 flex items-center gap-3">
                    <Upload className="w-4 h-4 text-cyan-400" />
                    <span className="text-xs font-mono text-slate-300">Upload: company_policies.pdf</span>
                  </div>
                  <div className="ml-6 w-px h-4 bg-cyan-500/20" />
                  <div className="bg-[#1A233A] border border-white/5 rounded-lg px-4 py-3 flex items-center gap-3">
                    <Settings2 className="w-4 h-4 text-amber-400" />
                    <span className="text-xs font-mono text-slate-300">Rule: max_refund ≤ 500</span>
                  </div>
                  <div className="ml-6 w-px h-4 bg-cyan-500/20" />
                  <div className="bg-gradient-to-r from-cyan-500 to-blue-600 rounded-lg px-4 py-3 flex items-center gap-3 shadow-lg shadow-cyan-500/20">
                    <Cpu className="w-4 h-4 text-white" />
                    <span className="text-xs font-bold text-white">AI Expert → deployed</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* VALUE PROP */}
      <section className="py-24 border-t border-white/5">
        <div className="max-w-[1000px] mx-auto px-6">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-black text-white mb-4">Save time. Improve accuracy. Scale knowledge.</h2>
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            {[
              "Reduce manual work across teams",
              "Eliminate inconsistent answers",
              "Turn static documents into active systems",
              "Make your knowledge usable, not just stored",
            ].map((v, i) => (
              <div key={i} className="flex items-start gap-4 bg-[#0F1629] border border-white/5 rounded-xl p-5">
                <CheckCircle2 className="w-5 h-5 text-cyan-400 shrink-0 mt-0.5" />
                <p className="text-slate-300 font-medium">{v}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* TRUST */}
      <section id="trust" className="py-24 border-t border-white/5 bg-[#0F1629]">
        <div className="max-w-[1000px] mx-auto px-6">
          <div className="grid md:grid-cols-2 gap-16 items-center">
            <div className="relative">
              <div className="absolute inset-0 bg-gradient-to-tr from-emerald-500/10 to-transparent blur-2xl rounded-full" />
              <div className="relative aspect-square rounded-2xl border border-white/10 bg-[#161F33] overflow-hidden p-6 shadow-2xl flex items-center justify-center">
                <Shield className="w-32 h-32 text-emerald-500/15 absolute" />
                <Lock className="w-14 h-14 text-emerald-400 relative z-10" />
              </div>
            </div>
            <div>
              <div className="w-12 h-12 rounded-xl bg-emerald-500/10 flex items-center justify-center mb-6 border border-emerald-500/20">
                <Shield className="w-6 h-6 text-emerald-500" />
              </div>
              <h2 className="text-3xl font-bold text-white mb-4">Built for serious teams</h2>
              <p className="text-slate-400 leading-relaxed mb-6">
                Security and control are not afterthoughts — they are the foundation.
              </p>
              <ul className="space-y-3">
                {[
                  "Secure by design",
                  "Full control over your data",
                  "No training on external data",
                  "Designed for multi-tenant environments",
                ].map((item, i) => (
                  <li key={i} className="flex items-center gap-3 text-slate-300 text-sm font-medium">
                    <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" /> {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* WAITLIST */}
      <section ref={waitlistRef} className="py-28 relative overflow-hidden border-t border-white/5">
        <div className="absolute inset-0 bg-cyan-900/10" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[900px] h-[700px] rounded-full pointer-events-none" style={{ background: "radial-gradient(circle, rgba(34,211,238,0.11) 0%, transparent 65%)" }} />

        <div className="max-w-[700px] mx-auto px-6 relative z-10 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 text-xs font-semibold mb-8">
            <span className="text-amber-400">✦</span> Limited early access
          </div>

          <h2 className="text-4xl md:text-5xl font-black text-white mb-5">
            Get early access to BlissOps
          </h2>
          <p className="text-xl text-slate-400 mb-10 font-light">
            Be among the first to build AI experts on your own data.
          </p>

          <WaitlistForm />

          <p className="text-slate-600 text-xs mt-4">
            No spam · Early access only · Priority onboarding
          </p>

          <div className="mt-14 pt-10 border-t border-white/5 grid sm:grid-cols-3 gap-6 text-sm">
            {[
              { icon: "✦", label: "Priority access" },
              { icon: "◆", label: "Influence on product direction" },
              { icon: "▲", label: "Early feature releases" },
            ].map((perk, i) => (
              <div key={i} className="flex flex-col items-center gap-2 text-slate-400">
                <span className="text-amber-400 text-base">{perk.icon}</span>
                <span>{perk.label}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="border-t border-white/10 bg-[#0A0F1C] pt-16 pb-8">
        <div className="max-w-[1280px] mx-auto px-6 grid grid-cols-1 md:grid-cols-3 gap-12 mb-12">
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <BrandMark size={28} />
              <span className="text-white font-bold text-lg tracking-tight">BlissOps</span>
            </div>
            <p className="text-slate-500 text-sm leading-relaxed max-w-xs">
              Build AI experts trained on your own data, rules, and workflows.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-8">
            <div>
              <h4 className="text-white font-semibold mb-4 text-sm">Product</h4>
              <ul className="space-y-2.5 text-sm text-slate-500">
                <li><a href="#how-it-works" className="hover:text-slate-300 transition-colors">How it works</a></li>
                <li><a href="#use-cases" className="hover:text-slate-300 transition-colors">Use cases</a></li>
                <li><a href="#trust" className="hover:text-slate-300 transition-colors">Security</a></li>
              </ul>
            </div>
            <div>
              <h4 className="text-white font-semibold mb-4 text-sm">Company</h4>
              <ul className="space-y-2.5 text-sm text-slate-500">
                <li><a href="#" className="hover:text-slate-300 transition-colors">About</a></li>
                <li><a href="#" className="hover:text-slate-300 transition-colors">Contact</a></li>
              </ul>
            </div>
          </div>

          <div className="flex flex-col items-start md:items-end justify-between gap-6">
            <div className="flex items-center gap-3">
              <a href="#" className="w-9 h-9 rounded-full bg-white/5 flex items-center justify-center text-slate-500 hover:text-white hover:bg-white/10 transition-all">
                <Twitter className="w-4 h-4" />
              </a>
              <a href="#" className="w-9 h-9 rounded-full bg-white/5 flex items-center justify-center text-slate-500 hover:text-white hover:bg-white/10 transition-all">
                <Github className="w-4 h-4" />
              </a>
              <a href="#" className="w-9 h-9 rounded-full bg-white/5 flex items-center justify-center text-slate-500 hover:text-white hover:bg-white/10 transition-all">
                <Linkedin className="w-4 h-4" />
              </a>
            </div>
            <button
              onClick={() => document.getElementById("waitlist")?.scrollIntoView({ behavior: "smooth" })}
              className="text-sm font-bold text-slate-950 px-5 py-2.5 rounded-full bg-cyan-500 hover:bg-cyan-400 transition-all"
              data-testid="button-footer-cta"
            >
              Join waitlist
            </button>
          </div>
        </div>

        <div className="max-w-[1280px] mx-auto px-6 border-t border-white/5 pt-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-slate-600 text-sm">© {new Date().getFullYear()} BlissOps. All rights reserved.</p>
          <div className="flex items-center gap-6 text-sm text-slate-600">
            <a href="#" className="hover:text-slate-400 transition-colors">Privacy</a>
            <a href="#" className="hover:text-slate-400 transition-colors">Terms</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

export function MarketingApp() {
  return (
    <Switch>
      <Route path="/auth/*" component={AuthRedirect} />
      <Route component={MarketingHome} />
    </Switch>
  );
}
