interface BrandMarkProps {
  size?: number;
  className?: string;
}

export function BrandMark({ size = 32, className }: BrandMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="BlissOps"
    >
      <rect width="64" height="64" rx="14" fill="#0c1524" />
      <rect x="1" y="1" width="62" height="62" rx="13" stroke="#22D3EE" strokeOpacity="0.22" fill="none" />
      {/* Connection lines */}
      <line x1="32" y1="14" x2="17" y2="42" stroke="#22D3EE" strokeOpacity="0.4" strokeWidth="2.5" strokeLinecap="round" />
      <line x1="32" y1="14" x2="47" y2="42" stroke="#22D3EE" strokeOpacity="0.4" strokeWidth="2.5" strokeLinecap="round" />
      <line x1="17" y1="42" x2="47" y2="42" stroke="#F59E0B" strokeOpacity="0.45" strokeWidth="2.5" strokeLinecap="round" />
      {/* Nodes */}
      <circle cx="32" cy="14" r="5" fill="#22D3EE" />
      <circle cx="17" cy="42" r="4.5" fill="#22D3EE" fillOpacity="0.7" />
      <circle cx="47" cy="42" r="4.5" fill="#F59E0B" />
    </svg>
  );
}
