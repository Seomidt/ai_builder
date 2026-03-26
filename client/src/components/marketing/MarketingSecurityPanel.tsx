import { Lock, Eye, FolderLock, ShieldCheck, Building2, CheckCircle2 } from "lucide-react";
import { MarketingLogo } from "./MarketingLogo";
import { Link } from "wouter";

const securityItems = [
  {
    icon: <Lock className="h-4 w-4" />,
    title: "Tenant isolation by design",
    text: "Organization-level separation, secure access control, and privacy-first architecture.",
  },
  {
    icon: <Eye className="h-4 w-4" />,
    title: "Full audit visibility",
    text: "Track actions, access and activity with clear auditability across all AI operations.",
  },
  {
    icon: <FolderLock className="h-4 w-4" />,
    title: "Your data stays yours",
    text: "Data remains under your control with scoped access and secure isolated storage.",
  },
  {
    icon: <ShieldCheck className="h-4 w-4" />,
    title: "Data privacy and GDPR readiness",
    text: "Built with EU data protection principles and privacy-first architecture from the ground up.",
  },
  {
    icon: <Building2 className="h-4 w-4" />,
    title: "Enterprise-ready architecture",
    text: "Designed for teams that need control, visibility and a strong foundation for AI adoption.",
  },
];

export function MarketingSecurityPanel() {
  return (
    <aside
      id="security"
      className="sticky top-24 self-start rounded-[24px] border border-white/10 bg-[#060d1f]/70 p-6 backdrop-blur-2xl"
    >
      {/* Header */}
      <div className="mb-8 flex items-center justify-between">
        <MarketingLogo small />
        <div className="rounded-md border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] font-medium text-slate-400 tracking-wide">
          PRIVATE ROLLOUT
        </div>
      </div>

      {/* Section label */}
      <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.24em] text-sky-400/70">
        Secure AI infrastructure
      </div>

      <h2 className="mt-3 text-2xl font-semibold leading-tight tracking-tight text-white">
        Secure AI Infrastructure<br />for Enterprises
      </h2>

      <p className="mt-3 text-sm leading-6 text-slate-400">
        BlissOps is designed for organizations that need control, visibility and data protection when using AI.
      </p>

      <div className="mt-6 space-y-4">
        {securityItems.map((item) => (
          <div key={item.title} className="flex gap-3">
            <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl border border-sky-400/15 bg-[#0a1628] text-sky-300">
              {item.icon}
            </div>
            <div>
              <div className="text-sm font-medium text-white">{item.title}</div>
              <div className="mt-0.5 text-xs leading-5 text-slate-400">{item.text}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="my-7 h-px bg-white/8" />

      {/* Early access */}
      <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.24em] text-sky-400/70">
        Early access
      </div>

      <h3 className="mt-3 text-lg font-semibold leading-tight tracking-tight text-white">
        Private rollout for<br />selected organizations
      </h3>

      <p className="mt-3 text-sm leading-6 text-slate-400">
        Be among the first to gain access and help shape the platform.
      </p>

      <div className="mt-4 space-y-2">
        {["Limited rollout", "Priority onboarding and support", "Influence the product roadmap"].map((item) => (
          <div key={item} className="flex items-center gap-2.5 text-sm text-slate-300">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-sky-400/80" />
            {item}
          </div>
        ))}
      </div>

      <Link
        href="/early-access"
        className="mt-6 flex w-full items-center justify-center rounded-xl border border-sky-500/30 bg-sky-500/8 py-2.5 text-sm font-medium text-sky-300 transition hover:border-sky-400/50 hover:bg-sky-500/15"
        data-testid="link-panel-early-access"
      >
        Request access →
      </Link>
    </aside>
  );
}
