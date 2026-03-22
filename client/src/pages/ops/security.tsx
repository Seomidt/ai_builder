import { useQuery } from "@tanstack/react-query";
import { QUERY_POLICY } from "@/lib/query-policy";
import { Shield, AlertTriangle, CheckCircle, Eye, Lock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

interface SecurityHealth {
  overall?: string;
  checks?: Record<string, { ok: boolean; detail?: string }>;
  rateLimit?: { enabled: boolean };
  csp?: { enabled: boolean };
  hsts?: { enabled: boolean };
}

interface SecurityEvent {
  id?: string;
  type?: string;
  severity?: string;
  ip?: string;
  path?: string;
  tenantId?: string;
  createdAt?: string;
  detail?: string;
}

interface SecurityEventsResponse {
  events?: SecurityEvent[];
  total?: number;
}

function severityColor(s?: string) {
  if (s === "critical" || s === "high") return "bg-destructive/15 text-destructive border-destructive/25";
  if (s === "medium") return "bg-secondary/15 text-secondary border-secondary/25";
  return "bg-muted text-muted-foreground border-border";
}

export default function OpsSecurity() {
  const { data: health, isLoading: healthLoading } = useQuery<SecurityHealth>({
    queryKey: ["/api/admin/security/health"],
    ...QUERY_POLICY.opsSnapshot,
  });
  const { data: eventsData, isLoading: eventsLoading } = useQuery<SecurityEventsResponse>({
    queryKey: ["/api/admin/security/events/recent"],
    ...QUERY_POLICY.opsSnapshot,
  });

  const events: SecurityEvent[] = Array.isArray(eventsData)
    ? eventsData
    : (eventsData?.events ?? []);
  const checks = Object.entries(health?.checks ?? {});
  const failedChecks = checks.filter(([, v]) => !v.ok);

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-6xl" data-testid="ops-security-page">
      <div className="space-y-1">
        <div className="flex items-center gap-2.5">
          <div
            className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0"
            style={{ background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.20)" }}
          >
            <Shield className="w-4 h-4 text-destructive" />
          </div>
          <h1 className="text-xl font-bold text-foreground tracking-tight" data-testid="text-ops-security-title">Security Monitoring</h1>
        </div>
        <p className="text-sm text-muted-foreground ml-10">Security posture, WAF events, and threat signals</p>
      </div>

      {/* Security Health Chips */}
      <div className="flex flex-wrap gap-2" data-testid="security-health-chips">
        {healthLoading ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-7 w-28" />)
        ) : (
          <>
            <Badge variant="outline" className={`text-xs gap-1 ${health?.rateLimit?.enabled ? "bg-green-500/15 text-green-400 border-green-500/25" : "bg-muted text-muted-foreground"}`} data-testid="chip-rate-limit">
              {health?.rateLimit?.enabled ? <CheckCircle className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
              Rate Limiting
            </Badge>
            <Badge variant="outline" className={`text-xs gap-1 ${health?.csp?.enabled ? "bg-green-500/15 text-green-400 border-green-500/25" : "bg-muted text-muted-foreground"}`} data-testid="chip-csp">
              {health?.csp?.enabled ? <CheckCircle className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
              CSP
            </Badge>
            <Badge variant="outline" className={`text-xs gap-1 ${health?.hsts?.enabled ? "bg-green-500/15 text-green-400 border-green-500/25" : "bg-muted text-muted-foreground"}`} data-testid="chip-hsts">
              {health?.hsts?.enabled ? <CheckCircle className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
              HSTS
            </Badge>
            <Badge variant="outline" className={`text-xs gap-1 ${failedChecks.length === 0 ? "bg-green-500/15 text-green-400 border-green-500/25" : "bg-destructive/15 text-destructive border-destructive/25"}`} data-testid="chip-overall">
              {failedChecks.length === 0 ? <Lock className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
              {failedChecks.length === 0 ? "All checks pass" : `${failedChecks.length} issues`}
            </Badge>
          </>
        )}
      </div>

      {/* Recent Events */}
      <Card className="bg-card border-card-border" data-testid="ops-security-events-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Eye className="w-4 h-4 text-primary" /> Recent Security Events
            {!eventsLoading && <Badge variant="outline" className="ml-auto text-xs">{events.length}</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {eventsLoading ? (
            <div className="p-4 space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
          ) : events.length ? (
            <div data-testid="security-events-list">
              {events.map((e, i) => (
                <div key={e.id ?? i} className="flex items-start justify-between px-4 py-3 border-b border-border last:border-0" data-testid={`security-event-${i}`}>
                  <div className="flex-1 min-w-0 pr-3">
                    <p className="text-xs font-medium text-foreground">{e.type ?? "security_event"}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {e.ip ?? "—"} → {e.path ?? "—"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant="outline" className={`text-xs ${severityColor(e.severity)}`} data-testid={`security-severity-${i}`}>
                      {e.severity ?? "info"}
                    </Badge>
                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                      {e.createdAt ? new Date(e.createdAt).toLocaleTimeString() : "—"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-8 text-center" data-testid="no-security-events-msg">
              <Shield className="w-8 h-8 text-green-400/60 mx-auto mb-2" />
              <p className="text-xs text-muted-foreground">No recent security events — platform looks clean</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Service Checks */}
      {checks.length > 0 && (
        <Card className="bg-card border-card-border" data-testid="ops-security-checks-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Shield className="w-4 h-4 text-primary" /> Security Service Checks
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2" data-testid="security-checks-list">
              {checks.map(([name, check]) => (
                <div key={name} className="flex items-center justify-between py-1" data-testid={`sec-check-${name}`}>
                  <div className="flex items-center gap-2">
                    <span className={`inline-block w-2 h-2 rounded-full ${check.ok ? "bg-green-400" : "bg-destructive"}`} />
                    <span className="text-xs font-mono">{name}</span>
                  </div>
                  <span className="text-xs text-muted-foreground">{check.detail ?? (check.ok ? "ok" : "failed")}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
