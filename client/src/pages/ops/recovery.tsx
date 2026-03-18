import { useQuery, useMutation } from "@tanstack/react-query";
import { RefreshCcw, Database, CheckCircle, AlertTriangle, Play } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { OpsNav } from "@/components/ops/OpsNav";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface RecoveryResponse {
  jobs: {
    total: number;
    failed: number;
    stalled: number;
    lastActivity: string | null;
  };
  backupStatus: {
    lastVerified: string | null;
    healthy: boolean;
    message: string;
  };
  retrievedAt: string;
}

export default function OpsRecovery() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<RecoveryResponse>({
    queryKey: ["/api/admin/platform/recovery"],
  });

  const triggerRecovery = useMutation({
    mutationFn: () => apiRequest("POST", "/api/admin/ops/jobs/recover", {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/platform/recovery"] });
      toast({ title: "Recovery triggered", description: "Stalled jobs are being recovered" });
    },
    onError: (err: Error) => toast({ title: "Recovery failed", description: err.message, variant: "destructive" }),
  });

  const simulateRestore = useMutation({
    mutationFn: () => apiRequest("POST", "/api/admin/ops/backup/simulate", {}),
    onSuccess: () => toast({ title: "Simulation started", description: "Restore simulation is running" }),
    onError: (err: Error) => toast({ title: "Simulation failed", description: err.message, variant: "destructive" }),
  });

  return (
    <div className="flex flex-col h-full">
      <OpsNav />
      <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-6xl">
        <div>
          <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
            <RefreshCcw className="w-5 h-5 text-destructive" /> Recovery Tools
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Backup status, job recovery, and restore simulation
          </p>
        </div>

        {/* Job Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          {isLoading ? (
            Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-20" />)
          ) : (
            <>
              {[
                { label: "Total Jobs",   value: data?.jobs?.total   ?? "—", testId: "total",   icon: RefreshCcw },
                { label: "Failed Jobs",  value: data?.jobs?.failed  ?? "—", testId: "failed",  icon: AlertTriangle },
                { label: "Stalled Jobs", value: data?.jobs?.stalled ?? "—", testId: "stalled", icon: AlertTriangle },
              ].map(({ label, value, testId, icon: Icon }) => (
                <Card key={testId} className="bg-card border-card-border" data-testid={`ops-recovery-metric-${testId}`}>
                  <CardContent className="pt-5">
                    <div className="flex items-center gap-2 mb-1">
                      <Icon className="w-4 h-4 text-destructive" />
                      <p className="text-xs text-muted-foreground">{label}</p>
                    </div>
                    <p className="text-2xl font-bold" data-testid={`ops-recovery-value-${testId}`}>{value}</p>
                  </CardContent>
                </Card>
              ))}
            </>
          )}
        </div>

        {/* Job Recovery */}
        <Card className="bg-card border-card-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <RefreshCcw className="w-4 h-4 text-destructive" /> Job Recovery
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Trigger recovery for stalled or failed jobs. This will attempt to resume incomplete processing.
            </p>
            {!isLoading && data?.jobs && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/30 border border-border">
                {data.jobs.stalled === 0 && data.jobs.failed === 0
                  ? <CheckCircle className="w-4 h-4 text-green-400 shrink-0" />
                  : <AlertTriangle className="w-4 h-4 text-secondary shrink-0" />}
                <span className="text-sm" data-testid="ops-recovery-jobs-status">
                  {data.jobs.stalled} stalled, {data.jobs.failed} failed jobs
                </span>
              </div>
            )}
            <Button
              onClick={() => triggerRecovery.mutate()}
              disabled={triggerRecovery.isPending}
              className="gap-2"
              data-testid="button-trigger-recovery"
            >
              <Play className="w-4 h-4" />
              {triggerRecovery.isPending ? "Running…" : "Trigger Job Recovery"}
            </Button>
          </CardContent>
        </Card>

        {/* Backup Status */}
        <Card className="bg-card border-card-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Database className="w-4 h-4 text-destructive" /> Backup Status
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {isLoading ? (
              <Skeleton className="h-16" />
            ) : (
              <>
                <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/30 border border-border">
                  {data?.backupStatus?.healthy
                    ? <CheckCircle className="w-4 h-4 text-green-400 shrink-0" />
                    : <AlertTriangle className="w-4 h-4 text-destructive shrink-0" />}
                  <div>
                    <p className="text-sm font-medium" data-testid="ops-backup-status-msg">
                      {data?.backupStatus?.message ?? "Unknown"}
                    </p>
                    {data?.backupStatus?.lastVerified && (
                      <p className="text-xs text-muted-foreground">
                        Last verified: {new Date(data.backupStatus.lastVerified).toLocaleString()}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" className="gap-1.5"
                    onClick={() => simulateRestore.mutate()}
                    disabled={simulateRestore.isPending}
                    data-testid="button-simulate-restore">
                    <Play className="w-3.5 h-3.5" />
                    {simulateRestore.isPending ? "Simulating…" : "Simulate Restore"}
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
