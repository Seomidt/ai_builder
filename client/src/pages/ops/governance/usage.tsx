import { useQuery } from "@tanstack/react-query";
import { RefreshCw, Database } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { QUERY_POLICY } from "@/lib/query-policy";
import { cn } from "@/lib/utils";

interface SnapshotRow {
  id: string;
  organization_id: string;
  period_start: string;
  period_end: string;
  period_type: string;
  total_tokens: string | number;
  prompt_tokens: string | number;
  completion_tokens: string | number;
  total_cost_usd_cents: string | number;
  request_count: number;
  failed_request_count: number;
  model_breakdown: Record<string, unknown>;
  snapshot_at: string;
}

interface SnapshotsResponse {
  data: SnapshotRow[];
}

function centsToUsd(cents: string | number): string {
  return "$" + (Number(cents) / 100).toFixed(4);
}

function fmtTokens(n: string | number): string {
  const v = Number(n);
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + "M";
  if (v >= 1_000)     return (v / 1_000).toFixed(1) + "k";
  return String(v);
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("da-DK", { day: "2-digit", month: "short", year: "2-digit" });
}

export default function GovernanceUsage() {
  const { user } = useAuth();
  const isPlatformAdmin = user?.role === "platform_admin";

  const { data, isLoading, error, refetch, isFetching } = useQuery<SnapshotsResponse>({
    queryKey: ["/api/admin/governance/snapshots-list"],
    ...QUERY_POLICY.staticList,
    enabled: isPlatformAdmin,
    retry: false,
  });

  const rows = data?.data ?? [];
  const totalCost = rows.reduce((sum, r) => sum + Number(r.total_cost_usd_cents), 0);
  const totalTokens = rows.reduce((sum, r) => sum + Number(r.total_tokens), 0);
  const totalRequests = rows.reduce((sum, r) => sum + Number(r.request_count), 0);

  return (
    <div className="p-6 space-y-5 max-w-5xl">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Usage Snapshots</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Tenant AI usage snapshots — newest first
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 text-xs"
          onClick={() => refetch()}
          disabled={isFetching}
          data-testid="button-refresh-usage"
        >
          <RefreshCw className={cn("w-3.5 h-3.5", isFetching && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {/* Summary */}
      {!isLoading && rows.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: "Total Cost",     value: centsToUsd(totalCost) },
            { label: "Total Tokens",   value: fmtTokens(totalTokens) },
            { label: "Total Requests", value: totalRequests.toLocaleString() },
          ].map(({ label, value }) => (
            <Card key={label} className="bg-card border-card-border">
              <CardContent className="pt-4 pb-4">
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="text-2xl font-semibold text-foreground mt-0.5 font-mono">{value}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Card className="bg-card border-card-border">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium text-card-foreground">
            <Database className="w-4 h-4 text-primary" />
            Snapshot Records ({rows.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : error ? (
            <div className="p-8 text-center text-sm text-destructive">
              Failed to load snapshots — {(error as Error).message}
            </div>
          ) : rows.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No snapshots yet. Run a governance cycle or trigger a snapshot via the API to generate data.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border/50 text-muted-foreground">
                    <th className="text-left px-4 py-2.5 font-medium">Organisation</th>
                    <th className="text-left px-4 py-2.5 font-medium">Period</th>
                    <th className="text-left px-4 py-2.5 font-medium">Date</th>
                    <th className="text-right px-4 py-2.5 font-medium">Requests</th>
                    <th className="text-right px-4 py-2.5 font-medium">Tokens</th>
                    <th className="text-right px-4 py-2.5 font-medium">Cost</th>
                    <th className="text-right px-4 py-2.5 font-medium">Failed</th>
                    <th className="text-left px-4 py-2.5 font-medium">Snapshot</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}
                        className="border-b border-border/30 hover:bg-muted/30 transition-colors"
                        data-testid={`row-snapshot-${row.id}`}>
                      <td className="px-4 py-3 font-mono text-foreground truncate max-w-[160px]" title={row.organization_id}>
                        {row.organization_id.slice(0, 12)}…
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="outline" className="text-xs capitalize">{row.period_type}</Badge>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{fmtDate(row.period_start)}</td>
                      <td className="px-4 py-3 text-right font-mono text-foreground">{Number(row.request_count).toLocaleString()}</td>
                      <td className="px-4 py-3 text-right font-mono text-foreground">{fmtTokens(row.total_tokens)}</td>
                      <td className="px-4 py-3 text-right font-mono text-foreground">{centsToUsd(row.total_cost_usd_cents)}</td>
                      <td className="px-4 py-3 text-right font-mono text-muted-foreground">
                        {row.failed_request_count > 0
                          ? <span className="text-destructive">{row.failed_request_count}</span>
                          : "—"
                        }
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{fmtDate(row.snapshot_at)}</td>
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
