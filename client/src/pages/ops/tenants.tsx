import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Building2, AlertTriangle, Users } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { OpsNav } from "@/components/ops/OpsNav";
import { MetricCard } from "@/components/ops/MetricCard";
import { RiskBadge } from "@/components/ops/RiskBadge";
import { TimeRangeFilter, TIME_RANGE_OPTIONS } from "@/components/ops/TimeRangeFilter";
import { TrendChart } from "@/components/ops/TrendChart";
import { TopList } from "@/components/ops/TopList";

interface TenantHealthRow {
  tenantId: string;
  name: string;
  status: string;
  anomalyCount: number;
  failedWebhooks: number;
  failedJobs: number;
  alertCount: number;
  riskScore: number;
  riskLevel: string;
}

interface TenantHealthResponse {
  summary: {
    totalTenants: number;
    activeTenants: number;
    suspendedTenants: number;
    highRiskCount: number;
    criticalRiskCount: number;
    topRiskTenants: TenantHealthRow[];
    windowHours: number;
  };
  explanation: { summary: string; issues: string[]; recommendations: string[] };
}

interface TrendResponse {
  trend: {
    points: { bucket: string; newAnomalies: number; newAlerts: number; failedWebhooks: number }[];
  };
}

export default function TenantHealthDashboard() {
  const [windowHours, setWindowHours] = useState("24");
  const [search, setSearch] = useState("");

  const { data, isLoading } = useQuery<TenantHealthResponse>({
    queryKey: ["/api/admin/analytics/tenant-health", windowHours],
    queryFn: () =>
      fetch(`/api/admin/analytics/tenant-health?windowHours=${windowHours}`, { credentials: "include" })
        .then(r => r.json()),
    refetchInterval: 60000,
  });

  const { data: trendData, isLoading: trendLoading } = useQuery<TrendResponse>({
    queryKey: ["/api/admin/analytics/tenant-health/trend", windowHours],
    queryFn: () =>
      fetch(`/api/admin/analytics/tenant-health/trend?windowHours=${windowHours}`, { credentials: "include" })
        .then(r => r.json()),
    refetchInterval: 60000,
  });

  const s  = data?.summary;
  const ex = data?.explanation;
  const trendPoints = trendData?.trend?.points ?? [];

  const filtered = (s?.topRiskTenants ?? []).filter(t =>
    !search || t.tenantId.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="flex min-h-screen bg-background">
      <OpsNav />
      <main className="flex-1 p-6 space-y-6 max-w-6xl">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold flex items-center gap-2" data-testid="page-title">
              <Building2 className="w-5 h-5 text-destructive" /> Tenant Health
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Identify unhealthy or high-risk tenants
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
          <MetricCard label="Total Tenants"    value={s?.totalTenants    ?? 0} icon={Users}
            testId="metric-total-tenants" loading={isLoading} />
          <MetricCard label="Active Tenants"   value={s?.activeTenants   ?? 0} icon={Building2}
            colorClass="text-green-400" testId="metric-active-tenants" loading={isLoading} />
          <MetricCard label="High Risk"        value={s?.highRiskCount   ?? 0} icon={AlertTriangle}
            colorClass={s && s.highRiskCount > 0 ? "text-orange-400" : "text-green-400"}
            testId="metric-high-risk" loading={isLoading} />
          <MetricCard label="Critical Risk"    value={s?.criticalRiskCount ?? 0} icon={AlertTriangle}
            colorClass={s && s.criticalRiskCount > 0 ? "text-red-400" : "text-green-400"}
            testId="metric-critical-risk" loading={isLoading} />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <TrendChart
            title="Anomalies & Alerts Over Time"
            points={trendPoints}
            series={[
              { key: "newAnomalies",   label: "Anomalies",       color: "#ef4444" },
              { key: "newAlerts",      label: "Alerts",          color: "#f97316" },
              { key: "failedWebhooks", label: "Failed Webhooks", color: "#6366f1" },
            ]}
            loading={trendLoading}
            testId="chart-tenant-trend"
          />
          <TopList
            title="Top High-Risk Tenants"
            loading={isLoading}
            testId="list-top-risk"
            emptyText="No high-risk tenants detected"
            items={(s?.topRiskTenants ?? []).slice(0, 10).map(t => ({
              id: t.tenantId,
              label: t.tenantId,
              value: `Score: ${t.riskScore}`,
              subvalue: `${t.anomalyCount} anomalies · ${t.failedWebhooks} wh failures`,
              badge: <RiskBadge level={t.riskLevel} />,
            }))}
          />
        </div>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-semibold">Tenant Risk Table</CardTitle>
              <Input
                placeholder="Search tenant ID…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-48 h-8 text-xs"
                data-testid="input-tenant-search"
              />
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="h-10 bg-muted/30 rounded animate-pulse" />
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <p className="p-6 text-sm text-center text-muted-foreground" data-testid="empty-state">
                {search ? "No tenants match your search" : "No tenant risk data in this window"}
              </p>
            ) : (
              <div data-testid="tenant-risk-table">
                {filtered.map(t => (
                  <div
                    key={t.tenantId}
                    className="flex items-center justify-between px-4 py-3 border-b border-border last:border-0 hover:bg-muted/10"
                    data-testid={`tenant-row-${t.tenantId}`}
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-mono truncate" title={t.tenantId}>{t.tenantId}</p>
                      <p className="text-xs text-muted-foreground">
                        {t.anomalyCount} anomalies · {t.failedJobs} failed jobs · {t.failedWebhooks} wh failures
                      </p>
                    </div>
                    <div className="flex items-center gap-3 ml-4 shrink-0">
                      <span className="text-xs text-muted-foreground tabular-nums">{t.alertCount} alerts</span>
                      <RiskBadge level={t.riskLevel} score={t.riskScore} testId={`risk-${t.tenantId}`} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
