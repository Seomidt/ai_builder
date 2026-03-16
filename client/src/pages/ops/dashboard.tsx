import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity, AlertTriangle, CheckCircle2, Clock,
  Server, ShieldAlert, Webhook, Zap, LayoutDashboard,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { OpsNav } from "@/components/ops/OpsNav";
import { MetricCard } from "@/components/ops/MetricCard";
import { StatusPill } from "@/components/ops/StatusPill";
import { TimeRangeFilter, TIME_RANGE_OPTIONS } from "@/components/ops/TimeRangeFilter";
import { TrendChart } from "@/components/ops/TrendChart";

interface PhealthResponse {
  summary: {
    overallStatus: string;
    jobsHealth:    { total: number; failed: number; stalled: number; failureRate: number };
    webhookHealth: { total: number; failed: number; pending: number; failureRate: number };
    latencyHealth: { p50Ms: number; p95Ms: number; p99Ms: number; sampleCount: number };
    securityHealth:{ violations: number; recentEvents: number };
    tenantHealth:  { total: number; active: number; suspended: number };
    queueDepth:    number;
    windowHours:   number;
  };
  explanation: { summary: string; issues: string[]; recommendations: string[] };
}

interface TrendResponse {
  trend: {
    points: { bucket: string; failedJobs: number; failedWebhooks: number; avgLatencyMs: number }[];
  };
}

export default function PlatformHealthDashboard() {
  const [windowHours, setWindowHours] = useState("24");

  const { data, isLoading, isError } = useQuery<PhealthResponse>({
    queryKey: ["/api/admin/analytics/platform-health", windowHours],
    queryFn: () =>
      fetch(`/api/admin/analytics/platform-health?windowHours=${windowHours}`, { credentials: "include" })
        .then(r => r.json()),
    refetchInterval: 60000,
  });

  const { data: trendData, isLoading: trendLoading } = useQuery<TrendResponse>({
    queryKey: ["/api/admin/analytics/platform-health/trend", windowHours],
    queryFn: () =>
      fetch(`/api/admin/analytics/platform-health/trend?windowHours=${windowHours}`, { credentials: "include" })
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
              <LayoutDashboard className="w-5 h-5 text-destructive" />
              Platform Health
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">System-wide operational health overview</p>
          </div>
          <div className="flex items-center gap-3">
            {s && <StatusPill status={s.overallStatus} testId="overall-status" />}
            <TimeRangeFilter value={windowHours} onChange={setWindowHours}
              options={TIME_RANGE_OPTIONS as unknown as { label: string; value: string }[]} />
          </div>
        </div>

        {isError && (
          <Card className="border-destructive/40">
            <CardContent className="pt-4 text-sm text-destructive" data-testid="error-state">
              Failed to load platform health data. Check admin permissions.
            </CardContent>
          </Card>
        )}

        {!isError && !isLoading && ex && ex.issues.length > 0 && (
          <Card className="border-yellow-500/30 bg-yellow-500/5">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-yellow-400" />
                Active Issues ({ex.issues.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {ex.issues.map((iss, i) => (
                <p key={i} className="text-sm text-yellow-300" data-testid={`issue-${i}`}>{iss}</p>
              ))}
            </CardContent>
          </Card>
        )}

        {!isError && !isLoading && ex && ex.issues.length === 0 && (
          <Card className="border-green-500/30 bg-green-500/5" data-testid="healthy-state">
            <CardContent className="pt-4 flex items-center gap-2 text-sm text-green-400">
              <CheckCircle2 className="w-4 h-4" /> All systems operating normally
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <MetricCard label="Overall Status" value={s?.overallStatus ?? "—"} icon={Activity}
            colorClass={s?.overallStatus === "healthy" ? "text-green-400" : s?.overallStatus === "critical" ? "text-red-400" : "text-yellow-400"}
            testId="metric-overall-status" loading={isLoading} />
          <MetricCard label="Queue Depth" value={s?.queueDepth ?? 0} icon={Server}
            subtext="Stalled + pending" testId="metric-queue-depth" loading={isLoading} />
          <MetricCard label="Job Failure Rate" value={s ? `${s.jobsHealth.failureRate}%` : "—"} icon={Zap}
            colorClass={s && s.jobsHealth.failureRate > 10 ? "text-red-400" : "text-green-400"}
            subtext={`${s?.jobsHealth.failed ?? 0} failed / ${s?.jobsHealth.total ?? 0} total`}
            testId="metric-job-failure-rate" loading={isLoading} />
          <MetricCard label="Webhook Failure Rate" value={s ? `${s.webhookHealth.failureRate}%` : "—"} icon={Webhook}
            colorClass={s && s.webhookHealth.failureRate > 10 ? "text-red-400" : "text-green-400"}
            subtext={`${s?.webhookHealth.failed ?? 0} failed`}
            testId="metric-webhook-failure-rate" loading={isLoading} />
          <MetricCard label="p50 Latency" value={s ? `${s.latencyHealth.p50Ms}ms` : "—"} icon={Clock}
            testId="metric-p50" loading={isLoading} />
          <MetricCard label="p95 Latency" value={s ? `${s.latencyHealth.p95Ms}ms` : "—"} icon={Clock}
            colorClass={s && s.latencyHealth.p95Ms > 5000 ? "text-red-400" : ""}
            subtext={`p99: ${s?.latencyHealth.p99Ms ?? 0}ms`}
            testId="metric-p95" loading={isLoading} />
          <MetricCard label="Security Violations" value={s?.securityHealth.violations ?? 0} icon={ShieldAlert}
            colorClass={s && s.securityHealth.violations > 0 ? "text-red-400" : "text-green-400"}
            subtext={`${s?.securityHealth.recentEvents ?? 0} total events`}
            testId="metric-security-violations" loading={isLoading} />
          <MetricCard label="Active Tenants" value={s?.tenantHealth.active ?? 0} icon={CheckCircle2}
            colorClass="text-green-400"
            subtext={`${s?.tenantHealth.suspended ?? 0} suspended`}
            testId="metric-active-tenants" loading={isLoading} />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <TrendChart
            title="Job & Webhook Failures Over Time"
            points={trendPoints}
            series={[
              { key: "failedJobs",     label: "Failed Jobs",     color: "#ef4444" },
              { key: "failedWebhooks", label: "Failed Webhooks", color: "#f97316" },
            ]}
            loading={trendLoading}
            testId="chart-job-webhook-trend"
          />
          <TrendChart
            title="Avg AI Latency Over Time"
            points={trendPoints}
            series={[{ key: "avgLatencyMs", label: "Avg Latency (ms)", color: "#6366f1" }]}
            loading={trendLoading}
            testId="chart-latency-trend"
          />
        </div>

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
