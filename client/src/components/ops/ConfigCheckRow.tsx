import { CheckCircle2, XCircle, AlertTriangle } from "lucide-react";

type CheckStatus = "ok" | "error" | "warning" | "unknown";

interface ConfigCheckRowProps {
  label: string;
  status: CheckStatus;
  detail?: string;
  testId?: string;
}

const iconMap: Record<CheckStatus, { icon: typeof CheckCircle2; className: string }> = {
  ok:      { icon: CheckCircle2,  className: "text-green-400" },
  error:   { icon: XCircle,       className: "text-red-400"   },
  warning: { icon: AlertTriangle, className: "text-yellow-400" },
  unknown: { icon: AlertTriangle, className: "text-muted-foreground" },
};

export function ConfigCheckRow({ label, status, detail, testId }: ConfigCheckRowProps) {
  const { icon: Icon, className } = iconMap[status] ?? iconMap.unknown;
  return (
    <div
      className="flex items-center justify-between py-2 border-b border-border last:border-0"
      data-testid={testId}
    >
      <div className="flex items-center gap-2 min-w-0">
        <Icon className={`w-4 h-4 shrink-0 ${className}`} data-testid={testId ? `${testId}-icon` : undefined} />
        <span className="text-sm font-medium truncate" title={label}>{label}</span>
      </div>
      {detail && (
        <span className="text-xs text-muted-foreground ml-4 shrink-0 max-w-[200px] truncate" title={detail}>
          {detail}
        </span>
      )}
    </div>
  );
}
