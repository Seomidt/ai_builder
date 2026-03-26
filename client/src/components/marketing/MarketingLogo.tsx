type MarketingLogoProps = {
  small?: boolean;
};

export function MarketingLogo({ small = false }: MarketingLogoProps) {
  const box = small ? "h-10 w-10" : "h-12 w-12";
  const svgSize = small ? 20 : 24;
  const nameSize = small ? "text-xl" : "text-2xl";
  const subSize = small ? "text-[10px]" : "text-xs";

  return (
    <div className="flex items-center gap-2.5">
      <div
        className={[
          "relative grid place-items-center rounded-xl border border-sky-400/25 bg-[#0d1424] shadow-[0_0_24px_rgba(56,189,248,0.18)]",
          box,
        ].join(" ")}
      >
        <div className="absolute inset-0 rounded-xl bg-[radial-gradient(circle_at_50%_35%,rgba(56,189,248,0.18),transparent_60%)]" />
        <svg
          width={svgSize}
          height={svgSize}
          viewBox="0 0 24 24"
          fill="none"
          className="relative z-10"
          aria-hidden="true"
        >
          <circle cx="12" cy="4.5" r="2.2" fill="#38BDF8" />
          <circle cx="5.25" cy="18" r="2.2" fill="#60A5FA" />
          <circle cx="18.75" cy="18" r="2.2" fill="#F59E0B" />
          <path
            d="M12 6.8L6.8 16.1M12 6.8L17.2 16.1M7.7 18h8.6"
            stroke="url(#lg)"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
          <defs>
            <linearGradient id="lg" x1="5" y1="5" x2="19" y2="19" gradientUnits="userSpaceOnUse">
              <stop stopColor="#7DD3FC" />
              <stop offset="1" stopColor="#FCD34D" />
            </linearGradient>
          </defs>
        </svg>
      </div>
      <div className="min-w-0">
        <div className={`${nameSize} font-semibold leading-tight tracking-tight text-white`}>
          BlissOps
        </div>
        <div className={`${subSize} text-slate-400 leading-tight`}>AI Infrastructure Platform</div>
      </div>
    </div>
  );
}
