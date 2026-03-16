import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfigCheckRow } from "./ConfigCheckRow";

interface SchemaStatusTableProps {
  presentTables:   string[];
  missingTables:   string[];
  missingColumns:  string[];
  presentIndexes:  string[];
  missingIndexes:  string[];
  loading?: boolean;
  testId?: string;
}

export function SchemaStatusTable({
  presentTables, missingTables, missingColumns, presentIndexes, missingIndexes, loading, testId,
}: SchemaStatusTableProps) {
  return (
    <Card data-testid={testId}>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold">Database Schema</CardTitle>
      </CardHeader>
      <CardContent className="p-0 px-4 pb-4 space-y-1">
        {loading ? (
          Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)
        ) : (
          <>
            <p className="text-xs font-medium text-muted-foreground py-1 border-b border-border mb-1">
              Tables ({presentTables.length + missingTables.length} required)
            </p>
            {presentTables.map(t => (
              <ConfigCheckRow key={t} label={t} status="ok" testId={`schema-table-${t}`} />
            ))}
            {missingTables.map(t => (
              <ConfigCheckRow key={t} label={t} status="error" detail="TABLE MISSING" testId={`schema-table-${t}`} />
            ))}

            {missingColumns.length > 0 && (
              <>
                <p className="text-xs font-medium text-muted-foreground py-1 border-b border-border mt-3 mb-1">
                  Missing Columns ({missingColumns.length})
                </p>
                {missingColumns.map(c => (
                  <ConfigCheckRow key={c} label={c} status="error" detail="COLUMN MISSING" testId={`schema-col-${c.replace(".", "-")}`} />
                ))}
              </>
            )}

            {(presentIndexes.length + missingIndexes.length) > 0 && (
              <>
                <p className="text-xs font-medium text-muted-foreground py-1 border-b border-border mt-3 mb-1">
                  Performance Indexes ({presentIndexes.length + missingIndexes.length} required)
                </p>
                {presentIndexes.map(i => (
                  <ConfigCheckRow key={i} label={i} status="ok" testId={`schema-idx-${i}`} />
                ))}
                {missingIndexes.map(i => (
                  <ConfigCheckRow key={i} label={i} status="warning" detail="Index missing — performance may degrade" testId={`schema-idx-${i}`} />
                ))}
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
