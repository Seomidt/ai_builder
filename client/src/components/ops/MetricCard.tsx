import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { LucideIcon } from "lucide-react";

interface MetricCardProps {
  label: string;
  value: string | number;
  subtext?: string;
  icon?: LucideIcon;
  trend?: "up" | "down" | "flat";
  trendValue?: string;
  colorClass?: string;
  testId?: string;
  loading?: boolean;
}

export function MetricCard({
  label, value, subtext, icon: Icon, colorClass = "", testId, loading,
}: MetricCardProps) {
  if (loading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <Skeleton className="h-4 w-32" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-8 w-24 mb-1" />
          <Skeleton className="h-3 w-40" />
        </CardContent>
      </Card>
    );
  }
  return (
    <Card data-testid={testId}>
      <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
        {Icon && <Icon className={`w-4 h-4 ${colorClass || "text-muted-foreground"}`} />}
      </CardHeader>
      <CardContent>
        <div className={`text-2xl font-bold ${colorClass}`} data-testid={testId ? `${testId}-value` : undefined}>
          {value}
        </div>
        {subtext && (
          <p className="text-xs text-muted-foreground mt-1" data-testid={testId ? `${testId}-subtext` : undefined}>
            {subtext}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
