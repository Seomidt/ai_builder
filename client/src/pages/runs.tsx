import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { PlayCircle, Filter, Plus, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { AiRun, ArchitectureProfile } from "@shared/schema";

const STATUS_OPTIONS = ["all", "pending", "running", "completed", "failed", "cancelled"] as const;

function statusStyle(status: AiRun["status"]) {
  const map: Record<AiRun["status"], string> = {
    pending:   "text-secondary border-secondary/30 bg-secondary/10",
    running:   "text-primary border-primary/30 bg-primary/10",
    completed: "text-green-400 border-green-500/30 bg-green-500/10",
    failed:    "text-destructive border-destructive/30 bg-destructive/10",
    cancelled: "text-muted-foreground border-border bg-muted/30",
  };
  return map[status];
}

function statusDot(status: AiRun["status"]) {
  const map: Record<AiRun["status"], string> = {
    pending:   "bg-secondary",
    running:   "bg-primary animate-pulse",
    completed: "bg-green-400",
    failed:    "bg-destructive",
    cancelled: "bg-muted-foreground",
  };
  return map[status];
}

export default function Runs() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const queryParams = statusFilter !== "all" ? `?status=${statusFilter}` : "";
  const { data: runs, isLoading } = useQuery<AiRun[]>({
    queryKey: ["/api/runs", statusFilter],
    queryFn: () => fetch(`/api/runs${queryParams}`, { credentials: "include" }).then((r) => r.json()),
    refetchInterval: 5000,
  });

  const { data: architectures } = useQuery<ArchitectureProfile[]>({
    queryKey: ["/api/architectures"],
  });

  const createRunMutation = useMutation({
    mutationFn: async () => {
      const arch = architectures?.[0];
      if (!arch) throw new Error("No architecture available — create one first");
      const versions = (arch as ArchitectureProfile & { versions?: { id: string }[] }).versions;
      const versionId = versions?.[0]?.id;
      if (!versionId) throw new Error("No architecture version found — create a version first");
      return apiRequest("POST", "/api/runs", {
        projectId: "default",
        architectureProfileId: arch.id,
        architectureVersionId: versionId,
        title: `New Run`,
        goal: "Define a goal for this run",
        tags: [],
      });
    },
    onSuccess: async (res) => {
      const run = await res.json();
      queryClient.invalidateQueries({ queryKey: ["/api/runs"] });
      navigate(`/runs/${run.id}`);
    },
    onError: (err: Error) => {
      toast({ title: "Could not create run", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div className="p-6 space-y-5 max-w-6xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Runs</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{runs?.length ?? 0} runs</p>
        </div>
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-muted-foreground" />
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-36 h-8 text-xs" data-testid="select-run-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((s) => (
                <SelectItem key={s} value={s} className="text-xs capitalize">{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            className="h-8 text-xs"
            onClick={() => createRunMutation.mutate()}
            disabled={createRunMutation.isPending || !architectures?.length}
            data-testid="button-create-run"
          >
            {createRunMutation.isPending ? (
              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
            ) : (
              <Plus className="w-3.5 h-3.5 mr-1.5" />
            )}
            New Run
          </Button>
        </div>
      </div>

      <Card className="bg-card border-card-border">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12" />)}
            </div>
          ) : runs?.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <PlayCircle className="w-10 h-10 text-muted-foreground/30 mb-3" />
              <p className="text-sm font-medium text-muted-foreground">No runs found</p>
              <p className="text-xs text-muted-foreground/60 mt-1">
                {architectures?.length
                  ? "Click New Run to create your first pipeline run"
                  : "Create an architecture first, then start a run"}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {/* Header */}
              <div className="grid grid-cols-12 px-4 py-2.5 text-xs font-medium text-muted-foreground">
                <div className="col-span-1">#</div>
                <div className="col-span-4">Title</div>
                <div className="col-span-2">Status</div>
                <div className="col-span-2">Started</div>
                <div className="col-span-2">Finished</div>
                <div className="col-span-1">Steps</div>
              </div>
              {runs?.map((run) => (
                <div
                  key={run.id}
                  data-testid={`run-row-${run.id}`}
                  className="grid grid-cols-12 px-4 py-3 text-sm items-center hover:bg-muted/30 transition-colors cursor-pointer"
                  onClick={() => navigate(`/runs/${run.id}`)}
                >
                  <div className="col-span-1 font-mono text-xs text-muted-foreground">
                    {run.runNumber ?? "—"}
                  </div>
                  <div className="col-span-4 min-w-0">
                    <p className="text-xs font-medium text-foreground truncate">
                      {run.title || `Run ${run.id.slice(0, 8)}…`}
                    </p>
                    {run.goal && (
                      <p className="text-xs text-muted-foreground/60 truncate mt-0.5">{run.goal}</p>
                    )}
                  </div>
                  <div className="col-span-2">
                    <Badge
                      variant="outline"
                      className={`text-xs border capitalize flex items-center gap-1.5 w-fit ${statusStyle(run.status)}`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${statusDot(run.status)}`} />
                      {run.status}
                    </Badge>
                  </div>
                  <div className="col-span-2 text-xs text-muted-foreground">
                    {run.startedAt ? new Date(run.startedAt).toLocaleString() : "—"}
                  </div>
                  <div className="col-span-2 text-xs text-muted-foreground">
                    {run.finishedAt
                      ? new Date(run.finishedAt).toLocaleString()
                      : run.completedAt
                      ? new Date(run.completedAt).toLocaleString()
                      : "—"}
                  </div>
                  <div className="col-span-1 text-xs text-muted-foreground font-mono">
                    —
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
