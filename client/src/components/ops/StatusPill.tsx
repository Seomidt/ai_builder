import { Badge } from "@/components/ui/badge";

type Status = "healthy" | "degraded" | "critical" | "unknown" | "active" | "suspended" | "trial" | "deleted";

const colorMap: Record<string, string> = {
  healthy:   "bg-green-500/15 text-green-400 border-green-500/25",
  active:    "bg-green-500/15 text-green-400 border-green-500/25",
  degraded:  "bg-yellow-500/15 text-yellow-400 border-yellow-500/25",
  trial:     "bg-blue-500/15 text-blue-400 border-blue-500/25",
  critical:  "bg-red-500/15 text-red-400 border-red-500/25",
  suspended: "bg-red-500/15 text-red-400 border-red-500/25",
  deleted:   "bg-muted text-muted-foreground border-border",
  unknown:   "bg-muted text-muted-foreground border-border",
};

interface StatusPillProps {
  status: string;
  testId?: string;
}

export function StatusPill({ status, testId }: StatusPillProps) {
  const cls = colorMap[status.toLowerCase()] ?? colorMap.unknown;
  return (
    <Badge variant="outline" className={`text-xs ${cls}`} data-testid={testId}>
      {status}
    </Badge>
  );
}
