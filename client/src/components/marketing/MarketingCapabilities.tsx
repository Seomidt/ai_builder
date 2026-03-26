import { Lock, Eye, FolderLock, ShieldCheck, Building2 } from "lucide-react";

const capabilities = [
  {
    icon: <Lock className="h-5 w-5" />,
    title: "AI assistants on your data",
    text: "Ground AI on your documents, knowledge base and internal systems — keeping context accurate and private.",
  },
  {
    icon: <ShieldCheck className="h-5 w-5" />,
    title: "Predictable AI usage and cost",
    text: "Track usage with built-in guardrails and clear visibility into how AI is used across your organization.",
  },
  {
    icon: <Building2 className="h-5 w-5" />,
    title: "Tenant-isolated architecture",
    text: "Structured for secure organizational separation across teams, workspaces and data access boundaries.",
  },
  {
    icon: <Eye className="h-5 w-5" />,
    title: "Access control and permissions",
    text: "Granular roles, scoped permissions and governance-ready access management built in from day one.",
  },
  {
    icon: <FolderLock className="h-5 w-5" />,
    title: "Audit logs and governance",
    text: "Maintain full visibility into activity, access and changes with audit-friendly operational control.",
  },
];

export function MarketingCapabilities() {
  return (
    <div id="product" className="mt-16 pt-2">
      <div className="text-center text-[10px] font-bold uppercase tracking-[0.3em] text-sky-400/70">
        Platform capabilities
      </div>
      <h2 className="mt-4 text-center text-3xl font-semibold tracking-tight text-white md:text-4xl">
        Everything you need to run AI securely
      </h2>

      <div className="mt-10 grid gap-3 md:grid-cols-2">
        {capabilities.map((item) => (
          <div
            key={item.title}
            className="group rounded-2xl border border-white/8 bg-[#0a1628]/50 p-6 transition-colors hover:border-sky-400/15 hover:bg-[#0a1628]/70"
          >
            <div className="mb-4 grid h-10 w-10 place-items-center rounded-xl border border-sky-400/15 bg-[#060d1f] text-sky-300">
              {item.icon}
            </div>
            <div className="text-sm font-semibold leading-snug text-white">{item.title}</div>
            <div className="mt-2 text-xs leading-[1.65] text-slate-400">{item.text}</div>
          </div>
        ))}
        {/* Fifth card spans full width on desktop */}
        <div className="md:col-span-2">
          <div className="h-px bg-white/5" />
        </div>
      </div>
    </div>
  );
}
