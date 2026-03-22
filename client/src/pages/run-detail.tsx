import { useParams, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  ArrowLeft, PlayCircle, GitBranch, Tag, FileText,
  CheckCircle2, XCircle, Clock, SkipForward, Loader2,
  ChevronDown, ChevronRight, Copy, Package,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { friendlyError } from "@/lib/friendlyError";
import { useState } from "react";
import type { AiRun, AiStep, AiArtifact } from "@shared/schema";
import { QUERY_POLICY } from "@/lib/query-policy";
import { invalidate } from "@/lib/invalidations";

// ─── Types ────────────────────────────────────────────────────────────────────

type RunDetail = AiRun & {
  steps: AiStep[];
  artifacts: AiArtifact[];
};

interface CommitPreview {
  branch: string;
  title: string;
  body: string;
  fullMessage: string;
  tags: string[];
  note: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stepStatusIcon(status: AiStep["status"]) {
  const base = "w-4 h-4 flex-shrink-0";
  switch (status) {
    case "completed": return <CheckCircle2 className={`${base} text-green-400`} />;
    case "failed":    return <XCircle className={`${base} text-destructive`} />;
    case "running":   return <Loader2 className={`${base} text-primary animate-spin`} />;
    case "skipped":   return <SkipForward className={`${base} text-muted-foreground`} />;
    default:          return <Clock className={`${base} text-muted-foreground`} />;
  }
}

function runStatusBadge(status: AiRun["status"]) {
  const map: Record<AiRun["status"], string> = {
    pending:   "text-secondary border-secondary/30 bg-secondary/10",
    running:   "text-primary border-primary/30 bg-primary/10",
    completed: "text-green-400 border-green-500/30 bg-green-500/10",
    failed:    "text-destructive border-destructive/30 bg-destructive/10",
    cancelled: "text-muted-foreground border-border bg-muted/30",
  };
  const dot: Record<AiRun["status"], string> = {
    pending:   "bg-secondary",
    running:   "bg-primary animate-pulse",
    completed: "bg-green-400",
    failed:    "bg-destructive",
    cancelled: "bg-muted-foreground",
  };
  return (
    <Badge variant="outline" className={`text-xs border capitalize flex items-center gap-1.5 ${map[status]}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot[status]}`} />
      {status}
    </Badge>
  );
}

function artifactTypeBadgeColor(type: string) {
  const map: Record<string, string> = {
    plan:      "bg-blue-500/10 text-blue-400 border-blue-500/30",
    ux_spec:   "bg-purple-500/10 text-purple-400 border-purple-500/30",
    arch_spec: "bg-orange-500/10 text-orange-400 border-orange-500/30",
    file_tree: "bg-teal-500/10 text-teal-400 border-teal-500/30",
    review:    "bg-yellow-500/10 text-yellow-400 border-yellow-500/30",
  };
  return map[type] ?? "bg-muted/30 text-muted-foreground border-border";
}

function elapsed(start?: Date | string | null, end?: Date | string | null): string {
  if (!start) return "—";
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const ms = e - s;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60000)}m`;
}

// ─── Artifact Card ─────────────────────────────────────────────────────────────

function ArtifactCard({ artifact }: { artifact: AiArtifact }) {
  const [expanded, setExpanded] = useState(false);
  const { toast } = useToast();

  const content = artifact.content ?? "";
  const preview = content.length > 300 ? content.slice(0, 300) + "…" : content;

  function copyContent() {
    navigator.clipboard.writeText(content);
    toast({ title: "Copied", description: "Artifact content copied to clipboard" });
  }

  return (
    <Card className="bg-card border-card-border" data-testid={`card-artifact-${artifact.id}`}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className={`text-xs border ${artifactTypeBadgeColor(artifact.artifactType)}`}>
              {artifact.artifactType}
            </Badge>
            {artifact.version && (
              <Badge variant="outline" className="text-xs border text-muted-foreground border-border">
                {artifact.version}
              </Badge>
            )}
          </div>
          {content && (
            <Button size="icon" variant="ghost" className="w-6 h-6 text-muted-foreground hover:text-foreground" onClick={copyContent}>
              <Copy className="w-3.5 h-3.5" />
            </Button>
          )}
        </div>
        <p className="text-sm font-medium text-foreground">{artifact.title}</p>
        {artifact.description && (
          <p className="text-xs text-muted-foreground mt-0.5">{artifact.description}</p>
        )}
        {artifact.path && (
          <p className="text-xs font-mono text-muted-foreground/70 mt-1">
            <span className="text-muted-foreground">→</span> {artifact.path}
          </p>
        )}
        {content && (
          <div className="mt-3">
            <button
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setExpanded(!expanded)}
              data-testid={`button-expand-artifact-${artifact.id}`}
            >
              {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              {expanded ? "Hide" : "Preview"} content
            </button>
            {expanded && (
              <pre className="mt-2 p-3 rounded-md bg-muted/40 text-xs font-mono text-muted-foreground overflow-x-auto max-h-64 whitespace-pre-wrap border border-border/50">
                {preview}
              </pre>
            )}
          </div>
        )}
        {artifact.tags && artifact.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-3">
            {artifact.tags.map((t) => (
              <span key={t} className="text-xs text-muted-foreground/60 bg-muted/30 px-1.5 py-0.5 rounded">
                {t}
              </span>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function RunDetail() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();

  // Primary query — detail policy + dynamic refetchInterval when active
  const { data: run, isLoading } = useQuery<RunDetail>({
    queryKey: ["/api/runs", id],
    queryFn: () => apiRequest("GET", `/api/runs/${id}`).then((r) => r.json()),
    ...QUERY_POLICY.detailLive,
    refetchInterval: (query) => {
      const data = query.state.data as RunDetail | undefined;
      return data?.status === "running" || data?.status === "pending" ? 2000 : false;
    },
  });

  // Non-critical deferred query — only fires when run is complete/running
  // Does not block shell or primary tab content
  const { data: commitPreview } = useQuery<CommitPreview>({
    queryKey: ["/api/runs", id, "commit-preview"],
    queryFn: () => apiRequest("GET", `/api/runs/${id}/commit-preview`).then((r) => r.json()),
    enabled: !!run && (run.status === "completed" || run.status === "running"),
    ...QUERY_POLICY.detail,
  });

  const executeMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/runs/${id}/execute`),
    onSuccess: () => {
      invalidate.afterRunStatusChange(id!);
      toast({ title: "Pipeline started", description: "Agents are running…" });
    },
    onError: (err: Error) => {
      toast({ title: "Execution failed", description: friendlyError(err), variant: "destructive" });
    },
  });

  function copyText(text: string, label: string) {
    navigator.clipboard.writeText(text);
    toast({ title: "Copied", description: `${label} copied to clipboard` });
  }

  // Shell renders immediately; skeleton only for primary card area
  if (isLoading) {
    return (
      <div className="p-6 space-y-4 max-w-5xl">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" className="text-muted-foreground" onClick={() => navigate("/runs")}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <Skeleton className="h-7 w-56" />
        </div>
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!run) {
    return (
      <div className="p-6 text-sm text-muted-foreground">Run not found.</div>
    );
  }

  const canExecute = run.status === "pending";
  const isActive = run.status === "running";

  return (
    <div className="p-6 space-y-5 max-w-5xl">
      {/* Header */}
      <div className="flex items-start gap-4">
        <Button
          variant="ghost"
          size="icon"
          className="mt-0.5 text-muted-foreground hover:text-foreground"
          onClick={() => navigate("/runs")}
          data-testid="button-back-to-runs"
        >
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {run.runNumber && (
              <span className="text-xs font-mono text-muted-foreground">
                #{run.runNumber}
              </span>
            )}
            {runStatusBadge(run.status)}
            {isActive && (
              <span className="text-xs text-primary animate-pulse">Pipeline running…</span>
            )}
          </div>
          <h1 className="text-xl font-semibold text-foreground mt-1 truncate" data-testid="text-run-title">
            {run.title || `Run ${run.id.slice(0, 8)}…`}
          </h1>
          {run.goal && (
            <p className="text-sm text-muted-foreground mt-0.5 line-clamp-2">{run.goal}</p>
          )}
        </div>
        {canExecute && (
          <Button
            onClick={() => executeMutation.mutate()}
            disabled={executeMutation.isPending}
            data-testid="button-execute-run"
            className="flex-shrink-0"
          >
            {executeMutation.isPending ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <PlayCircle className="w-4 h-4 mr-2" />
            )}
            Execute
          </Button>
        )}
      </div>

      {/* Meta strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Steps",     value: run.steps.length.toString() },
          { label: "Artifacts", value: run.artifacts.length.toString() },
          { label: "Started",   value: run.startedAt ? new Date(run.startedAt).toLocaleString() : "—" },
          { label: "Duration",  value: elapsed(run.startedAt, run.finishedAt ?? run.completedAt) },
        ].map(({ label, value }) => (
          <Card key={label} className="bg-card border-card-border">
            <CardContent className="p-3">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="text-sm font-semibold text-foreground mt-0.5" data-testid={`text-run-${label.toLowerCase()}`}>
                {value}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Tabs */}
      <Tabs defaultValue="steps">
        <TabsList className="bg-muted/30 border border-border">
          <TabsTrigger value="steps" data-testid="tab-steps">
            Steps ({run.steps.length})
          </TabsTrigger>
          <TabsTrigger value="artifacts" data-testid="tab-artifacts">
            Artifacts ({run.artifacts.length})
          </TabsTrigger>
          <TabsTrigger value="commit" data-testid="tab-commit">
            Commit Preview
          </TabsTrigger>
        </TabsList>

        {/* ── Steps tab ─────────────────────────────────────────────────────── */}
        <TabsContent value="steps" className="mt-4">
          {run.steps.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <PlayCircle className="w-8 h-8 text-muted-foreground/30 mb-2" />
              <p className="text-sm text-muted-foreground">
                {canExecute ? "Click Execute to start the pipeline" : "No steps yet"}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {run.steps.map((step, i) => (
                <Card key={step.id} className="bg-card border-card-border" data-testid={`card-step-${step.id}`}>
                  <CardContent className="p-4">
                    <div className="flex items-start gap-3">
                      <div className="flex flex-col items-center gap-1">
                        <span className="text-xs font-mono text-muted-foreground/50 w-4 text-center">{i + 1}</span>
                        {stepStatusIcon(step.status)}
                        {i < run.steps.length - 1 && (
                          <div className="w-px flex-1 min-h-4 bg-border/40" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-medium text-foreground">{step.title || step.agentKey}</p>
                          <Badge variant="outline" className="text-xs border text-muted-foreground border-border font-mono">
                            {step.agentKey}
                          </Badge>
                          <span className="text-xs text-muted-foreground ml-auto">
                            {elapsed(step.startedAt, step.completedAt)}
                          </span>
                        </div>
                        {step.description && (
                          <p className="text-xs text-muted-foreground mt-0.5">{step.description}</p>
                        )}
                        {(() => {
                          const out = step.output;
                          if (!out || typeof out !== "object" || Array.isArray(out)) return null;
                          const entries = Object.entries(out as Record<string, unknown>);
                          if (entries.length === 0) return null;
                          return (
                            <div className="mt-2 flex flex-wrap gap-2">
                              {entries.map(([k, v]) => (
                                <span key={k} className="text-xs text-muted-foreground bg-muted/30 px-2 py-0.5 rounded">
                                  {k}: <span className="text-foreground">{String(v)}</span>
                                </span>
                              ))}
                            </div>
                          );
                        })()}
                        {step.error && (
                          <p className="text-xs text-destructive mt-1">{step.error}</p>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* ── Artifacts tab ──────────────────────────────────────────────────── */}
        <TabsContent value="artifacts" className="mt-4">
          {run.artifacts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Package className="w-8 h-8 text-muted-foreground/30 mb-2" />
              <p className="text-sm text-muted-foreground">
                {canExecute ? "Run the pipeline to generate artifacts" : "No artifacts yet"}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {run.artifacts.map((artifact) => (
                <ArtifactCard key={artifact.id} artifact={artifact} />
              ))}
            </div>
          )}
        </TabsContent>

        {/* ── Commit Preview tab ─────────────────────────────────────────────── */}
        <TabsContent value="commit" className="mt-4">
          {!commitPreview ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <GitBranch className="w-8 h-8 text-muted-foreground/30 mb-2" />
              <p className="text-sm text-muted-foreground">
                {canExecute
                  ? "Complete the pipeline to generate a commit preview"
                  : "Commit preview is available once the run completes"}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-start gap-2 p-3 rounded-md bg-secondary/10 border border-secondary/20 text-xs text-secondary">
                <FileText className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                {commitPreview.note}
              </div>

              <Card className="bg-card border-card-border">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <GitBranch className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                      <div className="min-w-0">
                        <p className="text-xs text-muted-foreground">Branch</p>
                        <p className="text-sm font-mono text-foreground truncate" data-testid="text-commit-branch">
                          {commitPreview.branch}
                        </p>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-xs text-muted-foreground hover:text-foreground flex-shrink-0"
                      onClick={() => copyText(commitPreview.branch, "Branch name")}
                      data-testid="button-copy-branch"
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </CardContent>
              </Card>

              <Card className="bg-card border-card-border">
                <CardHeader className="pb-2 pt-4 px-4">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm font-medium">Commit Message</CardTitle>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => copyText(commitPreview.fullMessage, "Commit message")}
                      data-testid="button-copy-commit"
                    >
                      <Copy className="w-3.5 h-3.5 mr-1" /> Copy
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="px-4 pb-4">
                  <p className="text-sm font-semibold text-foreground" data-testid="text-commit-title">
                    {commitPreview.title}
                  </p>
                  <pre className="mt-2 text-xs font-mono text-muted-foreground whitespace-pre-wrap leading-relaxed">
                    {commitPreview.body}
                  </pre>
                </CardContent>
              </Card>

              {commitPreview.tags && commitPreview.tags.length > 0 && (
                <Card className="bg-card border-card-border">
                  <CardContent className="p-4">
                    <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1">
                      <Tag className="w-3.5 h-3.5" /> Git tags
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {commitPreview.tags.map((tag) => (
                        <Badge
                          key={tag}
                          variant="outline"
                          className="text-xs font-mono border-border text-muted-foreground"
                          data-testid={`badge-tag-${tag}`}
                        >
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              {run.artifacts.length > 0 && (
                <Card className="bg-card border-card-border">
                  <CardContent className="p-4">
                    <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1">
                      <Package className="w-3.5 h-3.5" />
                      Files that will be written when GitHub write is enabled
                    </p>
                    <div className="space-y-1">
                      {run.artifacts.filter((a) => a.path).map((a) => (
                        <div key={a.id} className="flex items-center gap-2 text-xs">
                          <span className="text-muted-foreground/50">+</span>
                          <span className="font-mono text-muted-foreground">{a.path}</span>
                          <Badge variant="outline" className={`text-xs border ml-auto ${artifactTypeBadgeColor(a.artifactType)}`}>
                            {a.artifactType}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
