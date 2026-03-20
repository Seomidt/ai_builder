import { useQuery } from "@tanstack/react-query";
import {
  Activity, AlertTriangle, CheckCircle,
  TrendingUp, DollarSign, RefreshCw, ShieldAlert,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { queryClient } from "@/lib/queryClient";
import { QUERY_POLICY } from "@/lib/query-policy";

interface OpsSummary {
  healthStatus: "healthy" | "degraded" | "critical" | "unknown";
  checks: Record<string, { ok: boolean; detail?: string }>;
  activeAlerts: number;
  recentAnomalies: number;
  totalEventsLast7d: number;
  aiCostUsd: number;
  weekStart: string;
  weekEnd: string;
  highlights: string[];
  riskSignals: string[];
  generatedAt: string;
  cachedAt: string | null;
  fromCache: boolean;
}

const OPS_SUMMARY_KEY = ["/api/admin/ops-summary"] as const;

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${ok ? "bg-green-400" : "bg-destructive"}`}
    />
  );
}

function SummaryCard({
  label, value, icon: Icon, color, testId, loading,
}: {
  label: string;
  value: string | number;
  icon: React.ElementType;
  color: string;
  testId: string;
  loading?: boolean;
}) {
  if (loading) return <Skeleton className="h-20" data-testid={`ops-skeleton-${testId}`} />;
  return (
    <Card className="bg-card border-card-border" data-testid={`ops-summary-${testId}`}>
      <CardContent className="flex items-center gap-4 pt-5">
        <div className={`flex items-center justify-center w-10 h-10 rounded-lg ${color}`}>
          <Icon className="w-5 h-5" />
        </div>
        <div>
          <p className="text-xl font-bold text-foreground" data-testid={`ops-value-${testId}`}>
            {value}
          </p>
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export default function OpsDashboard() {
  const { data: raw, isLoading, error, isFetching } = useQuery<{ data: OpsSummary }>({
    queryKey: OPS_SUMMARY_KEY,
    ...QUERY_POLICY.semiLive,
  });

  const ops = raw?.data;
  const checks = Object.entries(ops?.checks ?? {});
  const failedChecks = checks.filter(([, v]) => !v.ok);
  const healthIcon = ops?.healthStatus === "healthy" ? CheckCircle : AlertTriangle;
  const healthValue =
    ops?.healthStatus === "healthy" ? "Healthy"
    : ops?.healthStatus === "critical" ? "Critical"
    : ops?.healthStatus === "degraded" ? "Degraded"
    : "Unknown";
  const healthColor =
    ops?.healthStatus === "healthy"
      ? "bg-green-500/15 text-green-400"
      : "bg-destructive/15 text-destructive";

  function handleRefresh() {
    queryClient.invalidateQueries({ queryKey: OPS_SUMMARY_KEY });
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-6xl" data-testid="ops-dashboard-page">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1
            className="text-xl font-semibold text-foreground flex items-center gap-2"
            data-testid="text-ops-dashboard-title"
          >
            <Activity className="w-5 h-5 text-primary" /> Platform Operations
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Real-time platform health, AI usage, and operational status
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleRefresh}
          disabled={isFetching}
          data-testid="button-ops-refresh"
          className="text-muted-foreground"
        >
          <RefreshCw className={`w-4 h-4 mr-1.5 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Error state */}
      {error && !isLoading && (
        <Card className="bg-destructive/10 border-destructive/30" data-testid="ops-error-card">
          <CardContent className="pt-4 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-destructive" />
            <p className="text-sm text-destructive">
              Ops summary unavailable — {error instanceof Error ? error.message : "unknown error"}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Summary cards — one query, no waterfall */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <SummaryCard
          label="Platform Health"
          icon={healthIcon}
          value={isLoading ? "…" : healthValue}
          color={healthColor}
          testId="health"
          loading={isLoading}
        />
        <SummaryCard
          label="Open Alerts"
          icon={ShieldAlert}
          value={isLoading ? "…" : (ops?.activeAlerts ?? 0)}
          color={
            (ops?.activeAlerts ?? 0) > 0
              ? "bg-destructive/15 text-destructive"
              : "bg-primary/15 text-primary"
          }
          testId="alerts"
          loading={isLoading}
        />
        <SummaryCard
          label="Weekly Events"
          icon={TrendingUp}
          value={isLoading ? "…" : (ops?.totalEventsLast7d.toLocaleString() ?? "—")}
          color="bg-secondary/15 text-secondary"
          testId="events"
          loading={isLoading}
        />
        <SummaryCard
          label="AI Cost (7d)"
          icon={DollarSign}
          value={isLoading ? "…" : (ops ? `$${ops.aiCostUsd.toFixed(2)}` : "—")}
          color="bg-green-500/15 text-green-400"
          testId="cost"
          loading={isLoading}
        />
      </div>

      {/* Main content grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Service Checks */}
        <Card className="bg-card border-card-border" data-testid="ops-health-checks-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-primary" /> Service Checks
              {ops && (
                <Badge
                  variant="outline"
                  className={`ml-auto text-xs ${
                    failedChecks.length === 0
                      ? "border-green-500/40 text-green-400"
                      : "border-destructive/40 text-destructive"
                  }`}
                  data-testid="badge-service-status"
                >
                  {failedChecks.length === 0 ? "All passing" : `${failedChecks.length} failing`}
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-7" />
                ))}
              </div>
            ) : checks.length ? (
              <div className="space-y-2" data-testid="health-checks-list">
                {checks.map(([name, check]) => (
                  <div
                    key={name}
                    className="flex items-center justify-between py-1"
                    data-testid={`health-check-${name}`}
                  >
                    <div className="flex items-center gap-2">
                      <StatusDot ok={check.ok} />
                      <span className="text-xs font-mono text-foreground">{name}</span>
                    </div>
                    <span className="text-xs text-muted-foreground max-w-[180px] truncate text-right">
                      {check.detail ?? (check.ok ? "ok" : "failed")}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground" data-testid="no-health-msg">
                No health data available
              </p>
            )}
          </CardContent>
        </Card>

        {/* Weekly Highlights */}
        <Card className="bg-card border-card-border" data-testid="ops-highlights-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <RefreshCw className="w-4 h-4 text-primary" /> Weekly Summary
              {ops && (
                <span className="text-xs font-normal text-muted-foreground ml-auto">
                  {ops.weekStart} → {ops.weekEnd}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-7" />
                ))}
              </div>
            ) : (ops?.highlights.length ?? 0) > 0 ? (
              <ul className="space-y-2" data-testid="ops-highlights-list">
                {ops!.highlights.map((h, i) => (
                  <li
                    key={i}
                    className="text-xs text-foreground flex items-start gap-2 py-0.5"
                    data-testid={`highlight-row-${i}`}
                  >
                    <span className="mt-0.5 w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0" />
                    {h}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="py-6 text-center" data-testid="no-highlights-msg">
                <RefreshCw className="w-7 h-7 text-muted-foreground/40 mx-auto mb-2" />
                <p className="text-xs text-muted-foreground">No highlights yet for this period</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Risk signals — deferred section, only shown when data present */}
      {!isLoading && (ops?.riskSignals.length ?? 0) > 0 && (
        <Card className="bg-destructive/10 border-destructive/30" data-testid="ops-risk-signals-card">
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="w-4 h-4 text-destructive" />
              <p className="text-sm font-medium text-destructive">
                {ops!.riskSignals.length} risk signal{ops!.riskSignals.length !== 1 ? "s" : ""} detected
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {ops!.riskSignals.map((signal, i) => (
                <Badge
                  key={i}
                  variant="outline"
                  className="text-xs bg-destructive/10 text-destructive border-destructive/30"
                  data-testid={`risk-signal-${i}`}
                >
                  {signal}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Failed checks detail — deferred section */}
      {!isLoading && failedChecks.length > 0 && (
        <Card className="bg-destructive/10 border-destructive/30" data-testid="ops-failed-checks-alert">
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="w-4 h-4 text-destructive" />
              <p className="text-sm font-medium text-destructive">
                {failedChecks.length} check{failedChecks.length !== 1 ? "s" : ""} failing
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {failedChecks.map(([name, check]) => (
                <Badge
                  key={name}
                  variant="outline"
                  className="text-xs bg-destructive/10 text-destructive border-destructive/30"
                  data-testid={`failed-check-${name}`}
                >
                  {name}: {check.detail}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Cache indicator — dev only hint */}
      {ops && (
        <p className="text-[11px] text-muted-foreground/50 text-right" data-testid="ops-generated-at">
          Generated {new Date(ops.generatedAt).toLocaleTimeString()}
          {ops.fromCache ? " (cached)" : " (fresh)"}
        </p>
      )}
    </div>
  );
}
