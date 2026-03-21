import { useQuery, useMutation } from "@tanstack/react-query";
import { RefreshCw, Bell, CheckCheck, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { QUERY_POLICY } from "@/lib/query-policy";
import { cn } from "@/lib/utils";

interface AlertRow {
  id: string;
  organization_id: string;
  alert_type: string;
  severity: "low" | "medium" | "high" | "critical";
  status: "open" | "acknowledged" | "resolved" | "suppressed";
  title: string;
  message: string;
  threshold_pct: number | null;
  current_usage_usd_cents: number | null;
  budget_usd_cents: number | null;
  created_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
}

interface AlertsResponse {
  data: AlertRow[];
}

function severityBadge(s: string) {
  if (s === "critical") return "text-destructive border-destructive/30 bg-destructive/10";
  if (s === "high")     return "text-orange-500 border-orange-500/30 bg-orange-500/10";
  if (s === "medium")   return "text-yellow-500 border-yellow-500/30 bg-yellow-500/10";
  return "text-muted-foreground border-border";
}

function statusBadge(s: string) {
  if (s === "open")         return "text-destructive border-destructive/30 bg-destructive/10";
  if (s === "acknowledged") return "text-yellow-500 border-yellow-500/30 bg-yellow-500/10";
  if (s === "resolved")     return "text-green-400 border-green-500/30 bg-green-500/10";
  return "text-muted-foreground border-border";
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString("da-DK", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export default function GovernanceAlerts() {
  const { user } = useAuth();
  const { toast } = useToast();
  const isPlatformAdmin = user?.role === "platform_admin";
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [severityFilter, setSeverityFilter] = useState<string>("all");

  const { data, isLoading, error, refetch, isFetching } = useQuery<AlertsResponse>({
    queryKey: ["/api/admin/governance/alerts"],
    ...QUERY_POLICY.staticList,
    enabled: isPlatformAdmin,
    retry: false,
  });

  const acknowledgeMutation = useMutation({
    mutationFn: (alertId: string) => apiRequest("PATCH", `/api/admin/governance/alerts/${alertId}/acknowledge`, {}),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/admin/governance/alerts"] }); toast({ title: "Alert acknowledged" }); },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const resolveMutation = useMutation({
    mutationFn: (alertId: string) => apiRequest("PATCH", `/api/admin/governance/alerts/${alertId}/resolve`, {}),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/admin/governance/alerts"] }); toast({ title: "Alert resolved" }); },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const all = data?.data ?? [];
  const rows = all.filter((r) => {
    if (statusFilter   !== "all" && r.status   !== statusFilter)   return false;
    if (severityFilter !== "all" && r.severity !== severityFilter) return false;
    return true;
  });

  const openCount     = all.filter((r) => r.status === "open").length;
  const criticalCount = all.filter((r) => r.severity === "critical" && r.status === "open").length;

  return (
    <div className="p-6 space-y-5 max-w-5xl">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Governance Alerts</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Budget, anomaly, and runaway alerts across all tenants
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 text-xs"
          onClick={() => refetch()}
          disabled={isFetching}
          data-testid="button-refresh-alerts"
        >
          <RefreshCw className={cn("w-3.5 h-3.5", isFetching && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {!isLoading && all.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <Card className="bg-card border-card-border">
            <CardContent className="pt-4 pb-4">
              <p className="text-xs text-muted-foreground">Open Alerts</p>
              <p className={cn("text-2xl font-semibold mt-0.5", openCount > 0 ? "text-destructive" : "text-foreground")}>{openCount}</p>
            </CardContent>
          </Card>
          <Card className="bg-card border-card-border">
            <CardContent className="pt-4 pb-4">
              <p className="text-xs text-muted-foreground">Critical Open</p>
              <p className={cn("text-2xl font-semibold mt-0.5", criticalCount > 0 ? "text-destructive" : "text-foreground")}>{criticalCount}</p>
            </CardContent>
          </Card>
          <Card className="bg-card border-card-border">
            <CardContent className="pt-4 pb-4">
              <p className="text-xs text-muted-foreground">Total Alerts</p>
              <p className="text-2xl font-semibold text-foreground mt-0.5">{all.length}</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-2">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-36 h-8 text-xs" data-testid="select-alert-status">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="acknowledged">Acknowledged</SelectItem>
            <SelectItem value="resolved">Resolved</SelectItem>
            <SelectItem value="suppressed">Suppressed</SelectItem>
          </SelectContent>
        </Select>
        <Select value={severityFilter} onValueChange={setSeverityFilter}>
          <SelectTrigger className="w-36 h-8 text-xs" data-testid="select-alert-severity">
            <SelectValue placeholder="Severity" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All severities</SelectItem>
            <SelectItem value="critical">Critical</SelectItem>
            <SelectItem value="high">High</SelectItem>
            <SelectItem value="medium">Medium</SelectItem>
            <SelectItem value="low">Low</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card className="bg-card border-card-border">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium text-card-foreground">
            <Bell className="w-4 h-4 text-primary" />
            Alerts ({rows.length}{rows.length !== all.length ? ` of ${all.length}` : ""})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : error ? (
            <div className="p-8 text-center text-sm text-destructive">
              Failed to load alerts — {(error as Error).message}
            </div>
          ) : rows.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No alerts match the current filters.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border/50 text-muted-foreground">
                    <th className="text-left px-4 py-2.5 font-medium">Organisation</th>
                    <th className="text-left px-4 py-2.5 font-medium">Type</th>
                    <th className="text-left px-4 py-2.5 font-medium">Title</th>
                    <th className="text-left px-4 py-2.5 font-medium">Severity</th>
                    <th className="text-left px-4 py-2.5 font-medium">Status</th>
                    <th className="text-left px-4 py-2.5 font-medium">Created</th>
                    <th className="text-left px-4 py-2.5 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}
                        className="border-b border-border/30 hover:bg-muted/30 transition-colors"
                        data-testid={`row-alert-${row.id}`}>
                      <td className="px-4 py-3 font-mono text-foreground truncate max-w-[140px]" title={row.organization_id}>
                        {row.organization_id.slice(0, 12)}…
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="outline" className="text-xs capitalize">{row.alert_type.replace(/_/g, " ")}</Badge>
                      </td>
                      <td className="px-4 py-3 text-foreground max-w-[200px] truncate" title={row.title}>{row.title}</td>
                      <td className="px-4 py-3">
                        <Badge variant="outline" className={cn("text-xs border capitalize", severityBadge(row.severity))}>{row.severity}</Badge>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="outline" className={cn("text-xs border capitalize", statusBadge(row.status))}>{row.status}</Badge>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{fmtDate(row.created_at)}</td>
                      <td className="px-4 py-3">
                        <div className="flex gap-1">
                          {row.status === "open" && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 px-2 text-xs gap-1"
                              onClick={() => acknowledgeMutation.mutate(row.id)}
                              disabled={acknowledgeMutation.isPending}
                              data-testid={`button-ack-${row.id}`}
                            >
                              <CheckCheck className="w-3 h-3" /> Ack
                            </Button>
                          )}
                          {(row.status === "open" || row.status === "acknowledged") && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 px-2 text-xs gap-1 text-green-500 border-green-500/30 hover:bg-green-500/10"
                              onClick={() => resolveMutation.mutate(row.id)}
                              disabled={resolveMutation.isPending}
                              data-testid={`button-resolve-${row.id}`}
                            >
                              <X className="w-3 h-3" /> Resolve
                            </Button>
                          )}
                        </div>
                      </td>
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
