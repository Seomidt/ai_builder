import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ScrollText, Shield, ChevronRight, ChevronLeft, Search } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { TenantNav } from "@/components/tenant/TenantNav";

interface AuditResponse {
  events: {
    id: string;
    eventType: string;
    tenantId: string | null;
    userId: string | null;
    ipAddress: string | null;
    createdAt: string;
  }[];
  pagination: { hasMore: boolean; nextCursor: string | null; limit: number };
  retrievedAt: string;
}

const EVENT_COLORS: Record<string, string> = {
  login:        "bg-primary/15 text-primary border-primary/25",
  logout:       "bg-muted text-muted-foreground border-border",
  api_request:  "bg-muted text-muted-foreground border-border",
  security:     "bg-destructive/15 text-destructive border-destructive/25",
  billing:      "bg-secondary/15 text-secondary border-secondary/25",
  ai_operation: "bg-green-500/15 text-green-400 border-green-500/25",
};

function eventColor(type: string) {
  for (const [key, val] of Object.entries(EVENT_COLORS)) {
    if (type.toLowerCase().includes(key)) return val;
  }
  return EVENT_COLORS.api_request;
}

export default function TenantAudit() {
  const [cursor, setCursor]     = useState<string | undefined>(undefined);
  const [cursorStack, setStack] = useState<(string | undefined)[]>([]);
  const [search, setSearch]     = useState("");

  const queryKey = cursor
    ? [`/api/tenant/audit?cursor=${cursor}`]
    : ["/api/tenant/audit"];

  const { data, isLoading } = useQuery<AuditResponse>({ queryKey });

  const filtered = (data?.events ?? []).filter((e) =>
    !search || e.eventType.toLowerCase().includes(search.toLowerCase()) ||
    (e.userId ?? "").toLowerCase().includes(search.toLowerCase()),
  );

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
          <div>
            <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
              <ScrollText className="w-5 h-5 text-primary" /> Audit Log
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Immutable activity history — user actions, API events, security
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <Shield className="w-4 h-4 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Logs are immutable</span>
          </div>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Filter by event type or path…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
            data-testid="input-audit-search"
          />
        </div>

        {/* Event Table */}
        <Card className="bg-card border-card-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center justify-between">
              <span>Events</span>
              <span className="text-xs font-normal text-muted-foreground">
                Page {cursorStack.length + 1}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-10" />)}
              </div>
            ) : filtered.length > 0 ? (
              <div data-testid="audit-events-list">
                {filtered.map((event) => (
                  <div
                    key={event.id}
                    className="flex items-center gap-4 px-4 py-3 border-b border-border last:border-0 hover:bg-muted/20"
                    data-testid={`audit-event-${event.id}`}
                  >
                    <Badge
                      variant="outline"
                      className={`text-xs shrink-0 ${eventColor(event.eventType)}`}
                      data-testid={`audit-type-${event.id}`}
                    >
                      {event.eventType}
                    </Badge>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-muted-foreground font-mono truncate">
                        {event.userId ? `user: ${event.userId.slice(0, 12)}…` : "—"}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-xs text-muted-foreground">
                        {event.ipAddress ?? "—"}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {event.createdAt?.slice(0, 16).replace("T", " ")}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-8 text-center">
                <ScrollText className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground" data-testid="no-audit-events-msg">
                  {search ? "No events match your filter" : "No audit events recorded yet"}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Cursor Pagination */}
        <div className="flex items-center justify-between" data-testid="audit-pagination">
          <Button
            variant="outline" size="sm" onClick={prevPage} disabled={cursorStack.length === 0}
            className="gap-1.5" data-testid="button-audit-prev"
          >
            <ChevronLeft className="w-4 h-4" /> Previous
          </Button>
          <span className="text-xs text-muted-foreground" data-testid="audit-pagination-info">
            {filtered.length} events shown
          </span>
          <Button
            variant="outline" size="sm" onClick={nextPage} disabled={!data?.pagination.hasMore}
            className="gap-1.5" data-testid="button-audit-next"
          >
            Next <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
