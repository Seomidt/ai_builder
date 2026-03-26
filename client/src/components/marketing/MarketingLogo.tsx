type MarketingLogoProps = {
  small?: boolean;
};

export function MarketingLogo({ small = false }: MarketingLogoProps) {
  return (
    <div className="flex items-center gap-3">
      <div
        className={[
          "relative grid place-items-center rounded-xl border border-sky-400/20 bg-slate-950/80 shadow-[0_0_30px_rgba(59,130,246,0.12)]",
          small ? "h-10 w-10" : "h-12 w-12",
        ].join(" ")}
      >
        <div className="absolute inset-0 rounded-xl bg-[radial-gradient(circle_at_50%_40%,rgba(59,130,246,0.22),transparent_65%)]" />

        <svg
          width={small ? 22 : 26}
          height={small ? 22 : 26}
          viewBox="0 0 24 24"
          fill="none"
          className="relative"
          aria-hidden="true"
        >
          <circle cx="12" cy="4.5" r="2.2" fill="#38BDF8" />
          <circle cx="5.25" cy="18" r="2.2" fill="#60A5FA" />
          <circle cx="18.75" cy="18" r="2.2" fill="#F59E0B" />
          <path
            d="M12 6.8L6.8 16.1M12 6.8L17.2 16.1M7.7 18h8.6"
            stroke="url(#blissops-gradient)"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
          <defs>
            <linearGradient
              id="blissops-gradient"
              x1="5"
              y1="5"
              x2="19"
              y2="19"
              gradientUnits="userSpaceOnUse"
            >
              <stop stopColor="#7DD3FC" />
              <stop offset="1" stopColor="#FCD34D" />
            </linearGradient>
          </defs>
        </svg>
      </div>

      <div className="min-w-0">
        <div
          className={
            small
              ? "text-2xl font-semibold tracking-tight text-white"
              : "text-[2rem] font-semibold tracking-tight text-white"
          }
        >
          BlissOps
        </div>
        <div className={small ? "text-xs text-slate-400" : "text-sm text-slate-400"}>
          AI Infrastructure Platform
        </div>
      </div>
    </div>
  );
}
