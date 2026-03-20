import { useEffect } from "react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { PlayCircle, Filter, Plus, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { supabase } from "@/lib/supabase";
import { QUERY_POLICY, PAGE_LIMIT } from "@/lib/query-policy";
import { invalidate } from "@/lib/invalidations";
import { usePagePerf } from "@/lib/perf";
import { useQueryState } from "@/lib/use-query-state";

type RunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

interface RunRow {
  id: string;
  runNumber: number | null;
  status: RunStatus;
  title: string | null;
  goal: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  completedAt: string | null;
}

interface ArchRow {
  id: string;
  currentVersionId: string | null;
}

interface ArchPage {
  items: ArchRow[];
  nextCursor: string | null;
}

interface RunPage {
  items: RunRow[];
  nextCursor: string | null;
}

const STATUS_OPTIONS = ["all", "pending", "running", "completed", "failed", "cancelled"] as const;

function statusStyle(status: RunStatus) {
  const map: Record<RunStatus, string> = {
    pending:   "text-secondary border-secondary/30 bg-secondary/10",
    running:   "text-primary border-primary/30 bg-primary/10",
    completed: "text-green-400 border-green-500/30 bg-green-500/10",
    failed:    "text-destructive border-destructive/30 bg-destructive/10",
    cancelled: "text-muted-foreground border-border bg-muted/30",
  };
  return map[status] ?? "";
}

function statusDot(status: RunStatus) {
  const map: Record<RunStatus, string> = {
    pending:   "bg-secondary",
    running:   "bg-primary animate-pulse",
    completed: "bg-green-400",
    failed:    "bg-destructive",
    cancelled: "bg-muted-foreground",
  };
  return map[status] ?? "";
}

export default function Runs() {
  const [statusFilter, setStatusFilter] = useQueryState("status", "all");
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const perf = usePagePerf("runs");

  const {
    data,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery<RunPage>({
    queryKey: ["runs", statusFilter],
    queryFn: async ({ pageParam }) => {
      const { data, error } = await supabase.rpc("get_runs_page", {
        p_limit: PAGE_LIMIT.runs,
        p_cursor: (pageParam as string | null) ?? null,
        p_status: statusFilter === "all" ? null : statusFilter,
      });
      if (error) throw new Error(error.message);
      return (data as unknown as RunPage);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    maxPages: 3,
    ...QUERY_POLICY.semiLive,
  });

  const runs = data?.pages.flatMap((p) => p.items) ?? [];

  useEffect(() => {
    if (runs.length > 0 || !isLoading) perf.record(runs.length);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs.length, isLoading]);

  // Shared architectures cache — reuses key from architectures page if visited
  const { data: archData } = useQuery<ArchPage>({
    queryKey: ["architectures"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_architectures_page", {
        p_limit: 1,
        p_cursor: null,
      });
      if (error) throw new Error(error.message);
      return (data as unknown as ArchPage);
    },
    ...QUERY_POLICY.staticList,
  });

  const firstArch = archData?.items?.[0];

  const createRunMutation = useMutation({
    mutationFn: async () => {
      if (!firstArch) throw new Error("No architecture available — create one first");
      if (!firstArch.currentVersionId) throw new Error("No published version — publish an architecture version first");
      return apiRequest("POST", "/api/runs", {
        projectId: "default",
        architectureProfileId: firstArch.id,
        architectureVersionId: firstArch.currentVersionId,
        title: "New Run",
        goal: "Define a goal for this run",
        tags: [],
      });
    },
    onSuccess: async (res) => {
      const run = await res.json();
      await invalidate.afterRunCreate(run.id);
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
          <p className="text-sm text-muted-foreground mt-0.5">{runs.length} run{runs.length !== 1 ? "s" : ""}</p>
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
            disabled={createRunMutation.isPending || !firstArch}
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
          ) : runs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <PlayCircle className="w-10 h-10 text-muted-foreground/30 mb-3" />
              <p className="text-sm font-medium text-muted-foreground">No runs found</p>
              <p className="text-xs text-muted-foreground/60 mt-1">
                {firstArch
                  ? "Click New Run to create your first pipeline run"
                  : "Create an architecture first, then start a run"}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              <div className="grid grid-cols-12 px-4 py-2.5 text-xs font-medium text-muted-foreground">
                <div className="col-span-1">#</div>
                <div className="col-span-4">Title</div>
                <div className="col-span-2">Status</div>
                <div className="col-span-2">Started</div>
                <div className="col-span-2">Finished</div>
                <div className="col-span-1">Steps</div>
              </div>
              {runs.map((run) => (
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
                  <div className="col-span-1 text-xs text-muted-foreground font-mono">—</div>
                </div>
              ))}
              {hasNextPage && (
                <div className="flex justify-center p-4">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fetchNextPage()}
                    disabled={isFetchingNextPage}
                    data-testid="btn-load-more-runs"
                  >
                    {isFetchingNextPage ? "Loading…" : "Load more"}
                  </Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
