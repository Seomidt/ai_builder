import { useQuery, useMutation } from "@tanstack/react-query";
import { Cpu, AlertTriangle, RefreshCcw, CheckCircle, Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { OpsNav } from "@/components/ops/OpsNav";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface JobsResponse {
  summary: {
    totalActive?: number;
    queueDepth?: number;
    errorRate?: number;
    avgLatencyMs?: number;
  };
  active: { id: string; type: string; status: string; startedAt?: string }[];
  failed: { id: string; type: string; error?: string; attempts?: number; failedAt?: string }[];
  retrievedAt: string;
}

function statusBadge(status: string) {
  const map: Record<string, string> = {
    running:   "bg-primary/15 text-primary border-primary/25",
    completed: "bg-green-500/15 text-green-400 border-green-500/25",
    failed:    "bg-destructive/15 text-destructive border-destructive/25",
    pending:   "bg-secondary/15 text-secondary border-secondary/25",
    stalled:   "bg-secondary/15 text-secondary border-secondary/25",
  };
  return map[status] ?? map.pending;
}

export default function OpsJobs() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<JobsResponse>({
    queryKey: ["/api/admin/platform/jobs"],
  });

  const retryJob = useMutation({
    mutationFn: (jobId: string) => apiRequest("POST", `/api/admin/ops/jobs/${jobId}/retry`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/platform/jobs"] });
      toast({ title: "Job retry queued", description: "The job has been re-queued" });
    },
    onError: (err: Error) => toast({ title: "Retry failed", description: err.message, variant: "destructive" }),
  });

  return (
    <div className="flex flex-col h-full">
      <OpsNav />
      <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-6xl">
        <div>
          <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
            <Cpu className="w-5 h-5 text-destructive" /> Job Monitoring
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">Background jobs, queue health, and failure analysis</p>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {isLoading ? (
            Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20" />)
          ) : (
            <>
              {[
                { label: "Active Jobs",  value: data?.summary?.totalActive ?? "—", icon: RefreshCcw, testId: "active" },
                { label: "Queue Depth",  value: data?.summary?.queueDepth  ?? "—", icon: Clock,       testId: "queue" },
                { label: "Failed Jobs",  value: data?.failed?.length        ?? "—", icon: AlertTriangle, testId: "failed" },
                { label: "Avg Latency",  value: data?.summary?.avgLatencyMs != null ? `${data.summary.avgLatencyMs}ms` : "—", icon: Cpu, testId: "latency" },
              ].map(({ label, value, icon: Icon, testId }) => (
                <Card key={testId} className="bg-card border-card-border" data-testid={`ops-jobs-metric-${testId}`}>
                  <CardContent className="pt-5">
                    <div className="flex items-center gap-2 mb-1">
                      <Icon className="w-4 h-4 text-destructive" />
                      <p className="text-xs text-muted-foreground">{label}</p>
                    </div>
                    <p className="text-2xl font-bold" data-testid={`ops-jobs-value-${testId}`}>{value}</p>
                  </CardContent>
                </Card>
              ))}
            </>
          )}
        </div>

        {/* Active Jobs */}
        <Card className="bg-card border-card-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <RefreshCcw className="w-4 h-4 text-primary" /> Active Jobs
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10" />)}
              </div>
            ) : data?.active?.length ? (
              <div data-testid="ops-active-jobs-list">
                {data.active.map((job) => (
                  <div key={job.id} className="flex items-center justify-between px-4 py-3 border-b border-border last:border-0"
                    data-testid={`ops-job-active-${job.id}`}>
                    <div>
                      <p className="text-xs font-mono text-muted-foreground">{job.id.slice(0, 10)}…</p>
                      <p className="text-sm font-medium capitalize">{job.type}</p>
                    </div>
                    <Badge variant="outline" className={`text-xs ${statusBadge(job.status)}`}
                      data-testid={`ops-job-status-${job.id}`}>{job.status}</Badge>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-6 text-center">
                <CheckCircle className="w-7 h-7 text-green-400/60 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground" data-testid="ops-no-active-jobs-msg">No active jobs</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Failed Jobs */}
        <Card className="bg-card border-card-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-destructive" /> Failed Jobs
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12" />)}
              </div>
            ) : data?.failed?.length ? (
              <div data-testid="ops-failed-jobs-list">
                {data.failed.map((job) => (
                  <div key={job.id} className="flex items-center justify-between px-4 py-3 border-b border-border last:border-0"
                    data-testid={`ops-job-failed-${job.id}`}>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-mono text-muted-foreground">{job.id.slice(0, 10)}…</p>
                      <p className="text-sm font-medium capitalize">{job.type}</p>
                      {job.error && <p className="text-xs text-destructive truncate">{job.error}</p>}
                    </div>
                    <div className="flex items-center gap-2 ml-3">
                      {job.attempts != null && (
                        <span className="text-xs text-muted-foreground">{job.attempts}× tried</span>
                      )}
                      <Button size="sm" variant="outline" className="text-xs gap-1 h-7"
                        onClick={() => retryJob.mutate(job.id)}
                        disabled={retryJob.isPending}
                        data-testid={`button-retry-job-${job.id}`}>
                        <RefreshCcw className="w-3 h-3" /> Retry
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-6 text-center">
                <CheckCircle className="w-7 h-7 text-green-400/60 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground" data-testid="ops-no-failed-jobs-msg">No failed jobs</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
