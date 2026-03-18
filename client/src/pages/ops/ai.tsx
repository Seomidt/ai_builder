import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BrainCircuit, DollarSign, AlertTriangle, Zap, TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { OpsNav } from "@/components/ops/OpsNav";
import { MetricCard } from "@/components/ops/MetricCard";
import { TimeRangeFilter, TIME_RANGE_OPTIONS } from "@/components/ops/TimeRangeFilter";
import { TrendChart } from "@/components/ops/TrendChart";
import { TopList } from "@/components/ops/TopList";

interface AiCostResponse {
  summary: {
    totalRequests: number;
    totalTokensIn: number;
    totalTokensOut: number;
    totalCostUsd: number;
    avgCostPerRequest: number;
    alertCount: number;
    anomalyCount: number;
    topSpendersByTenant: { tenantId: string; costUsd: number; requests: number }[];
    topSpendersByModel:  { model: string; requests: number; totalTokens: number; costUsd: number }[];
    budgetPressure:      { tenantId: string; usagePercent: number; alertType: string }[];
    windowHours: number;
  };
  explanation: { summary: string; issues: string[]; recommendations: string[] };
}

interface TrendResponse {
  trend: {
    points: { bucket: string; requests: number; tokensTotal: number; costUsd: number; anomalies: number }[];
  };
}

export default function AiCostDashboard() {
  const [windowHours, setWindowHours] = useState("24");

  const { data, isLoading } = useQuery<AiCostResponse>({
    queryKey: ["/api/admin/analytics/ai-cost", windowHours],
    queryFn: () =>
      fetch(`/api/admin/analytics/ai-cost?windowHours=${windowHours}`, { credentials: "include" })
        .then(r => r.json()),
    refetchInterval: 60000,
  });

  const { data: trendData, isLoading: trendLoading } = useQuery<TrendResponse>({
    queryKey: ["/api/admin/analytics/ai-cost/trend", windowHours],
    queryFn: () =>
      fetch(`/api/admin/analytics/ai-cost/trend?windowHours=${windowHours}`, { credentials: "include" })
        .then(r => r.json()),
    refetchInterval: 60000,
  });

  const s  = data?.summary;
  const ex = data?.explanation;
  const trendPoints = trendData?.trend?.points ?? [];

  return (
    <div className="flex min-h-screen bg-background">
      <OpsNav />
      <main className="flex-1 p-6 space-y-6 max-w-6xl">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold flex items-center gap-2" data-testid="page-title">
              <BrainCircuit className="w-5 h-5 text-destructive" /> AI & Cost Analytics
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Token usage, costs, anomalies and budget pressure
            </p>
          </div>
          <TimeRangeFilter value={windowHours} onChange={setWindowHours}
            options={TIME_RANGE_OPTIONS as unknown as { label: string; value: string }[]} />
        </div>

        {ex && ex.issues.length > 0 && (
          <Card className="border-yellow-500/30 bg-yellow-500/5">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-yellow-400" /> Issues ({ex.issues.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {ex.issues.map((iss, i) => (
                <p key={i} className="text-sm text-yellow-300" data-testid={`issue-${i}`}>{iss}</p>
              ))}
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <MetricCard label="Total Requests"    value={s?.totalRequests ?? 0} icon={BrainCircuit}
            testId="metric-total-requests" loading={isLoading} />
          <MetricCard label="Total Cost (USD)"  value={s ? `$${s.totalCostUsd.toFixed(4)}` : "—"} icon={DollarSign}
            subtext={`Avg $${s?.avgCostPerRequest.toFixed(6) ?? "—"} / req`}
            testId="metric-total-cost" loading={isLoading} />
          <MetricCard label="Tokens In"         value={s?.totalTokensIn.toLocaleString()  ?? 0} icon={Zap}
            testId="metric-tokens-in" loading={isLoading} />
          <MetricCard label="Tokens Out"        value={s?.totalTokensOut.toLocaleString() ?? 0} icon={Zap}
            testId="metric-tokens-out" loading={isLoading} />
          <MetricCard label="Budget Alerts"     value={s?.alertCount ?? 0} icon={AlertTriangle}
            colorClass={s && s.alertCount > 0 ? "text-orange-400" : "text-green-400"}
            testId="metric-alerts" loading={isLoading} />
          <MetricCard label="Anomalies"         value={s?.anomalyCount ?? 0} icon={TrendingUp}
            colorClass={s && s.anomalyCount > 0 ? "text-red-400" : "text-green-400"}
            testId="metric-anomalies" loading={isLoading} />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <TrendChart
            title="Daily Requests & Cost"
            points={trendPoints}
            series={[
              { key: "requests", label: "Requests", color: "#6366f1" },
            ]}
            loading={trendLoading}
            testId="chart-requests-trend"
          />
          <TrendChart
            title="Cost & Anomalies Over Time"
            points={trendPoints}
            series={[
              { key: "costUsd",   label: "Cost (USD)",  color: "#22c55e" },
              { key: "anomalies", label: "Anomalies",   color: "#ef4444" },
            ]}
            loading={trendLoading}
            testId="chart-cost-trend"
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <TopList
            title="Top Spenders by Tenant"
            loading={isLoading}
            testId="list-top-tenant-spenders"
            emptyText="No spend data in window"
            items={(s?.topSpendersByTenant ?? []).map(t => ({
              id: t.tenantId,
              label: t.tenantId,
              value: `$${t.costUsd.toFixed(4)}`,
              subvalue: `${t.requests} requests`,
            }))}
          />
          <TopList
            title="Top Spenders by Model"
            loading={isLoading}
            testId="list-top-model-spenders"
            emptyText="No model data in window"
            items={(s?.topSpendersByModel ?? []).map(m => ({
              id: m.model,
              label: m.model,
              value: `$${m.costUsd.toFixed(4)}`,
              subvalue: `${m.requests} reqs · ${m.totalTokens.toLocaleString()} tokens`,
            }))}
          />
        </div>

        {s && s.budgetPressure.length > 0 && (
          <Card className="border-orange-500/30">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-orange-400" />
                Budget Pressure ({s.budgetPressure.length} tenant{s.budgetPressure.length > 1 ? "s" : ""})
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {s.budgetPressure.map((b, i) => (
                <div key={i} className="flex items-center justify-between px-4 py-2 border-b border-border last:border-0"
                  data-testid={`budget-pressure-${i}`}>
                  <span className="text-sm font-mono text-muted-foreground">{b.tenantId}</span>
                  <span className="text-xs text-muted-foreground">{b.alertType}</span>
                  <span className={`text-sm font-semibold tabular-nums ${b.usagePercent >= 90 ? "text-red-400" : "text-orange-400"}`}>
                    {b.usagePercent.toFixed(1)}%
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {ex && ex.recommendations.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold">Recommendations</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {ex.recommendations.map((r, i) => (
                <p key={i} className="text-sm text-muted-foreground" data-testid={`rec-${i}`}>• {r}</p>
              ))}
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
