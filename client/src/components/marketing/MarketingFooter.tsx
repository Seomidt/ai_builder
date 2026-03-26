import { MarketingLogo } from "./MarketingLogo";

export function MarketingFooter() {
  return (
    <footer
      id="contact"
      className="mt-16 border-t border-white/8 pt-8 pb-6"
    >
      <div className="flex flex-col gap-1">
        <MarketingLogo small />
        <p className="mt-3 text-xs leading-6 text-slate-500">
          Built for secure AI infrastructure.
        </p>
        <p className="mt-4 text-xs text-slate-600">
          © 2026 BlissOps. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
