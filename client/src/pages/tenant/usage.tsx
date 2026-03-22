import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart2, Cpu, DollarSign, Zap, TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TenantNav } from "@/components/tenant/TenantNav";
import { cn } from "@/lib/utils";

interface UsageSummary {
  tenantId: string;
  period: string;
  summary: {
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    requests: number;
    modelsUsed: number;
  };
  daily: { day: string; requests: number; costUsd: number }[];
  retrievedAt: string;
}

const PERIODS = [
  { label: "7 days",  value: "7d"  },
  { label: "30 days", value: "30d" },
  { label: "90 days", value: "90d" },
];

function UsageCard({ label, value, unit, icon: Icon, testId }: {
  label: string; value: number; unit?: string; icon: React.ElementType; testId: string;
}) {
  return (
    <Card className="bg-card border-card-border" data-testid={`usage-card-${testId}`}>
      <CardContent className="pt-5">
        <div className="flex items-center gap-3 mb-2">
          <Icon className="w-4 h-4 text-primary" />
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
        <p className="text-2xl font-bold text-foreground" data-testid={`usage-value-${testId}`}>
          {unit === "$" && <span className="text-lg mr-0.5">$</span>}
          {typeof value === "number" ? value.toLocaleString(undefined, { maximumFractionDigits: 4 }) : value}
        </p>
      </CardContent>
    </Card>
  );
}

function UsageBar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="space-y-1" data-testid={`usage-bar-${label.toLowerCase().replace(/\s/g, "-")}`}>
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="text-foreground font-medium">{value}</span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default function TenantUsage() {
  const [period, setPeriod] = useState("30d");

  const { data, isLoading } = useQuery<UsageSummary>({
    queryKey: [`/api/tenant/usage?period=${period}`],
  });

  const maxRequests = Math.max(...(data?.daily.map((d) => d.requests) ?? [1]), 1);
  const maxCost     = Math.max(...(data?.daily.map((d) => d.costUsd)  ?? [1]), 0.01);

  return (
    <div className="flex flex-col h-full">
      <TenantNav />
      <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-6xl">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2.5">
              <div
                className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0"
                style={{ background: "rgba(34,211,238,0.12)", border: "1px solid rgba(34,211,238,0.20)" }}
              >
                <BarChart2 className="w-4 h-4 text-primary" />
              </div>
              <h1 className="text-xl font-bold text-foreground tracking-tight">Usage Monitoring</h1>
            </div>
            <p className="text-sm text-muted-foreground ml-10">Token consumption, costs, and trends</p>
          </div>
          <div className="flex items-center gap-1" data-testid="period-selector">
            {PERIODS.map((p) => (
              <Button
                key={p.value}
                variant={period === p.value ? "default" : "outline"}
                size="sm"
                onClick={() => setPeriod(p.value)}
                data-testid={`button-period-${p.value}`}
                className="text-xs"
              >
                {p.label}
              </Button>
            ))}
          </div>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {isLoading ? (
            Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)
          ) : (
            <>
              <UsageCard label="API Requests"    value={data?.summary.requests   ?? 0} icon={Zap}       testId="requests" />
              <UsageCard label="Tokens In"       value={data?.summary.tokensIn   ?? 0} icon={Cpu}       testId="tokens-in" />
              <UsageCard label="Tokens Out"      value={data?.summary.tokensOut  ?? 0} icon={TrendingUp} testId="tokens-out" />
              <UsageCard label="Total Cost (USD)" value={data?.summary.costUsd    ?? 0} icon={DollarSign} unit="$" testId="cost" />
            </>
          )}
        </div>

        {/* Daily Trends */}
        <Card className="bg-card border-card-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Daily Trends — {period}</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-6" />)}
              </div>
            ) : data?.daily?.length ? (
              <div className="space-y-3" data-testid="daily-trends-list">
                {data.daily.slice(-14).map((d) => (
                  <div key={d.day} data-testid={`daily-row-${d.day}`}>
                    <p className="text-xs text-muted-foreground mb-1">{d.day?.slice(0, 10)}</p>
                    <UsageBar label="Requests" value={d.requests} max={maxRequests} />
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-8 text-center">
                <BarChart2 className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground" data-testid="no-usage-msg">
                  No usage data for this period. Start using AI features to see metrics.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
