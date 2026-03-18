import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface TrendPoint {
  bucket: string;
  [key: string]: string | number;
}

interface TrendSeries {
  key: string;
  label: string;
  color: string;
}

interface TrendChartProps {
  title: string;
  points: TrendPoint[];
  series: TrendSeries[];
  loading?: boolean;
  emptyText?: string;
  testId?: string;
  height?: number;
}

function sparkPath(values: number[], width: number, height: number): string {
  if (values.length < 2) return "";
  const max = Math.max(...values, 1);
  const step = width / (values.length - 1);
  return values
    .map((v, i) => {
      const x = i * step;
      const y = height - (v / max) * height;
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

export function TrendChart({
  title, points, series, loading, emptyText = "No trend data", testId, height = 80,
}: TrendChartProps) {
  const W = 320;
  const H = height;

  return (
    <Card data-testid={testId}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="w-full" style={{ height: H }} />
        ) : points.length === 0 ? (
          <div
            className="flex items-center justify-center text-sm text-muted-foreground"
            style={{ height: H }}
            data-testid={`${testId}-empty`}
          >
            {emptyText}
          </div>
        ) : (
          <div className="space-y-3">
            <svg
              viewBox={`0 0 ${W} ${H}`}
              width="100%"
              height={H}
              className="overflow-visible"
              data-testid={`${testId}-svg`}
            >
              {series.map(s => {
                const values = points.map(p => Number(p[s.key] ?? 0));
                const d = sparkPath(values, W, H);
                return d ? (
                  <path
                    key={s.key}
                    d={d}
                    fill="none"
                    stroke={s.color}
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ) : null;
              })}
            </svg>
            <div className="flex flex-wrap gap-3">
              {series.map(s => (
                <div key={s.key} className="flex items-center gap-1.5">
                  <div className="w-3 h-3 rounded-full" style={{ background: s.color }} />
                  <span className="text-xs text-muted-foreground">{s.label}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
