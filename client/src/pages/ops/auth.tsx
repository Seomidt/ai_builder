import { useQuery } from "@tanstack/react-query";
import { QUERY_POLICY } from "@/lib/query-policy";
import { Lock, CheckCircle, AlertTriangle, Eye, Shield, UserCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

interface SecurityHealth {
  overall?: string;
  checks?: Record<string, { ok: boolean; detail?: string }>;
  rateLimit?: { enabled: boolean };
  lockdown?: { enabled: boolean; allowlist?: string[] };
  mfa?: { required: boolean };
}

interface SecurityEvent {
  id?: string;
  type?: string;
  severity?: string;
  ip?: string;
  userId?: string;
  createdAt?: string;
}

function isAuthEvent(e: SecurityEvent) {
  const t = (e.type ?? "").toLowerCase();
  return t.includes("login") || t.includes("auth") || t.includes("session") || t.includes("password") || t.includes("mfa");
}

export default function OpsAuthSecurity() {
  const { data: health, isLoading: healthLoading } = useQuery<SecurityHealth>({
    queryKey: ["/api/admin/security/health"],
    ...QUERY_POLICY.opsSnapshot,
  });
  const { data: eventsRaw, isLoading: eventsLoading } = useQuery<{ events?: SecurityEvent[] } | SecurityEvent[]>({
    queryKey: ["/api/admin/security/events/recent"],
    ...QUERY_POLICY.opsSnapshot,
  });

  const allEvents: SecurityEvent[] = Array.isArray(eventsRaw) ? eventsRaw : (eventsRaw?.events ?? []);
  const authEvents = allEvents.filter(isAuthEvent);
  const checks = Object.entries(health?.checks ?? {});
  const authChecks = checks.filter(([name]) => ["LOCKDOWN_ENABLED", "LOCKDOWN_ALLOWLIST", "SESSION_SECRET", "SUPABASE_URL", "SUPABASE_ANON_KEY"].includes(name));

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-6xl" data-testid="ops-auth-page">
      <div>
        <h1 className="text-xl font-semibold text-foreground flex items-center gap-2" data-testid="text-ops-auth-title">
          <Lock className="w-5 h-5 text-primary" /> Auth &amp; Identity Security
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">Authentication posture, lockdown status, and auth events</p>
      </div>

      {/* Auth feature chips */}
      <div className="flex flex-wrap gap-2" data-testid="auth-feature-chips">
        {healthLoading ? (
          Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-7 w-28" />)
        ) : (
          <>
            <Badge variant="outline" className={`text-xs gap-1 ${health?.lockdown?.enabled ? "bg-green-500/15 text-green-400 border-green-500/25" : "bg-muted text-muted-foreground border-border"}`} data-testid="chip-lockdown">
              {health?.lockdown?.enabled ? <CheckCircle className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
              Lockdown {health?.lockdown?.enabled ? "enabled" : "off"}
            </Badge>
            <Badge variant="outline" className={`text-xs gap-1 ${health?.rateLimit?.enabled ? "bg-green-500/15 text-green-400 border-green-500/25" : "bg-muted text-muted-foreground border-border"}`} data-testid="chip-rate-limit">
              {health?.rateLimit?.enabled ? <Shield className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
              Rate Limit
            </Badge>
            <Badge variant="outline" className={`text-xs gap-1 ${health?.mfa?.required ? "bg-green-500/15 text-green-400 border-green-500/25" : "bg-muted text-muted-foreground border-border"}`} data-testid="chip-mfa">
              <UserCheck className="w-3 h-3" />
              MFA {health?.mfa?.required ? "required" : "optional"}
            </Badge>
          </>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Auth Env Checks */}
        <Card className="bg-card border-card-border" data-testid="auth-env-checks-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Shield className="w-4 h-4 text-primary" /> Auth Configuration
            </CardTitle>
          </CardHeader>
          <CardContent>
            {healthLoading ? (
              <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-7" />)}</div>
            ) : authChecks.length ? (
              <div className="space-y-2" data-testid="auth-checks-list">
                {authChecks.map(([name, check]) => (
                  <div key={name} className="flex items-center justify-between py-1" data-testid={`auth-check-${name}`}>
                    <div className="flex items-center gap-2">
                      <span className={`inline-block w-2 h-2 rounded-full ${check.ok ? "bg-green-400" : "bg-destructive"}`} />
                      <span className="text-xs font-mono text-foreground">{name}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">{check.detail ?? (check.ok ? "ok" : "missing")}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground" data-testid="no-auth-checks-msg">No auth checks available</p>
            )}
          </CardContent>
        </Card>

        {/* Auth Events */}
        <Card className="bg-card border-card-border" data-testid="auth-events-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Eye className="w-4 h-4 text-primary" /> Auth Events
              {!eventsLoading && <Badge variant="outline" className="ml-auto text-xs">{authEvents.length}</Badge>}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {eventsLoading ? (
              <div className="p-4 space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-9" />)}</div>
            ) : authEvents.length ? (
              <div data-testid="auth-events-list">
                {authEvents.slice(0, 8).map((e, i) => (
                  <div key={e.id ?? i} className="flex items-center justify-between px-4 py-2.5 border-b border-border last:border-0" data-testid={`auth-event-${i}`}>
                    <div className="flex-1 min-w-0 pr-2">
                      <p className="text-xs font-medium text-foreground">{e.type ?? "auth_event"}</p>
                      <p className="text-xs text-muted-foreground">{e.ip ?? "—"}</p>
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {e.createdAt ? new Date(e.createdAt).toLocaleTimeString() : "—"}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-6 text-center" data-testid="no-auth-events-msg">
                <Lock className="w-7 h-7 text-muted-foreground/40 mx-auto mb-2" />
                <p className="text-xs text-muted-foreground">No recent auth events</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
