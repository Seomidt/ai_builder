import { useQuery } from "@tanstack/react-query";
import { RefreshCw, ShieldOff, Shield } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { QUERY_POLICY } from "@/lib/query-policy";
import { cn } from "@/lib/utils";

interface RunawayEvent {
  organizationId: string;
  trigger: string;
  observedValue: number;
  thresholdValue: number;
  windowMinutes: number;
  severity: "high" | "critical";
  metadata: Record<string, unknown>;
}

interface RunawayResult {
  organizationId: string;
  triggered: boolean;
  events: RunawayEvent[];
  alertIds: string[];
  errors: string[];
}

interface RunawayResponse {
  data: RunawayResult[];
}

function fmtTrigger(t: string): string {
  return t.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function GovernanceRunaway() {
  const { user } = useAuth();
  const isPlatformAdmin = user?.role === "platform_admin";

  const { data, isLoading, error, refetch, isFetching } = useQuery<RunawayResponse>({
    queryKey: ["/api/admin/governance/runaway-status"],
    ...QUERY_POLICY.opsSnapshot,
    enabled: isPlatformAdmin,
    retry: false,
  });

  const rows = data?.data ?? [];
  const triggered = rows.filter((r) => r.triggered);
  const safe      = rows.filter((r) => !r.triggered);

  return (
    <div className="p-6 md:p-8 space-y-5 max-w-4xl">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5">
            <div
              className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0"
              style={{ background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.20)" }}
            >
              <ShieldOff className="w-4 h-4 text-destructive" />
            </div>
            <h1 className="text-xl font-bold text-foreground tracking-tight">Runaway Protection</h1>
          </div>
          <p className="text-sm text-muted-foreground ml-10">
            Per-tenant runaway detection across all active organizations
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 text-xs"
          onClick={() => refetch()}
          disabled={isFetching}
          data-testid="button-refresh-runaway"
        >
          <RefreshCw className={cn("w-3.5 h-3.5", isFetching && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {!isLoading && rows.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <Card className="bg-card border-card-border">
            <CardContent className="pt-4 pb-4">
              <p className="text-xs text-muted-foreground">Organisations Checked</p>
              <p className="text-2xl font-semibold text-foreground mt-0.5">{rows.length}</p>
            </CardContent>
          </Card>
          <Card className="bg-card border-card-border">
            <CardContent className="pt-4 pb-4">
              <p className="text-xs text-muted-foreground">Triggered</p>
              <p className={cn("text-2xl font-semibold mt-0.5", triggered.length > 0 ? "text-destructive" : "text-foreground")}>{triggered.length}</p>
            </CardContent>
          </Card>
          <Card className="bg-card border-card-border">
            <CardContent className="pt-4 pb-4">
              <p className="text-xs text-muted-foreground">Safe</p>
              <p className="text-2xl font-semibold text-green-400 mt-0.5">{safe.length}</p>
            </CardContent>
          </Card>
        </div>
      )}

      <Card className="bg-card border-card-border">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium text-card-foreground">
            <Shield className="w-4 h-4 text-primary" />
            Runaway Status ({rows.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : error ? (
            <div className="p-8 text-center text-sm text-destructive">
              Failed to load runaway status — {(error as Error).message}
            </div>
          ) : rows.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No organizations found. Ensure budgets and usage data exist before running the check.
            </div>
          ) : (
            <div className="divide-y divide-border/30">
              {rows.map((row) => (
                <div
                  key={row.organizationId}
                  className="px-4 py-3 hover:bg-muted/30 transition-colors"
                  data-testid={`row-runaway-${row.organizationId}`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      {row.triggered
                        ? <ShieldOff className="w-4 h-4 text-destructive shrink-0" />
                        : <Shield className="w-4 h-4 text-green-400 shrink-0" />
                      }
                      <span className="text-xs font-mono text-foreground" title={row.organizationId}>
                        {row.organizationId.slice(0, 20)}…
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {row.alertIds.length > 0 && (
                        <Badge variant="outline" className="text-xs text-muted-foreground border-border">
                          {row.alertIds.length} alert{row.alertIds.length !== 1 ? "s" : ""}
                        </Badge>
                      )}
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-xs border",
                          row.triggered
                            ? "text-destructive border-destructive/30 bg-destructive/10"
                            : "text-green-400 border-green-500/30 bg-green-500/10",
                        )}
                      >
                        {row.triggered ? "Triggered" : "Safe"}
                      </Badge>
                    </div>
                  </div>

                  {/* Triggered events */}
                  {row.events.length > 0 && (
                    <div className="mt-2 ml-7 space-y-1">
                      {row.events.map((ev, i) => (
                        <div key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Badge variant="outline" className={cn("text-xs border capitalize shrink-0",
                            ev.severity === "critical"
                              ? "text-destructive border-destructive/30 bg-destructive/10"
                              : "text-orange-500 border-orange-500/30 bg-orange-500/10"
                          )}>
                            {ev.severity}
                          </Badge>
                          <span>{fmtTrigger(ev.trigger)}</span>
                          <span className="text-muted-foreground/50">
                            observed={ev.observedValue.toFixed(2)} threshold={ev.thresholdValue.toFixed(2)} window={ev.windowMinutes}m
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Errors */}
                  {row.errors.length > 0 && (
                    <div className="mt-1 ml-7 space-y-0.5">
                      {row.errors.map((e, i) => (
                        <p key={i} className="text-xs text-destructive">{e}</p>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
