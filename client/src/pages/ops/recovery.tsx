import { useQuery } from "@tanstack/react-query";
import { DatabaseBackup, CheckCircle, AlertTriangle, Server, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

interface DeployHealth {
  ok?: boolean;
  checks?: Record<string, { ok: boolean; detail?: string }>;
  timestamp?: string;
  environment?: string;
}

function statusColor(ok: boolean) {
  return ok
    ? "bg-green-500/15 text-green-400 border-green-500/25"
    : "bg-destructive/15 text-destructive border-destructive/25";
}

export default function OpsRecovery() {
  const { data, isLoading } = useQuery<DeployHealth>({
    queryKey: ["/api/admin/platform/deploy-health"],
    refetchInterval: 60_000,
  });

  const checks = Object.entries(data?.checks ?? {});
  const passing = checks.filter(([, v]) => v.ok);
  const failing = checks.filter(([, v]) => !v.ok);

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-6xl" data-testid="ops-recovery-page">
      <div className="space-y-1">
        <div className="flex items-center gap-2.5">
          <div
            className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0"
            style={{ background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.20)" }}
          >
            <DatabaseBackup className="w-4 h-4 text-destructive" />
          </div>
          <h1 className="text-xl font-bold text-foreground tracking-tight" data-testid="text-ops-recovery-title">Disaster Recovery</h1>
        </div>
        <p className="text-sm text-muted-foreground ml-10">Platform environment checks, service connectivity, and deployment health</p>
      </div>

      {/* Overall status */}
      <div className="flex items-center gap-3" data-testid="recovery-overall-status">
        {isLoading ? <Skeleton className="h-8 w-40" /> : (
          <>
            <Badge variant="outline" className={`text-sm px-3 py-1 gap-1.5 ${statusColor(failing.length === 0)}`} data-testid="recovery-status-badge">
              {failing.length === 0
                ? <><CheckCircle className="w-4 h-4" /> All systems operational</>
                : <><AlertTriangle className="w-4 h-4" /> {failing.length} issue(s) detected</>}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {passing.length}/{checks.length} checks passing
            </span>
          </>
        )}
      </div>

      {/* Checks Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4" data-testid="recovery-checks-grid">
        {isLoading ? (
          Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-20" />)
        ) : checks.length ? (
          checks.map(([name, check]) => (
            <Card key={name} className={`border ${check.ok ? "bg-card border-card-border" : "bg-destructive/5 border-destructive/30"}`} data-testid={`recovery-check-${name}`}>
              <CardContent className="pt-4 pb-3">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <span className={`inline-block w-2 h-2 rounded-full ${check.ok ? "bg-green-400" : "bg-destructive"}`} />
                    <span className="text-xs font-mono font-medium text-foreground">{name}</span>
                  </div>
                  <Badge variant="outline" className={`text-xs ${statusColor(check.ok)}`}>
                    {check.ok ? "ok" : "fail"}
                  </Badge>
                </div>
                {check.detail && (
                  <p className="text-xs text-muted-foreground pl-4 truncate" data-testid={`recovery-detail-${name}`}>
                    {check.detail}
                  </p>
                )}
              </CardContent>
            </Card>
          ))
        ) : (
          <div className="col-span-2 py-8 text-center" data-testid="no-recovery-checks-msg">
            <Server className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-xs text-muted-foreground">No environment checks available</p>
          </div>
        )}
      </div>

      {data?.timestamp && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="recovery-timestamp">
          <RefreshCw className="w-3 h-3" />
          Last checked: {new Date(data.timestamp).toLocaleString()}
        </div>
      )}
    </div>
  );
}
