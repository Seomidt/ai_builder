import { useQuery } from "@tanstack/react-query";
import { ShieldAlert, Shield, AlertTriangle, Activity, Lock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { OpsNav } from "@/components/ops/OpsNav";

interface SecurityResponse {
  snapshot: {
    healthy?: boolean;
    rateLimitViolations?: number;
    authFailures?: number;
    activeThreats?: number;
    checkedAt?: string;
  };
  summary: {
    totalEvents?: number;
    byType?: Record<string, number>;
    criticalCount?: number;
  };
  abuse: {
    events?: { id: string; type?: string; tenantId?: string; ipAddress?: string; createdAt?: string }[];
    count?: number;
  };
  retrievedAt: string;
}

function securityColor(healthy: boolean | undefined) {
  if (healthy === true)  return "bg-green-500/5 border-green-500/25";
  if (healthy === false) return "bg-destructive/5 border-destructive/25";
  return "bg-card border-card-border";
}

export default function OpsSecurity() {
  const { data, isLoading } = useQuery<SecurityResponse>({
    queryKey: ["/api/admin/platform/security"],
  });

  const snapshot  = data?.snapshot;
  const summary   = data?.summary;
  const abuseList = data?.abuse?.events ?? [];

  return (
    <div className="flex flex-col h-full">
      <OpsNav />
      <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-6xl">
        <div>
          <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-destructive" /> Security Monitor
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Rate limit violations, authentication anomalies, and abuse events
          </p>
        </div>

        {/* Health Banner */}
        {!isLoading && (
          <Card className={`border ${securityColor(snapshot?.healthy)}`}>
            <CardContent className="py-3 flex items-center gap-2">
              {snapshot?.healthy
                ? <Shield className="w-4 h-4 text-green-400 shrink-0" />
                : <AlertTriangle className="w-4 h-4 text-destructive shrink-0" />}
              <p className="text-sm" data-testid="ops-security-health-msg">
                Security subsystem is <strong>{snapshot?.healthy ? "healthy" : "degraded"}</strong>
              </p>
              {snapshot?.checkedAt && (
                <span className="text-xs text-muted-foreground ml-auto">
                  {new Date(snapshot.checkedAt).toLocaleTimeString()}
                </span>
              )}
            </CardContent>
          </Card>
        )}

        {/* Key Metrics */}
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          {isLoading ? (
            Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-20" />)
          ) : (
            <>
              {[
                { label: "Rate Limit Violations", value: snapshot?.rateLimitViolations ?? "—", icon: Activity,     testId: "rate-limit" },
                { label: "Auth Failures",         value: snapshot?.authFailures        ?? "—", icon: Lock,         testId: "auth-fail" },
                { label: "Active Threats",        value: snapshot?.activeThreats       ?? "—", icon: ShieldAlert,  testId: "threats" },
              ].map(({ label, value, icon: Icon, testId }) => (
                <Card key={testId} className="bg-card border-card-border" data-testid={`ops-security-metric-${testId}`}>
                  <CardContent className="pt-5">
                    <div className="flex items-center gap-2 mb-1">
                      <Icon className="w-4 h-4 text-destructive" />
                      <p className="text-xs text-muted-foreground">{label}</p>
                    </div>
                    <p className="text-2xl font-bold" data-testid={`ops-security-value-${testId}`}>{value}</p>
                  </CardContent>
                </Card>
              ))}
            </>
          )}
        </div>

        {/* Event Summary */}
        {!isLoading && summary?.byType && Object.keys(summary.byType).length > 0 && (
          <Card className="bg-card border-card-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Activity className="w-4 h-4 text-destructive" /> Event Distribution (24h)
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2" data-testid="ops-security-event-distribution">
              {Object.entries(summary.byType).map(([type, count]) => (
                <div key={type} className="flex items-center justify-between py-1.5 border-b border-border last:border-0"
                  data-testid={`ops-security-event-type-${type}`}>
                  <span className="text-xs font-mono text-muted-foreground capitalize">{type}</span>
                  <Badge variant="outline" className="text-xs">{count}</Badge>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Abuse Events */}
        <Card className="bg-card border-card-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-destructive" /> Recent Abuse Events
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10" />)}
              </div>
            ) : abuseList.length > 0 ? (
              <div data-testid="ops-security-abuse-list">
                {abuseList.slice(0, 20).map((e) => (
                  <div key={e.id} className="flex items-center justify-between px-4 py-3 border-b border-border last:border-0"
                    data-testid={`ops-security-abuse-${e.id}`}>
                    <div>
                      <div className="flex items-center gap-2">
                        {e.type && (
                          <Badge variant="outline" className="text-xs bg-destructive/10 text-destructive border-destructive/25">
                            {e.type}
                          </Badge>
                        )}
                        {e.tenantId && <span className="text-xs font-mono text-muted-foreground">{e.tenantId}</span>}
                      </div>
                      {e.ipAddress && <p className="text-xs text-muted-foreground mt-0.5">{e.ipAddress}</p>}
                    </div>
                    {e.createdAt && (
                      <span className="text-xs text-muted-foreground">
                        {new Date(e.createdAt).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-6 text-center">
                <Shield className="w-7 h-7 text-green-400/60 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground" data-testid="ops-no-abuse-events-msg">No abuse events detected</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
