import { useQuery } from "@tanstack/react-query";
import {
  Activity, AlertTriangle, CheckCircle,
  TrendingUp, DollarSign, RefreshCw, ShieldAlert, Zap,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { friendlyError } from "@/lib/friendlyError";

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
      style={ok ? { boxShadow: "0 0 6px rgba(74,222,128,0.6)" } : { boxShadow: "0 0 6px rgba(239,68,68,0.6)" }}
    />
  );
}

function SummaryCard({
  label, value, icon: Icon, color, barColor, testId, loading,
}: {
  label: string;
  value: string | number;
  icon: React.ElementType;
  color: string;
  barColor?: string;
  testId: string;
  loading?: boolean;
}) {
  if (loading) return <Skeleton className="h-[78px]" data-testid={`ops-skeleton-${testId}`} />;
  return (
    <Card
      className="bg-card border-card-border relative overflow-hidden transition-all duration-200 hover:-translate-y-0.5"
      data-testid={`ops-summary-${testId}`}
    >
      {barColor && (
        <span className={`absolute left-0 top-0 bottom-0 w-0.5 rounded-r-full ${barColor}`} />
      )}
      <CardContent className="flex items-center gap-4 pt-5 pb-5">
        <div className={`flex items-center justify-center w-10 h-10 rounded-xl ${color} shrink-0`}>
          <Icon className="w-5 h-5" />
        </div>
        <div>
          <p className="text-xl font-bold text-foreground tabular-nums" data-testid={`ops-value-${testId}`}>
            {value}
          </p>
          <p className="text-xs text-muted-foreground font-medium mt-0.5">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export default function OpsDashboard() {
  const { user } = useAuth();
  const isPlatformAdmin = user?.role === "platform_admin";

  const { data: raw, isLoading, error, isFetching } = useQuery<{ data: OpsSummary }>({
    queryKey: OPS_SUMMARY_KEY,
    staleTime: 30_000,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    retry: false,
    enabled: isPlatformAdmin,
  });

  const ops           = raw?.data;
  const checks        = Object.entries(ops?.checks ?? {});
  const failedChecks  = checks.filter(([, v]) => !v.ok);
  const healthIcon    = ops?.healthStatus === "healthy" ? CheckCircle : AlertTriangle;
  const healthValue   =
    ops?.healthStatus === "healthy"  ? "Healthy"
    : ops?.healthStatus === "critical"  ? "Critical"
    : ops?.healthStatus === "degraded"  ? "Degraded"
    : "Unknown";
  const healthColor   =
    ops?.healthStatus === "healthy"
      ? "bg-green-500/12 text-green-400"
      : "bg-destructive/12 text-destructive";
  const healthBar     =
    ops?.healthStatus === "healthy" ? "bg-green-400" : "bg-destructive";

  function handleRefresh() {
    queryClient.invalidateQueries({ queryKey: OPS_SUMMARY_KEY });
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 md:p-8 space-y-7 max-w-6xl" data-testid="ops-dashboard-page">

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5">
            <div
              className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0"
              style={{ background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.20)" }}
            >
              <Activity className="w-4 h-4 text-destructive" />
            </div>
            <h1
              className="text-xl font-bold text-foreground tracking-tight"
              data-testid="text-ops-dashboard-title"
            >
              Platform Operations
            </h1>
          </div>
          <p className="text-sm text-muted-foreground ml-10">
            Real-time platform health, AI usage, and operational status
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleRefresh}
          disabled={isFetching}
          data-testid="button-ops-refresh"
          className="text-muted-foreground shrink-0"
        >
          <RefreshCw className={`w-4 h-4 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Error state */}
      {error && !isLoading && (
        <Card className="bg-destructive/8 border-destructive/25" data-testid="ops-error-card">
          <CardContent className="pt-4 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-destructive" />
            <p className="text-sm text-destructive">
              Ops summary unavailable — {friendlyError(error)}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <SummaryCard
          label="Platform Health"
          icon={healthIcon}
          value={isLoading ? "…" : healthValue}
          color={healthColor}
          barColor={healthBar}
          testId="health"
          loading={isLoading}
        />
        <SummaryCard
          label="Open Alerts"
          icon={ShieldAlert}
          value={isLoading ? "…" : (ops?.activeAlerts ?? 0)}
          color={(ops?.activeAlerts ?? 0) > 0 ? "bg-destructive/12 text-destructive" : "bg-primary/12 text-primary"}
          barColor={(ops?.activeAlerts ?? 0) > 0 ? "bg-destructive" : "bg-primary"}
          testId="alerts"
          loading={isLoading}
        />
        <SummaryCard
          label="Weekly Events"
          icon={TrendingUp}
          value={isLoading ? "…" : (ops?.totalEventsLast7d.toLocaleString() ?? "—")}
          color="bg-secondary/12 text-secondary"
          barColor="bg-secondary"
          testId="events"
          loading={isLoading}
        />
        <SummaryCard
          label="AI Cost (7d)"
          icon={DollarSign}
          value={isLoading ? "…" : (ops ? `$${ops.aiCostUsd.toFixed(2)}` : "—")}
          color="bg-green-500/12 text-green-400"
          barColor="bg-green-400"
          testId="cost"
          loading={isLoading}
        />
      </div>

      {/* Main content grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Service Checks */}
        <Card className="bg-card border-card-border" data-testid="ops-health-checks-card">
          <CardHeader className="pb-3 pt-5">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-primary" />
              Service Checks
              {ops && (
                <Badge
                  variant="outline"
                  className={`ml-auto text-xs ${
                    failedChecks.length === 0
                      ? "border-green-500/30 text-green-400 bg-green-500/8"
                      : "border-destructive/30 text-destructive bg-destructive/8"
                  }`}
                  data-testid="badge-service-status"
                >
                  {failedChecks.length === 0 ? "All passing" : `${failedChecks.length} failing`}
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-5">
            {isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-7" />
                ))}
              </div>
            ) : checks.length ? (
              <div className="space-y-1.5" data-testid="health-checks-list">
                {checks.map(([name, check]) => (
                  <div
                    key={name}
                    className="flex items-center justify-between py-2 px-3 rounded-lg bg-muted/25 hover:bg-muted/40 transition-colors"
                    data-testid={`health-check-${name}`}
                  >
                    <div className="flex items-center gap-2.5">
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
              <p className="text-xs text-muted-foreground py-4" data-testid="no-health-msg">
                No health data available
              </p>
            )}
          </CardContent>
        </Card>

        {/* Weekly Highlights */}
        <Card className="bg-card border-card-border" data-testid="ops-highlights-card">
          <CardHeader className="pb-3 pt-5">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Zap className="w-4 h-4 text-secondary" />
              Weekly Summary
              {ops && (
                <span className="text-xs font-normal text-muted-foreground ml-auto">
                  {ops.weekStart} → {ops.weekEnd}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-5">
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
                    className="text-xs text-foreground flex items-start gap-2.5 py-1.5 px-3 rounded-lg bg-muted/25"
                    data-testid={`highlight-row-${i}`}
                  >
                    <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0" style={{ boxShadow: "0 0 6px rgba(34,211,238,0.5)" }} />
                    {h}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="py-8 text-center" data-testid="no-highlights-msg">
                <RefreshCw className="w-7 h-7 text-muted-foreground/25 mx-auto mb-2" />
                <p className="text-xs text-muted-foreground">No highlights yet for this period</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Risk signals */}
      {!isLoading && (ops?.riskSignals.length ?? 0) > 0 && (
        <Card
          className="border-destructive/25"
          style={{ background: "rgba(239,68,68,0.06)" }}
          data-testid="ops-risk-signals-card"
        >
          <CardContent className="pt-5 pb-5">
            <div className="flex items-center gap-2 mb-4">
              <AlertTriangle className="w-4 h-4 text-destructive" />
              <p className="text-sm font-semibold text-destructive">
                {ops!.riskSignals.length} risk signal{ops!.riskSignals.length !== 1 ? "s" : ""} detected
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {ops!.riskSignals.map((signal, i) => (
                <Badge
                  key={i}
                  variant="outline"
                  className="text-xs bg-destructive/10 text-destructive border-destructive/25"
                  data-testid={`risk-signal-${i}`}
                >
                  {signal}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Failed checks */}
      {!isLoading && failedChecks.length > 0 && (
        <Card
          className="border-destructive/25"
          style={{ background: "rgba(239,68,68,0.06)" }}
          data-testid="ops-failed-checks-alert"
        >
          <CardContent className="pt-5 pb-5">
            <div className="flex items-center gap-2 mb-4">
              <AlertTriangle className="w-4 h-4 text-destructive" />
              <p className="text-sm font-semibold text-destructive">
                {failedChecks.length} check{failedChecks.length !== 1 ? "s" : ""} failing
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {failedChecks.map(([name, check]) => (
                <Badge
                  key={name}
                  variant="outline"
                  className="text-xs bg-destructive/10 text-destructive border-destructive/25"
                  data-testid={`failed-check-${name}`}
                >
                  {name}: {check.detail}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {ops && (
        <p className="text-[11px] text-muted-foreground/40 text-right" data-testid="ops-generated-at">
          Generated {new Date(ops.generatedAt).toLocaleTimeString()}
          {ops.fromCache ? " (cached)" : " (fresh)"}
        </p>
      )}
    </div>
  );
}
