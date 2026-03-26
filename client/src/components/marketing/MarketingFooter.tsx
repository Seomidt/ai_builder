import { MarketingLogo } from "./MarketingLogo";

const footerCols = [
  {
    title: "Product",
    items: ["Overview", "Features", "How it works", "Use cases"],
  },
  {
    title: "Security",
    items: ["Security", "Compliance", "Data privacy", "Architecture"],
  },
  {
    title: "Company",
    items: ["About", "Contact", "Privacy Policy", "Terms"],
  },
];

export function MarketingFooter() {
  return (
    <footer
      id="contact"
      className="mt-16 border-t border-white/8 pt-10 pb-8"
    >
      <div className="grid gap-10 md:grid-cols-[1fr_auto]">
        {/* Left: brand */}
        <div className="max-w-xs">
          <MarketingLogo small />
          <p className="mt-4 text-xs leading-6 text-slate-500">
            Built for secure AI infrastructure.
          </p>
          <p className="mt-6 text-xs text-slate-600">
            © 2026 BlissOps. All rights reserved.
          </p>
        </div>

        {/* Right: nav columns */}
        <div className="grid grid-cols-3 gap-10">
          {footerCols.map((col) => (
            <div key={col.title}>
              <div className="mb-4 text-xs font-semibold text-white">{col.title}</div>
              <div className="space-y-2.5">
                {col.items.map((item) => (
                  <div
                    key={item}
                    className="text-xs text-slate-500 transition hover:text-slate-300 cursor-pointer"
                  >
                    {item}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </footer>
  );
}
