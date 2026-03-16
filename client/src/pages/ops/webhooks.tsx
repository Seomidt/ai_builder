import { useQuery, useMutation } from "@tanstack/react-query";
import { Webhook, AlertTriangle, RefreshCcw, CheckCircle, Activity } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { OpsNav } from "@/components/ops/OpsNav";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface WebhooksResponse {
  health: {
    totalEndpoints?: number;
    healthyEndpoints?: number;
    failingEndpoints?: number;
    successRate?: number;
    avgLatencyMs?: number;
  };
  failures: {
    id: string;
    endpoint?: string;
    statusCode?: number;
    error?: string;
    attempts?: number;
    lastAttemptAt?: string;
  }[];
  retrievedAt: string;
}

export default function OpsWebhooks() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<WebhooksResponse>({
    queryKey: ["/api/admin/platform/webhooks"],
  });

  const replayWebhook = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/admin/ops/webhooks/${id}/replay`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/platform/webhooks"] });
      toast({ title: "Replay queued", description: "Webhook delivery will be retried" });
    },
    onError: (err: Error) => toast({ title: "Replay failed", description: err.message, variant: "destructive" }),
  });

  const successRate = data?.health?.successRate;
  const rateColor = successRate == null ? ""
    : successRate >= 0.99 ? "text-green-400"
    : successRate >= 0.95 ? "text-secondary"
    : "text-destructive";

  return (
    <div className="flex flex-col h-full">
      <OpsNav />
      <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-6xl">
        <div>
          <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
            <Webhook className="w-5 h-5 text-destructive" /> Webhook Monitoring
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">Delivery logs, failure detection, and replay tools</p>
        </div>

        {/* Health Summary */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {isLoading ? (
            Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20" />)
          ) : (
            <>
              {[
                { label: "Total Endpoints",   value: data?.health?.totalEndpoints   ?? "—", testId: "total" },
                { label: "Healthy",           value: data?.health?.healthyEndpoints ?? "—", testId: "healthy" },
                { label: "Failing",           value: data?.health?.failingEndpoints ?? "—", testId: "failing" },
                { label: "Avg Latency",       value: data?.health?.avgLatencyMs != null ? `${data.health.avgLatencyMs}ms` : "—", testId: "latency" },
              ].map(({ label, value, testId }) => (
                <Card key={testId} className="bg-card border-card-border" data-testid={`ops-webhook-metric-${testId}`}>
                  <CardContent className="pt-5">
                    <p className="text-xs text-muted-foreground mb-1">{label}</p>
                    <p className="text-2xl font-bold" data-testid={`ops-webhook-value-${testId}`}>{value}</p>
                  </CardContent>
                </Card>
              ))}
            </>
          )}
        </div>

        {/* Success Rate Bar */}
        {!isLoading && successRate != null && (
          <Card className="bg-card border-card-border">
            <CardContent className="pt-5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-muted-foreground">Delivery Success Rate</span>
                <span className={`text-sm font-bold ${rateColor}`} data-testid="ops-webhook-success-rate">
                  {(successRate * 100).toFixed(1)}%
                </span>
              </div>
              <div className="h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${successRate >= 0.99 ? "bg-green-500" : successRate >= 0.95 ? "bg-secondary" : "bg-destructive"}`}
                  style={{ width: `${successRate * 100}%` }}
                />
              </div>
            </CardContent>
          </Card>
        )}

        {/* Failure Log */}
        <Card className="bg-card border-card-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-destructive" /> Failure Log
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12" />)}
              </div>
            ) : data?.failures?.length ? (
              <div data-testid="ops-webhook-failures-list">
                {data.failures.map((f) => (
                  <div key={f.id} className="flex items-start justify-between px-4 py-3 border-b border-border last:border-0"
                    data-testid={`ops-webhook-failure-${f.id}`}>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-mono text-muted-foreground truncate">{f.endpoint ?? f.id.slice(0, 16)}</p>
                      {f.error && <p className="text-xs text-destructive mt-0.5 truncate">{f.error}</p>}
                      <div className="flex items-center gap-3 mt-1">
                        {f.statusCode && <Badge variant="outline" className="text-xs bg-destructive/10 text-destructive border-destructive/25">{f.statusCode}</Badge>}
                        {f.attempts != null && <span className="text-xs text-muted-foreground">{f.attempts}× tried</span>}
                      </div>
                    </div>
                    <Button size="sm" variant="outline" className="text-xs gap-1 h-7 ml-3"
                      onClick={() => replayWebhook.mutate(f.id)}
                      disabled={replayWebhook.isPending}
                      data-testid={`button-replay-${f.id}`}>
                      <RefreshCcw className="w-3 h-3" /> Replay
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-6 text-center">
                <CheckCircle className="w-7 h-7 text-green-400/60 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground" data-testid="ops-no-webhook-failures-msg">No webhook failures</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
