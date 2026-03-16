import { Badge } from "@/components/ui/badge";

type RiskLevel = "low" | "medium" | "high" | "critical";

const colorMap: Record<RiskLevel, string> = {
  low:      "bg-green-500/15 text-green-400 border-green-500/25",
  medium:   "bg-yellow-500/15 text-yellow-400 border-yellow-500/25",
  high:     "bg-orange-500/15 text-orange-400 border-orange-500/25",
  critical: "bg-red-500/15 text-red-400 border-red-500/25",
};

interface RiskBadgeProps {
  level: string;
  score?: number;
  testId?: string;
}

export function RiskBadge({ level, score, testId }: RiskBadgeProps) {
  const key = (level ?? "low").toLowerCase() as RiskLevel;
  const cls = colorMap[key] ?? colorMap.low;
  return (
    <Badge variant="outline" className={`text-xs font-medium ${cls}`} data-testid={testId}>
      {level}{score !== undefined ? ` (${score})` : ""}
    </Badge>
  );
}
