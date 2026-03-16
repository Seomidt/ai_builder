import { useQuery } from "@tanstack/react-query";
import {
  LayoutDashboard, Activity, Building2, ShieldAlert,
  Cpu, Webhook, BrainCircuit, AlertTriangle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { OpsNav } from "@/components/ops/OpsNav";

interface PlatformHealth {
  status?: string;
  services?: { name: string; status: string; latencyMs?: number }[];
  queueDepth?: number;
  errorRate?: number;
  requestsPerMinute?: number;
  webhookFailureRate?: number;
  aiTokenUsage?: number;
  activeTenants?: number;
  retrievedAt?: string;
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    healthy:  "bg-green-500/15 text-green-400 border-green-500/25",
    degraded: "bg-secondary/15 text-secondary border-secondary/25",
    critical: "bg-destructive/15 text-destructive border-destructive/25",
    unknown:  "bg-muted text-muted-foreground border-border",
  };
  return (
    <Badge variant="outline" className={`text-xs ${map[status] ?? map.unknown}`}>
      {status}
    </Badge>
  );
}

function MetricCard({ label, value, icon: Icon, subtext, testId }: {
  label: string; value: string | number; icon: React.ElementType; subtext?: string; testId: string;
}) {
  return (
    <Card className="bg-card border-card-border" data-testid={`ops-metric-${testId}`}>
      <CardContent className="pt-5">
        <div className="flex items-center gap-2 mb-2">
          <Icon className="w-4 h-4 text-destructive" />
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
        <p className="text-2xl font-bold" data-testid={`ops-metric-value-${testId}`}>{value}</p>
        {subtext && <p className="text-xs text-muted-foreground mt-0.5">{subtext}</p>}
      </CardContent>
    </Card>
  );
}

export default function OpsDashboard() {
  const { data, isLoading } = useQuery<PlatformHealth>({
    queryKey: ["/api/admin/platform/health"],
  });

  const statusColor = (data?.status ?? "unknown") === "healthy"
    ? "border-green-500/30 bg-green-500/5"
    : "border-secondary/30 bg-secondary/5";

  return (
    <div className="flex flex-col h-full">
      <OpsNav />
      <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-6xl">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
              <LayoutDashboard className="w-5 h-5 text-destructive" />
              Platform Operations Console
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Internal platform-wide monitoring — operator access only
            </p>
          </div>
          {!isLoading && (
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border ${statusColor}`} data-testid="ops-system-status">
              <Activity className="w-3.5 h-3.5 text-green-400" />
              <span className="text-xs font-medium">System {data?.status ?? "unknown"}</span>
            </div>
          )}
        </div>

        {/* Quick Metrics */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {isLoading ? (
            Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)
          ) : (
            <>
              <MetricCard label="Active Tenants"       value={data?.activeTenants        ?? "—"} icon={Building2}   subtext="registered organizations" testId="active-tenants" />
              <MetricCard label="Req / Minute"         value={data?.requestsPerMinute    ?? "—"} icon={Activity}    subtext="rolling 1-min average"    testId="rpm" />
              <MetricCard label="AI Token Usage"       value={data?.aiTokenUsage         ?? "—"} icon={BrainCircuit} subtext="tokens today"             testId="token-usage" />
              <MetricCard label="Webhook Failure Rate" value={data?.webhookFailureRate   ?? "—"} icon={Webhook}     subtext="last 24 hours"            testId="webhook-failure" />
            </>
          )}
        </div>

        {/* Service Health */}
        <Card className="bg-card border-card-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Cpu className="w-4 h-4 text-destructive" /> Service Health
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-8" />)}
              </div>
            ) : data?.services?.length ? (
              <div className="space-y-2" data-testid="ops-services-list">
                {data.services.map((svc, i) => (
                  <div key={i} className="flex items-center justify-between py-1.5 border-b border-border last:border-0" data-testid={`ops-service-${svc.name}`}>
                    <span className="text-sm font-medium capitalize">{svc.name}</span>
                    <div className="flex items-center gap-3">
                      {svc.latencyMs != null && (
                        <span className="text-xs text-muted-foreground">{svc.latencyMs}ms</span>
                      )}
                      <StatusBadge status={svc.status} />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground" data-testid="ops-no-services-msg">
                No service data available
              </p>
            )}
          </CardContent>
        </Card>

        {/* Additional Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Card className="bg-card border-card-border">
            <CardContent className="pt-5">
              <div className="flex items-center gap-2 mb-2">
                <ShieldAlert className="w-4 h-4 text-secondary" />
                <p className="text-xs text-muted-foreground">Error Rate</p>
              </div>
              {isLoading ? <Skeleton className="h-8 w-20" /> : (
                <p className="text-2xl font-bold" data-testid="ops-error-rate">
                  {data?.errorRate != null ? `${(data.errorRate * 100).toFixed(2)}%` : "—"}
                </p>
              )}
            </CardContent>
          </Card>
          <Card className="bg-card border-card-border">
            <CardContent className="pt-5">
              <div className="flex items-center gap-2 mb-2">
                <Cpu className="w-4 h-4 text-secondary" />
                <p className="text-xs text-muted-foreground">Queue Depth</p>
              </div>
              {isLoading ? <Skeleton className="h-8 w-20" /> : (
                <p className="text-2xl font-bold" data-testid="ops-queue-depth">
                  {data?.queueDepth ?? "—"}
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        <p className="text-xs text-muted-foreground text-right" data-testid="ops-retrieved-at">
          {data?.retrievedAt ? `Last updated: ${new Date(data.retrievedAt).toLocaleTimeString()}` : ""}
        </p>
      </div>
    </div>
  );
}
