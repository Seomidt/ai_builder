import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Database, Search, Plus, ChevronRight, ChevronLeft } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { TenantNav } from "@/components/tenant/TenantNav";
import type { Project } from "@shared/schema";

const PAGE_SIZE = 10;

function statusColor(status: string) {
  return status === "active"
    ? "bg-green-500/15 text-green-400 border-green-500/25"
    : "bg-muted text-muted-foreground border-border";
}

export default function TenantData() {
  const [search, setSearch]     = useState("");
  const [cursor, setCursor]     = useState<string | null>(null);
  const [cursorStack, setStack] = useState<string[]>([]);

  const { data: projects, isLoading } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
  });

  const filtered = (projects ?? []).filter((p) =>
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    (p.description ?? "").toLowerCase().includes(search.toLowerCase()),
  );

  const cursorIdx  = cursor ? filtered.findIndex((p) => p.id === cursor) : 0;
  const pageStart  = cursorIdx < 0 ? 0 : cursorIdx;
  const page       = filtered.slice(pageStart, pageStart + PAGE_SIZE);
  const hasMore    = pageStart + PAGE_SIZE < filtered.length;
  const hasPrev    = cursorStack.length > 0;

  const nextPage = () => {
    if (!hasMore) return;
    setStack((s) => [...s, cursor ?? ""]);
    setCursor(page[page.length - 1]?.id ?? null);
  };
  const prevPage = () => {
    const stack = [...cursorStack];
    const prev  = stack.pop() ?? null;
    setStack(stack);
    setCursor(prev);
  };

  return (
    <div className="flex flex-col h-full">
      <TenantNav />
      <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-6xl">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
              <Database className="w-5 h-5 text-primary" /> Data Management
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">Manage records, projects, and datasets</p>
          </div>
          <Button size="sm" className="gap-1.5" data-testid="button-create-record">
            <Plus className="w-4 h-4" /> New Record
          </Button>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search records…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setCursor(null); setStack([]); }}
            className="pl-9"
            data-testid="input-search-records"
          />
        </div>

        {/* Record Table */}
        <Card className="bg-card border-card-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center justify-between">
              <span>Projects ({filtered.length})</span>
              <span className="text-xs text-muted-foreground font-normal">
                Page {cursorStack.length + 1}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10" />)}
              </div>
            ) : page.length > 0 ? (
              <div data-testid="records-list">
                {page.map((project) => (
                  <div
                    key={project.id}
                    className="flex items-center justify-between px-4 py-3 border-b border-border last:border-0 hover:bg-muted/30 transition-colors"
                    data-testid={`record-row-${project.id}`}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate" data-testid={`record-name-${project.id}`}>{project.name}</p>
                      <p className="text-xs text-muted-foreground truncate">{project.description ?? "No description"}</p>
                    </div>
                    <div className="flex items-center gap-3 ml-4">
                      <Badge variant="outline" className={`text-xs ${statusColor(project.status)}`} data-testid={`record-status-${project.id}`}>
                        {project.status}
                      </Badge>
                      <span className="text-xs text-muted-foreground">{new Date(project.createdAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-8 text-center">
                <p className="text-sm text-muted-foreground" data-testid="no-records-msg">
                  {search ? "No records match your search" : "No records yet"}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Cursor Pagination */}
        <div className="flex items-center justify-between" data-testid="pagination-controls">
          <Button
            variant="outline" size="sm" onClick={prevPage} disabled={!hasPrev}
            className="gap-1.5" data-testid="button-prev-page"
          >
            <ChevronLeft className="w-4 h-4" /> Previous
          </Button>
          <span className="text-xs text-muted-foreground" data-testid="pagination-info">
            Showing {page.length} of {filtered.length}
          </span>
          <Button
            variant="outline" size="sm" onClick={nextPage} disabled={!hasMore}
            className="gap-1.5" data-testid="button-next-page"
          >
            Next <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
