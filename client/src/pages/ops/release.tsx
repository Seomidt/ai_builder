import { useQuery } from "@tanstack/react-query";
import { Rocket, CheckCircle, AlertTriangle, RefreshCw, Globe } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

interface DeployHealth {
  checks?: Record<string, { ok: boolean; detail?: string }>;
  timestamp?: string;
}

export default function OpsRelease() {
  const { data, isLoading, refetch, isFetching } = useQuery<DeployHealth>({
    queryKey: ["/api/admin/platform/deploy-health"],
    refetchInterval: 120_000,
  });

  const checks = Object.entries(data?.checks ?? {});
  const failing = checks.filter(([, v]) => !v.ok);
  const passing = checks.filter(([, v]) => v.ok);
  const allOk   = failing.length === 0 && checks.length > 0;

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-6xl" data-testid="ops-release-page">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground flex items-center gap-2" data-testid="text-ops-release-title">
            <Rocket className="w-5 h-5 text-primary" /> Release &amp; Deployment
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">Live environment status and deployment verification</p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          data-testid="button-refresh-deploy-health"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {/* Overall banner */}
      <Card className={`border ${allOk ? "bg-green-500/5 border-green-500/25" : failing.length > 0 ? "bg-destructive/5 border-destructive/25" : "bg-card border-card-border"}`} data-testid="release-status-banner">
        <CardContent className="py-4 flex items-center gap-3">
          {isLoading ? <Skeleton className="h-6 w-48" /> : (
            <>
              {allOk
                ? <CheckCircle className="w-5 h-5 text-green-400" />
                : <AlertTriangle className="w-5 h-5 text-destructive" />}
              <div>
                <p className="text-sm font-medium text-foreground" data-testid="release-status-text">
                  {allOk ? "Production is healthy" : `${failing.length} environment issue(s) detected`}
                </p>
                <p className="text-xs text-muted-foreground">{passing.length}/{checks.length} checks passing</p>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Env Checks */}
      <Card className="bg-card border-card-border" data-testid="release-checks-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Globe className="w-4 h-4 text-primary" /> Environment Checks
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-8" />)}</div>
          ) : checks.length ? (
            <div data-testid="release-checks-list">
              {checks.map(([name, check]) => (
                <div key={name} className="flex items-center justify-between px-4 py-2.5 border-b border-border last:border-0" data-testid={`release-check-${name}`}>
                  <div className="flex items-center gap-2">
                    <span className={`inline-block w-2 h-2 rounded-full ${check.ok ? "bg-green-400" : "bg-destructive"}`} />
                    <span className="text-xs font-mono text-foreground">{name}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground max-w-[200px] truncate text-right">{check.detail}</span>
                    <Badge variant="outline" className={`text-xs ${check.ok ? "bg-green-500/15 text-green-400 border-green-500/25" : "bg-destructive/15 text-destructive border-destructive/25"}`}>
                      {check.ok ? "ok" : "fail"}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-6 text-center" data-testid="no-release-checks-msg">
              <Rocket className="w-7 h-7 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-xs text-muted-foreground">No deployment checks available</p>
            </div>
          )}
        </CardContent>
      </Card>

      {data?.timestamp && (
        <p className="text-xs text-muted-foreground flex items-center gap-1.5" data-testid="release-last-checked">
          <RefreshCw className="w-3 h-3" />
          Last checked: {new Date(data.timestamp).toLocaleString()}
        </p>
      )}
    </div>
  );
}
