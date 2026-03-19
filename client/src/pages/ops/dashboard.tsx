import { useQuery } from "@tanstack/react-query";
import {
  Activity, AlertTriangle, CheckCircle, Users,
  TrendingUp, DollarSign, RefreshCw, Cpu,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

interface HealthSummary {
  overall?: string;
  checks?: Record<string, { ok: boolean; detail?: string }>;
  timestamp?: string;
}

interface WeeklyDigest {
  period?: string;
  tenantCount?: number;
  totalRequests?: number;
  totalCostUsd?: number;
  topTenants?: { id: string; requests: number; costUsd: number }[];
  highlights?: string[];
}

function StatusDot({ ok }: { ok: boolean }) {
  return <span className={`inline-block w-2 h-2 rounded-full ${ok ? "bg-green-400" : "bg-destructive"}`} />;
}

function SummaryCard({ label, value, icon: Icon, color, testId }: {
  label: string; value: string | number; icon: React.ElementType; color: string; testId: string;
}) {
  return (
    <Card className="bg-card border-card-border" data-testid={`ops-summary-${testId}`}>
      <CardContent className="flex items-center gap-4 pt-5">
        <div className={`flex items-center justify-center w-10 h-10 rounded-lg ${color}`}>
          <Icon className="w-5 h-5" />
        </div>
        <div>
          <p className="text-xl font-bold text-foreground" data-testid={`ops-value-${testId}`}>{value}</p>
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export default function OpsDashboard() {
  const { data: health, isLoading: healthLoading } = useQuery<HealthSummary>({
    queryKey: ["/api/admin/ai-ops/health-summary"],
  });
  const { data: digest, isLoading: digestLoading } = useQuery<WeeklyDigest>({
    queryKey: ["/api/admin/ai-ops/weekly-digest"],
  });

  const checks = Object.entries(health?.checks ?? {});
  const failedChecks = checks.filter(([, v]) => !v.ok);

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-6xl" data-testid="ops-dashboard-page">
      <div>
        <h1 className="text-xl font-semibold text-foreground flex items-center gap-2" data-testid="text-ops-dashboard-title">
          <Activity className="w-5 h-5 text-primary" /> Platform Operations
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">Real-time platform health, AI usage digest, and operational status</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {healthLoading || digestLoading ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20" />)
        ) : (
          <>
            <SummaryCard
              label="Platform Health" icon={failedChecks.length === 0 ? CheckCircle : AlertTriangle} testId="health"
              value={failedChecks.length === 0 ? "Healthy" : `${failedChecks.length} issues`}
              color={failedChecks.length === 0 ? "bg-green-500/15 text-green-400" : "bg-destructive/15 text-destructive"}
            />
            <SummaryCard label="Active Tenants" value={digest?.tenantCount ?? "—"} icon={Users} color="bg-primary/15 text-primary" testId="tenants" />
            <SummaryCard label="Weekly Requests" value={digest?.totalRequests?.toLocaleString() ?? "—"} icon={TrendingUp} color="bg-secondary/15 text-secondary" testId="requests" />
            <SummaryCard
              label="Weekly Cost (USD)" icon={DollarSign} color="bg-green-500/15 text-green-400" testId="cost"
              value={digest?.totalCostUsd != null ? `$${digest.totalCostUsd.toFixed(2)}` : "—"}
            />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="bg-card border-card-border" data-testid="ops-health-checks-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-primary" /> Service Checks
            </CardTitle>
          </CardHeader>
          <CardContent>
            {healthLoading ? (
              <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-7" />)}</div>
            ) : checks.length ? (
              <div className="space-y-2" data-testid="health-checks-list">
                {checks.map(([name, check]) => (
                  <div key={name} className="flex items-center justify-between py-1" data-testid={`health-check-${name}`}>
                    <div className="flex items-center gap-2">
                      <StatusDot ok={check.ok} />
                      <span className="text-xs font-mono text-foreground">{name}</span>
                    </div>
                    <span className="text-xs text-muted-foreground max-w-[180px] truncate text-right">{check.detail ?? (check.ok ? "ok" : "failed")}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground" data-testid="no-health-msg">No health data available</p>
            )}
          </CardContent>
        </Card>

        <Card className="bg-card border-card-border" data-testid="ops-digest-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <RefreshCw className="w-4 h-4 text-primary" /> Weekly Digest
              {digest?.period && <span className="text-xs font-normal text-muted-foreground ml-auto">{digest.period}</span>}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {digestLoading ? (
              <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-7" />)}</div>
            ) : digest?.topTenants?.length ? (
              <div className="space-y-2" data-testid="top-tenants-list">
                <p className="text-xs text-muted-foreground mb-2">Top tenants by volume</p>
                {digest.topTenants.slice(0, 5).map((t, i) => (
                  <div key={t.id} className="flex items-center justify-between py-1" data-testid={`top-tenant-row-${i}`}>
                    <span className="text-xs font-mono text-muted-foreground truncate max-w-[120px]">{t.id.slice(0, 10)}…</span>
                    <div className="flex items-center gap-3">
                      <span className="flex items-center gap-1 text-xs"><Cpu className="w-3 h-3 text-muted-foreground" />{t.requests}</span>
                      <span className="flex items-center gap-1 text-xs"><DollarSign className="w-3 h-3 text-muted-foreground" />${t.costUsd?.toFixed(2)}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-6 text-center" data-testid="no-digest-msg">
                <RefreshCw className="w-7 h-7 text-muted-foreground/40 mx-auto mb-2" />
                <p className="text-xs text-muted-foreground">No digest available yet</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {!healthLoading && failedChecks.length > 0 && (
        <Card className="bg-destructive/10 border-destructive/30" data-testid="ops-failed-checks-alert">
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="w-4 h-4 text-destructive" />
              <p className="text-sm font-medium text-destructive">{failedChecks.length} check(s) failing</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {failedChecks.map(([name, check]) => (
                <Badge key={name} variant="outline" className="text-xs bg-destructive/10 text-destructive border-destructive/30" data-testid={`failed-check-${name}`}>
                  {name}: {check.detail}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
