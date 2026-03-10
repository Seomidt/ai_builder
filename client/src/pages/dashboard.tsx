import { useQuery } from "@tanstack/react-query";
import { FolderKanban, PlayCircle, Cpu, Plug, Plus, ArrowRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import type { Project, AiRun, ArchitectureProfile, Integration } from "@shared/schema";

function StatCard({ label, value, icon: Icon, color }: { label: string; value: number | string; icon: React.ElementType; color: string }) {
  return (
    <Card className="bg-card border-card-border">
      <CardContent className="flex items-center gap-4 pt-5">
        <div className={`flex items-center justify-center w-10 h-10 rounded-lg ${color}`}>
          <Icon className="w-5 h-5" />
        </div>
        <div>
          <p className="text-2xl font-bold text-card-foreground" data-testid={`stat-${label.toLowerCase().replace(/\s/g,"-")}`}>{value}</p>
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function runStatusColor(status: AiRun["status"]) {
  const map: Record<AiRun["status"], string> = {
    pending: "bg-secondary/15 text-secondary border-secondary/25",
    running: "bg-primary/15 text-primary border-primary/25",
    completed: "bg-green-500/15 text-green-400 border-green-500/25",
    failed: "bg-destructive/15 text-destructive border-destructive/25",
    cancelled: "bg-muted text-muted-foreground border-border",
  };
  return map[status] ?? map.pending;
}

export default function Dashboard() {
  const { data: projects, isLoading: loadingProjects } = useQuery<Project[]>({ queryKey: ["/api/projects"] });
  const { data: runs, isLoading: loadingRuns } = useQuery<AiRun[]>({ queryKey: ["/api/runs"] });
  const { data: architectures, isLoading: loadingArchs } = useQuery<ArchitectureProfile[]>({ queryKey: ["/api/architectures"] });
  const { data: integrations, isLoading: loadingInts } = useQuery<Integration[]>({ queryKey: ["/api/integrations"] });

  const activeRuns = runs?.filter((r) => r.status === "running").length ?? 0;
  const configuredIntegrations = integrations?.filter((i) => i.status === "active").length ?? 0;

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-0.5">AI Builder Platform overview</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {loadingProjects ? <Skeleton className="h-20" /> : (
          <StatCard label="Total Projects" value={projects?.length ?? 0} icon={FolderKanban} color="bg-primary/15 text-primary" />
        )}
        {loadingRuns ? <Skeleton className="h-20" /> : (
          <StatCard label="Active Runs" value={activeRuns} icon={PlayCircle} color="bg-green-500/15 text-green-400" />
        )}
        {loadingArchs ? <Skeleton className="h-20" /> : (
          <StatCard label="Architectures" value={architectures?.length ?? 0} icon={Cpu} color="bg-secondary/15 text-secondary" />
        )}
        {loadingInts ? <Skeleton className="h-20" /> : (
          <StatCard label="Integrations" value={`${configuredIntegrations}/5`} icon={Plug} color="bg-purple-500/15 text-purple-400" />
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Projects */}
        <Card className="bg-card border-card-border">
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <CardTitle className="text-sm font-medium text-card-foreground">Recent Projects</CardTitle>
            <Link href="/projects" className="flex items-center gap-1 text-xs text-primary hover:opacity-80 transition-opacity">
              View all <ArrowRight className="w-3 h-3" />
            </Link>
          </CardHeader>
          <CardContent className="space-y-2">
            {loadingProjects ? (
              Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10" />)
            ) : projects?.length === 0 ? (
              <div className="text-center py-6">
                <p className="text-sm text-muted-foreground">No projects yet</p>
                <Link href="/projects">
                  <Button size="sm" variant="outline" className="mt-2">
                    <Plus className="w-3 h-3 mr-1" /> Create project
                  </Button>
                </Link>
              </div>
            ) : (
              projects?.slice(0, 5).map((p) => (
                <div key={p.id} data-testid={`project-row-${p.id}`} className="flex items-center justify-between py-2 px-3 rounded-md bg-muted/40 hover:bg-muted/70 transition-colors">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{p.name}</p>
                    <p className="text-xs text-muted-foreground truncate">{p.slug}</p>
                  </div>
                  <Badge variant="outline" className="shrink-0 ml-2 text-xs capitalize border-border">
                    {p.status}
                  </Badge>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {/* Recent Runs */}
        <Card className="bg-card border-card-border">
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <CardTitle className="text-sm font-medium text-card-foreground">Recent Runs</CardTitle>
            <Link href="/runs" className="flex items-center gap-1 text-xs text-primary hover:opacity-80 transition-opacity">
              View all <ArrowRight className="w-3 h-3" />
            </Link>
          </CardHeader>
          <CardContent className="space-y-2">
            {loadingRuns ? (
              Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10" />)
            ) : runs?.length === 0 ? (
              <div className="text-center py-6">
                <p className="text-sm text-muted-foreground">No runs yet</p>
              </div>
            ) : (
              runs?.slice(0, 5).map((r) => (
                <div key={r.id} data-testid={`run-row-${r.id}`} className="flex items-center justify-between py-2 px-3 rounded-md bg-muted/40 hover:bg-muted/70 transition-colors">
                  <div className="min-w-0">
                    <p className="text-xs font-mono text-foreground truncate">{r.id.slice(0, 8)}…</p>
                    <p className="text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleDateString()}</p>
                  </div>
                  <Badge variant="outline" className={`shrink-0 ml-2 text-xs capitalize border ${runStatusColor(r.status)}`}>
                    {r.status}
                  </Badge>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {/* Quick Actions */}
      <Card className="bg-card border-card-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-card-foreground">Quick Actions</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Link href="/projects">
            <Button size="sm" data-testid="btn-new-project">
              <Plus className="w-3.5 h-3.5 mr-1.5" /> New Project
            </Button>
          </Link>
          <Link href="/architectures">
            <Button size="sm" variant="outline" data-testid="btn-new-architecture">
              <Plus className="w-3.5 h-3.5 mr-1.5" /> New Architecture
            </Button>
          </Link>
          <Link href="/runs">
            <Button size="sm" variant="outline" data-testid="btn-new-run">
              <Plus className="w-3.5 h-3.5 mr-1.5" /> New Run
            </Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
