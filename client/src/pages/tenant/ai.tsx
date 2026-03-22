import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { BrainCircuit, Play, ChevronRight, ChevronLeft, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TenantNav } from "@/components/tenant/TenantNav";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { friendlyError } from "@/lib/friendlyError";
import type { AiRun } from "@shared/schema";

interface AiRunsPage {
  runs: AiRun[];
  pagination: { hasMore: boolean; nextCursor: string | null; limit: number };
  retrievedAt: string;
}

function statusBadge(status: string) {
  const map: Record<string, string> = {
    running:   "bg-primary/15 text-primary border-primary/25",
    completed: "bg-green-500/15 text-green-400 border-green-500/25",
    failed:    "bg-destructive/15 text-destructive border-destructive/25",
    pending:   "bg-secondary/15 text-secondary border-secondary/25",
    cancelled: "bg-muted text-muted-foreground border-border",
  };
  return map[status] ?? map.pending;
}

export default function TenantAi() {
  const { toast } = useToast();
  const [cursor, setCursor]     = useState<string | undefined>(undefined);
  const [cursorStack, setStack] = useState<(string | undefined)[]>([]);

  const { data, isLoading } = useQuery<AiRunsPage>({
    queryKey: cursor ? ["/api/tenant/ai/runs", cursor] : ["/api/tenant/ai/runs"],
  });

  const startRun = useMutation({
    mutationFn: () => apiRequest("POST", "/api/runs", { projectId: null, prompt: "Demo AI run" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tenant/ai/runs"] });
      toast({ title: "AI run started", description: "New run is queued" });
    },
    onError: (err: Error) => toast({ title: "Error", description: friendlyError(err), variant: "destructive" }),
  });

  const nextPage = () => {
    if (!data?.pagination.hasMore || !data.pagination.nextCursor) return;
    setStack((s) => [...s, cursor]);
    setCursor(data.pagination.nextCursor);
  };
  const prevPage = () => {
    const stack = [...cursorStack];
    const prev  = stack.pop();
    setStack(stack);
    setCursor(prev);
  };

  return (
    <div className="flex flex-col h-full">
      <TenantNav />
      <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-6xl">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2.5">
              <div
                className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0"
                style={{ background: "rgba(34,211,238,0.12)", border: "1px solid rgba(34,211,238,0.20)" }}
              >
                <BrainCircuit className="w-4 h-4 text-primary" />
              </div>
              <h1 className="text-xl font-bold text-foreground tracking-tight">AI Operations</h1>
            </div>
            <p className="text-sm text-muted-foreground ml-10">Run and monitor AI workflows</p>
          </div>
          <Button
            size="sm" className="gap-1.5"
            onClick={() => startRun.mutate()}
            disabled={startRun.isPending}
            data-testid="button-start-ai-run"
          >
            <Play className="w-4 h-4" />
            {startRun.isPending ? "Starting…" : "Start Run"}
          </Button>
        </div>

        {/* Info Banner */}
        <Card className="bg-secondary/10 border-secondary/25">
          <CardContent className="py-3 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-secondary shrink-0" />
            <p className="text-xs text-secondary-foreground">
              All AI operations respect tenant quotas, governance policies, and budget limits.
            </p>
          </CardContent>
        </Card>

        {/* Runs Table */}
        <Card className="bg-card border-card-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">AI Runs</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10" />)}
              </div>
            ) : data?.runs?.length ? (
              <div data-testid="ai-runs-list">
                {data.runs.map((run) => (
                  <div
                    key={run.id}
                    className="flex items-center justify-between px-4 py-3 border-b border-border last:border-0 hover:bg-muted/30"
                    data-testid={`ai-run-row-${run.id}`}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-mono text-muted-foreground" data-testid={`ai-run-id-${run.id}`}>{run.id.slice(0, 12)}…</p>
                      <p className="text-xs text-foreground mt-0.5 truncate">{(run as any).prompt ?? "AI task"}</p>
                    </div>
                    <div className="flex items-center gap-3 ml-4">
                      <Badge variant="outline" className={`text-xs ${statusBadge(run.status)}`} data-testid={`ai-run-status-${run.id}`}>
                        {run.status}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {new Date((run as any).createdAt ?? Date.now()).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-8 text-center">
                <BrainCircuit className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground" data-testid="no-ai-runs-msg">No AI runs yet. Start your first run.</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Cursor Pagination */}
        <div className="flex items-center justify-between" data-testid="ai-pagination-controls">
          <Button
            variant="outline" size="sm" onClick={prevPage} disabled={cursorStack.length === 0}
            className="gap-1.5" data-testid="button-ai-prev-page"
          >
            <ChevronLeft className="w-4 h-4" /> Previous
          </Button>
          <span className="text-xs text-muted-foreground" data-testid="ai-pagination-info">
            {data?.runs?.length ?? 0} runs shown
          </span>
          <Button
            variant="outline" size="sm" onClick={nextPage} disabled={!data?.pagination.hasMore}
            className="gap-1.5" data-testid="button-ai-next-page"
          >
            Next <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
