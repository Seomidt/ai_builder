import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfigCheckRow } from "./ConfigCheckRow";

interface EnvStatusTableProps {
  presentRequired:  string[];
  missingRequired:  string[];
  presentOptional:  string[];
  optionalWarnings: string[];
  loading?: boolean;
  testId?: string;
}

export function EnvStatusTable({
  presentRequired, missingRequired, presentOptional, optionalWarnings, loading, testId,
}: EnvStatusTableProps) {
  return (
    <Card data-testid={testId}>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold">Environment Variables</CardTitle>
      </CardHeader>
      <CardContent className="p-0 px-4 pb-4 space-y-1">
        {loading ? (
          Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)
        ) : (
          <>
            <p className="text-xs font-medium text-muted-foreground py-1 border-b border-border mb-1">
              Required ({presentRequired.length + missingRequired.length})
            </p>
            {presentRequired.map(v => (
              <ConfigCheckRow key={v} label={v} status="ok" testId={`env-req-${v}`} />
            ))}
            {missingRequired.map(v => (
              <ConfigCheckRow key={v} label={v} status="error" detail="MISSING — startup blocked" testId={`env-req-${v}`} />
            ))}
            {(presentOptional.length + optionalWarnings.length) > 0 && (
              <p className="text-xs font-medium text-muted-foreground py-1 border-b border-border mt-3 mb-1">
                Optional ({presentOptional.length + optionalWarnings.length})
              </p>
            )}
            {presentOptional.map(v => (
              <ConfigCheckRow key={v} label={v} status="ok" testId={`env-opt-${v}`} />
            ))}
            {optionalWarnings.map(v => (
              <ConfigCheckRow key={v} label={v} status="warning" detail="Not configured" testId={`env-opt-${v}`} />
            ))}
          </>
        )}
      </CardContent>
    </Card>
  );
}
