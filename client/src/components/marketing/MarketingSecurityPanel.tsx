import { Menu, Lock, Eye, FolderLock, ShieldCheck, Building2 } from "lucide-react";
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
  { icon: <Lock className="h-3.5 w-3.5" />, label: "Limited rollout" },
  { icon: <ShieldCheck className="h-3.5 w-3.5" />, label: "No spam" },
  { icon: <Building2 className="h-3.5 w-3.5" />, label: "Priority onboarding" },
];

export function MarketingSecurityPanel() {
  return (
    <aside
      id="security"
      className="sticky top-24 self-start rounded-[24px] border border-white/10 bg-[#060d1f]/70 p-6 backdrop-blur-2xl"
    >
      {/* Header row */}
      <div className="mb-8 flex items-center justify-between">
        <MarketingLogo small />
        <button
          aria-label="Menu"
          className="grid h-8 w-8 place-items-center rounded-lg border border-white/10 bg-white/5 text-slate-400 transition hover:text-white"
        >
          <Menu className="h-4 w-4" />
        </button>
      </div>

      {/* Security section */}
      <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.24em] text-sky-400/80">
        Secure AI infrastructure
      </div>

      <h2 className="mt-3 text-3xl font-semibold leading-tight tracking-tight text-white">
        Secure AI Infrastructure<br />for Enterprises
      </h2>

      <p className="mt-3 text-sm leading-6 text-slate-400">
        BlissOps is designed for organizations that need control, visibility and data protection when using AI.
      </p>

      <div className="mt-6 space-y-5">
        {securityItems.map((item) => (
          <div key={item.title} className="flex gap-3">
            <div className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-sky-400/20 bg-[#0a1628] text-sky-300">
              {item.icon}
            </div>
            <div>
              <div className="text-sm font-semibold text-white">{item.title}</div>
              <div className="mt-0.5 text-xs leading-5 text-slate-400">{item.text}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="my-8 h-px bg-white/8" />

      {/* Early access section */}
      <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.24em] text-sky-400/80">
        Built for contact
      </div>

      <h3 className="mt-3 text-2xl font-semibold leading-tight tracking-tight text-white">
        Private early access<br />for selected teams
      </h3>

      <p className="mt-3 text-sm leading-6 text-slate-400">
        BlissOps is in private rollout. Be among the first to gain access and help shape the platform.
      </p>

      <div className="mt-5 space-y-3">
        {earlyAccessBullets.map((item) => (
          <div key={item.label} className="flex items-center gap-3 text-sm text-slate-200">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl border border-sky-400/20 bg-[#0a1628] text-sky-300">
              {item.icon}
            </span>
            {item.label}
          </div>
        ))}
      </div>

      {/* Bottom logo card */}
      <div className="mt-8 rounded-2xl border border-white/10 bg-[#0a1628]/80 p-4">
        <MarketingLogo small />
        <div className="mt-4 text-xs text-slate-400">Built for secure AI infrastructure</div>
      </div>
    </aside>
  );
}
