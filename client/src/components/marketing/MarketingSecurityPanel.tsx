import { Menu, Lock, Eye, FolderLock, ShieldCheck, Building2, CheckCircle2 } from "lucide-react";
import { MarketingLogo } from "./MarketingLogo";

const securityItems = [
  {
    icon: <Lock className="h-4 w-4" />,
    title: "Tenant isolation by design",
    text: "Built for organization-level separation, secure access control, and privacy-first architecture.",
  },
  {
    icon: <Eye className="h-4 w-4" />,
    title: "Full audit visibility",
    text: "Track actions, access and activity with clear auditability across your AI operations.",
  },
  {
    icon: <FolderLock className="h-4 w-4" />,
    title: "Your data stays yours",
    text: "Designed so your data remains under your control, with secure storage and scoped access.",
  },
  {
    icon: <ShieldCheck className="h-4 w-4" />,
    title: "Data privacy and GDPR readiness",
    text: "Built with EU data protection principles, secure access control and privacy-first architecture.",
  },
  {
    icon: <Building2 className="h-4 w-4" />,
    title: "Enterprise-ready architecture",
    text: "Designed for teams that need control, visibility and a strong foundation for secure AI adoption.",
  },
];

const earlyAccessBullets = [
  { icon: <Lock className="h-4 w-4" />, label: "Limited rollout" },
  { icon: <CheckCircle2 className="h-4 w-4" />, label: "No spam" },
  { icon: <ShieldCheck className="h-4 w-4" />, label: "Priority onboarding" },
];

export function MarketingSecurityPanel() {
  return (
    <aside
      id="security"
      className="rounded-[26px] border border-white/10 bg-slate-950/72 p-6 backdrop-blur-xl"
    >
      {/* Top header row: logo + hamburger */}
      <div className="mb-10 flex items-center justify-between">
        <MarketingLogo small />
        <button
          aria-label="Menu"
          className="grid h-9 w-9 place-items-center rounded-xl border border-white/10 bg-slate-900/80 text-slate-400 transition hover:text-white"
        >
          <Menu className="h-4 w-4" />
        </button>
      </div>

      <div className="mb-4 text-[11px] uppercase tracking-[0.24em] text-sky-400/80">
        Secure AI infrastructure
      </div>

      <h2 className="max-w-sm text-4xl font-semibold tracking-tight text-white">
        Secure AI Infrastructure for Enterprises
      </h2>

      <p className="mt-4 max-w-sm text-base leading-7 text-slate-400">
        BlissOps is designed for organizations that need control, visibility and data
        protection when using AI.
      </p>

      <div className="mt-8 space-y-6">
        {securityItems.map((item) => (
          <div key={item.title} className="flex gap-4">
            <div className="mt-1 grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-sky-400/20 bg-slate-900/80 text-sky-300">
              {item.icon}
            </div>
            <div>
              <div className="text-lg font-medium text-white">{item.title}</div>
              <div className="mt-1 text-sm leading-6 text-slate-400">{item.text}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="my-10 h-px bg-white/10" />

      <div className="mb-3 text-[11px] uppercase tracking-[0.24em] text-sky-400/80">
        Built for control
      </div>

      <h3 className="text-3xl font-semibold tracking-tight text-white">
        Private early access for selected teams
      </h3>

      <p className="mt-4 text-base leading-7 text-slate-400">
        BlissOps is in private rollout. Be among the first to gain access and help shape the platform.
      </p>

      <div className="mt-6 space-y-4">
        {earlyAccessBullets.map((item) => (
          <div key={item.label} className="flex items-center gap-3 text-slate-200">
            <span className="grid h-9 w-9 place-items-center rounded-xl border border-sky-400/20 bg-slate-900/80 text-sky-300">
              {item.icon}
            </span>
            <span>{item.label}</span>
          </div>
        ))}
      </div>

      <div className="mt-10 rounded-2xl border border-white/10 bg-slate-950/70 p-5">
        <MarketingLogo small />
        <div className="mt-5 text-sm text-slate-400">Built for secure AI infrastructure</div>
      </div>
    </aside>
  );
}
