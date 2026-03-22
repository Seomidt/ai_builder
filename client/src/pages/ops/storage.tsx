import { QUERY_POLICY } from "@/lib/query-policy";
import { useQuery } from "@tanstack/react-query";
import { HardDrive, FileText, CheckCircle, AlertTriangle, Upload } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

interface StorageFile {
  id?: string;
  filename?: string;
  organizationId?: string;
  upload_status?: string;
  fileSize?: number;
  createdAt?: string;
}

interface StorageResponse {
  files?: StorageFile[];
  total?: number;
  storageUsedBytes?: number;
}

function statusColor(s?: string) {
  if (s === "ready" || s === "complete") return "bg-green-500/15 text-green-400 border-green-500/25";
  if (s === "processing") return "bg-secondary/15 text-secondary border-secondary/25";
  if (s === "failed" || s === "error") return "bg-destructive/15 text-destructive border-destructive/25";
  return "bg-muted text-muted-foreground border-border";
}

function formatBytes(bytes?: number) {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function OpsStorage() {
  const { data, isLoading } = useQuery<StorageResponse | StorageFile[]>({
    queryKey: ["/api/storage"],
    ...QUERY_POLICY.opsSnapshot,
  });

  const files: StorageFile[] = Array.isArray(data) ? data : (data?.files ?? []);
  const total = Array.isArray(data) ? data.length : (data?.total ?? files.length);
  const storageUsed = Array.isArray(data) ? null : data?.storageUsedBytes;

  const readyCount = files.filter((f) => f.upload_status === "ready" || f.upload_status === "complete").length;
  const failedCount = files.filter((f) => f.upload_status === "failed" || f.upload_status === "error").length;

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-6xl" data-testid="ops-storage-page">
      <div className="space-y-1">
        <div className="flex items-center gap-2.5">
          <div
            className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0"
            style={{ background: "rgba(34,211,238,0.12)", border: "1px solid rgba(34,211,238,0.20)" }}
          >
            <HardDrive className="w-4 h-4 text-primary" />
          </div>
          <h1 className="text-xl font-bold text-foreground tracking-tight" data-testid="text-ops-storage-title">Storage Management</h1>
        </div>
        <p className="text-sm text-muted-foreground ml-10">File metadata, upload status, and storage health</p>
      </div>

      {/* Summary chips */}
      <div className="flex flex-wrap gap-2" data-testid="storage-summary-chips">
        {isLoading ? (
          Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-7 w-24" />)
        ) : (
          <>
            <Badge variant="outline" className="text-xs gap-1" data-testid="storage-total-badge">
              <FileText className="w-3 h-3" /> {total} files
            </Badge>
            <Badge variant="outline" className="text-xs gap-1 bg-green-500/15 text-green-400 border-green-500/25" data-testid="storage-ready-badge">
              <CheckCircle className="w-3 h-3" /> {readyCount} ready
            </Badge>
            {failedCount > 0 && (
              <Badge variant="outline" className="text-xs gap-1 bg-destructive/15 text-destructive border-destructive/25" data-testid="storage-failed-badge">
                <AlertTriangle className="w-3 h-3" /> {failedCount} failed
              </Badge>
            )}
            {storageUsed != null && (
              <Badge variant="outline" className="text-xs" data-testid="storage-used-badge">
                <HardDrive className="w-3 h-3 mr-1" /> {formatBytes(storageUsed)} used
              </Badge>
            )}
          </>
        )}
      </div>

      {/* File Table */}
      <Card className="bg-card border-card-border" data-testid="ops-storage-files-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Upload className="w-4 h-4 text-primary" /> Recent Files
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
          ) : files.length ? (
            <div data-testid="storage-files-list">
              {files.slice(0, 20).map((f, i) => (
                <div key={f.id ?? i} className="flex items-center justify-between px-4 py-3 border-b border-border last:border-0" data-testid={`storage-file-row-${i}`}>
                  <div className="flex-1 min-w-0 pr-2">
                    <p className="text-xs font-medium text-foreground truncate">{f.filename ?? f.id ?? "Unknown file"}</p>
                    <p className="text-xs text-muted-foreground font-mono">{(f.organizationId ?? "—").slice(0, 12)}</p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {f.fileSize != null && <span className="text-xs text-muted-foreground">{formatBytes(f.fileSize)}</span>}
                    <Badge variant="outline" className={`text-xs ${statusColor(f.upload_status)}`} data-testid={`storage-file-status-${i}`}>
                      {f.upload_status ?? "unknown"}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-8 text-center" data-testid="no-storage-files-msg">
              <HardDrive className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-xs text-muted-foreground">No files stored yet</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
