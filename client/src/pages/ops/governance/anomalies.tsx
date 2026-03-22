import { useQuery } from "@tanstack/react-query";
import { RefreshCw, Zap } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { QUERY_POLICY } from "@/lib/query-policy";
import { cn } from "@/lib/utils";

interface AnomalyRow {
  id: string;
  organization_id: string;
  anomaly_type: string;
  detected_at: string;
  window_minutes: number;
  baseline_value: string;
  observed_value: string;
  deviation_pct: string;
  severity: "low" | "medium" | "high" | "critical";
  is_confirmed: boolean;
  linked_alert_id: string | null;
}

interface AnomaliesResponse {
  data: AnomalyRow[];
}

function severityBadge(s: string) {
  if (s === "critical") return "text-destructive border-destructive/30 bg-destructive/10";
  if (s === "high")     return "text-orange-500 border-orange-500/30 bg-orange-500/10";
  if (s === "medium")   return "text-yellow-500 border-yellow-500/30 bg-yellow-500/10";
  return "text-muted-foreground border-border";
}

function anomalyTypeLabel(t: string): string {
  return t.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString("da-DK", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function deviationColor(pct: string): string {
  const n = parseFloat(pct);
  if (n >= 200) return "text-destructive";
  if (n >= 100) return "text-orange-500";
  if (n >= 50)  return "text-yellow-500";
  return "text-foreground";
}

export default function GovernanceAnomalies() {
  const { user } = useAuth();
  const isPlatformAdmin = user?.role === "platform_admin";

  const { data, isLoading, error, refetch, isFetching } = useQuery<AnomaliesResponse>({
    queryKey: ["/api/admin/governance/anomalies"],
    ...QUERY_POLICY.staticList,
    enabled: isPlatformAdmin,
    retry: false,
  });

  const rows = data?.data ?? [];
  const criticalCount = rows.filter((r) => r.severity === "critical").length;
  const confirmedCount = rows.filter((r) => r.is_confirmed).length;

  return (
    <div className="p-6 md:p-8 space-y-5 max-w-5xl">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5">
            <div
              className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0"
              style={{ background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.20)" }}
            >
              <Zap className="w-4 h-4 text-secondary" />
            </div>
            <h1 className="text-xl font-bold text-foreground tracking-tight">Anomaly Events</h1>
          </div>
          <p className="text-sm text-muted-foreground ml-10">
            Detected cost, token, and request anomalies — newest first
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 text-xs"
          onClick={() => refetch()}
          disabled={isFetching}
          data-testid="button-refresh-anomalies"
        >
          <RefreshCw className={cn("w-3.5 h-3.5", isFetching && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {!isLoading && rows.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <Card className="bg-card border-card-border">
            <CardContent className="pt-4 pb-4">
              <p className="text-xs text-muted-foreground">Total Anomalies</p>
              <p className="text-2xl font-semibold text-foreground mt-0.5">{rows.length}</p>
            </CardContent>
          </Card>
          <Card className="bg-card border-card-border">
            <CardContent className="pt-4 pb-4">
              <p className="text-xs text-muted-foreground">Critical</p>
              <p className={cn("text-2xl font-semibold mt-0.5", criticalCount > 0 ? "text-destructive" : "text-foreground")}>{criticalCount}</p>
            </CardContent>
          </Card>
          <Card className="bg-card border-card-border">
            <CardContent className="pt-4 pb-4">
              <p className="text-xs text-muted-foreground">Confirmed</p>
              <p className="text-2xl font-semibold text-foreground mt-0.5">{confirmedCount}</p>
            </CardContent>
          </Card>
        </div>
      )}

      <Card className="bg-card border-card-border">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium text-card-foreground">
            <Zap className="w-4 h-4 text-primary" />
            Anomaly Events ({rows.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : error ? (
            <div className="p-8 text-center text-sm text-destructive">
              Failed to load anomalies — {(error as Error).message}
            </div>
          ) : rows.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No anomaly events detected. Run a governance cycle to trigger detection.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border/50 text-muted-foreground">
                    <th className="text-left px-4 py-2.5 font-medium">Organisation</th>
                    <th className="text-left px-4 py-2.5 font-medium">Type</th>
                    <th className="text-right px-4 py-2.5 font-medium">Baseline</th>
                    <th className="text-right px-4 py-2.5 font-medium">Observed</th>
                    <th className="text-right px-4 py-2.5 font-medium">Deviation</th>
                    <th className="text-left px-4 py-2.5 font-medium">Severity</th>
                    <th className="text-left px-4 py-2.5 font-medium">Confirmed</th>
                    <th className="text-left px-4 py-2.5 font-medium">Detected</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}
                        className="border-b border-border/30 hover:bg-muted/30 transition-colors"
                        data-testid={`row-anomaly-${row.id}`}>
                      <td className="px-4 py-3 font-mono text-foreground truncate max-w-[140px]" title={row.organization_id}>
                        {row.organization_id.slice(0, 12)}…
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="outline" className="text-xs">{anomalyTypeLabel(row.anomaly_type)}</Badge>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-muted-foreground">
                        {parseFloat(row.baseline_value).toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-foreground">
                        {parseFloat(row.observed_value).toFixed(2)}
                      </td>
                      <td className={cn("px-4 py-3 text-right font-mono font-semibold", deviationColor(row.deviation_pct))}>
                        +{parseFloat(row.deviation_pct).toFixed(1)}%
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="outline" className={cn("text-xs border capitalize", severityBadge(row.severity))}>
                          {row.severity}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        {row.is_confirmed
                          ? <span className="text-green-400">Yes</span>
                          : <span className="text-muted-foreground/50">No</span>
                        }
                      </td>
                      <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{fmtDate(row.detected_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
