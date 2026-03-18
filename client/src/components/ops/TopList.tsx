import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export interface TopListItem {
  id: string;
  label: string;
  value: string | number;
  subvalue?: string;
  badge?: string | React.ReactNode;
}

interface TopListProps {
  title: string;
  items: TopListItem[];
  loading?: boolean;
  emptyText?: string;
  testId?: string;
  maxItems?: number;
}

export function TopList({ title, items, loading, emptyText = "No data", testId, maxItems = 10 }: TopListProps) {
  const visible = items.slice(0, maxItems);

  return (
    <Card data-testid={testId}>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))
        ) : visible.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2" data-testid={`${testId}-empty`}>{emptyText}</p>
        ) : (
          visible.map((item, idx) => (
            <div
              key={item.id}
              className="flex items-center justify-between py-1 border-b border-border last:border-0"
              data-testid={`${testId}-item-${idx}`}
            >
              <div className="flex flex-col min-w-0">
                <span className="text-sm font-medium truncate" title={item.label}>{item.label}</span>
                {item.subvalue && (
                  <span className="text-xs text-muted-foreground">{item.subvalue}</span>
                )}
              </div>
              <div className="flex items-center gap-2 ml-2 shrink-0">
                {item.badge}
                <span className="text-sm font-semibold tabular-nums">{item.value}</span>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
