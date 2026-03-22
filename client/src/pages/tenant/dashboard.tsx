import { useQuery } from "@tanstack/react-query";
import {
  LayoutDashboard, PlayCircle, FolderKanban, Plug,
  AlertTriangle, CheckCircle, Activity,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { TenantNav } from "@/components/tenant/TenantNav";

interface TenantDashboard {
  metrics: {
    totalProjects: number;
    activeRuns: number;
    failedRuns: number;
    activeIntegrations: number;
    totalRuns: number;
  };
  recentRuns: { id: string; status: string; projectId: string; createdAt: string }[];
  integrationHealth: { id: string; provider: string; status: string }[];
  retrievedAt: string;
}

function MetricCard({
  label, value, icon: Icon, color, barColor, testId,
}: { label: string; value: number | string; icon: React.ElementType; color: string; barColor?: string; testId: string }) {
  return (
    <Card className="bg-card border-card-border relative overflow-hidden transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/25" data-testid={`metric-card-${testId}`}>
      {barColor && (
        <span className={`absolute left-0 top-0 bottom-0 w-0.5 rounded-r-full ${barColor}`} />
      )}
      <CardContent className="flex items-center gap-4 pt-5 pb-5">
        <div className={`flex items-center justify-center w-10 h-10 rounded-xl ${color} shrink-0`}>
          <Icon className="w-5 h-5" />
        </div>
        <div>
          <p className="text-2xl font-bold text-card-foreground tabular-nums" data-testid={`metric-value-${testId}`}>{value}</p>
          <p className="text-xs text-muted-foreground font-medium mt-0.5">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function runStatusBadge(status: string) {
  const map: Record<string, string> = {
    running:   "bg-primary/15 text-primary border-primary/25",
    completed: "bg-green-500/15 text-green-400 border-green-500/25",
    failed:    "bg-destructive/15 text-destructive border-destructive/25",
    pending:   "bg-secondary/15 text-secondary border-secondary/25",
    cancelled: "bg-muted text-muted-foreground border-border",
  };
  return map[status] ?? map.pending;
}

export default function TenantDashboard() {
  const { data, isLoading } = useQuery<TenantDashboard>({
    queryKey: ["/api/tenant/dashboard"],
  });

  return (
    <div className="flex flex-col h-full">
      <TenantNav />
      <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-6xl">
        <div>
          <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
            <LayoutDashboard className="w-5 h-5 text-primary" />
            Tenant Overview
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Platform activity and health at a glance
          </p>
        </div>

        {/* Metrics */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {isLoading ? (
            Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20" />)
          ) : (
            <>
              <MetricCard label="Projects"     value={data?.metrics.totalProjects ?? 0}     icon={FolderKanban}  color="bg-primary/12 text-primary"      barColor="bg-primary"      testId="projects" />
              <MetricCard label="Active Runs"  value={data?.metrics.activeRuns ?? 0}         icon={PlayCircle}    color="bg-green-500/12 text-green-400"   barColor="bg-green-400"    testId="active-runs" />
              <MetricCard label="Failed Runs"  value={data?.metrics.failedRuns ?? 0}          icon={AlertTriangle} color="bg-destructive/12 text-destructive" barColor="bg-destructive" testId="failed-runs" />
              <MetricCard label="Integrations" value={data?.metrics.activeIntegrations ?? 0} icon={Plug}          color="bg-secondary/12 text-secondary"   barColor="bg-secondary"    testId="integrations" />
            </>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Recent Runs */}
          <Card className="bg-card border-card-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Activity className="w-4 h-4 text-primary" /> Recent AI Runs
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-8" />)}
                </div>
              ) : data?.recentRuns?.length ? (
                <div className="space-y-2" data-testid="recent-runs-list">
                  {data.recentRuns.map((run) => (
                    <div key={run.id} className="flex items-center justify-between py-1.5" data-testid={`run-row-${run.id}`}>
                      <span className="text-xs font-mono text-muted-foreground truncate max-w-[140px]">{run.id.slice(0, 8)}…</span>
                      <Badge variant="outline" className={`text-xs ${runStatusBadge(run.status)}`} data-testid={`run-status-${run.id}`}>
                        {run.status}
                      </Badge>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground" data-testid="no-runs-msg">No runs yet</p>
              )}
            </CardContent>
          </Card>

          {/* Integration Health */}
          <Card className="bg-card border-card-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Plug className="w-4 h-4 text-primary" /> Integration Health
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-8" />)}
                </div>
              ) : data?.integrationHealth?.length ? (
                <div className="space-y-2" data-testid="integration-health-list">
                  {data.integrationHealth.map((int) => (
                    <div key={int.id} className="flex items-center justify-between py-1.5" data-testid={`integration-row-${int.id}`}>
                      <span className="text-xs font-medium capitalize">{int.provider}</span>
                      <div className="flex items-center gap-1.5">
                        {int.status === "active"
                          ? <CheckCircle className="w-3.5 h-3.5 text-green-400" />
                          : <AlertTriangle className="w-3.5 h-3.5 text-secondary" />}
                        <span className="text-xs text-muted-foreground capitalize">{int.status}</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground" data-testid="no-integrations-msg">No integrations configured</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
