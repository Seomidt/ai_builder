import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { OpsNav } from "@/components/ops/OpsNav";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useState, useRef } from "react";
import {
  Upload, Trash2, Download, RefreshCw,
  FolderOpen, CheckCircle2, XCircle, HardDrive,
} from "lucide-react";

interface R2Object {
  key:          string;
  size:         number;
  lastModified: string;
  etag?:        string;
}

function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export default function OpsStorage() {
  const { toast }     = useToast();
  const [prefix, setPrefix] = useState("");
  const [search, setSearch] = useState("");
  const fileRef             = useRef<HTMLInputElement>(null);

  const health = useQuery<{ ok: boolean; bucket: string; error?: string }>({
    queryKey: ["/api/r2/health"],
    retry: false,
  });

  const objects = useQuery<{ objects: R2Object[]; count: number }>({
    queryKey: ["/api/r2/list", prefix],
    queryFn: async () => {
      const qs = prefix ? `?prefix=${encodeURIComponent(prefix)}&maxKeys=200` : "?maxKeys=200";
      const r = await fetch(`/api/r2/list${qs}`);
      return r.json();
    },
    enabled: health.data?.ok === true,
  });

  const deleteMutation = useMutation({
    mutationFn: (key: string) =>
      apiRequest("DELETE", `/api/r2/object?key=${encodeURIComponent(key)}`).then(r => r.json()),
    onSuccess: (_, key) => {
      queryClient.invalidateQueries({ queryKey: ["/api/r2/list"] });
      toast({ title: "Deleted", description: key });
    },
    onError: () => toast({ title: "Delete failed", variant: "destructive" }),
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const reader = new FileReader();
      const base64 = await new Promise<string>((res, rej) => {
        reader.onload  = () => res((reader.result as string).split(",")[1]);
        reader.onerror = rej;
        reader.readAsDataURL(file);
      });
      const key = prefix ? `${prefix.replace(/\/$/, "")}/${file.name}` : file.name;
      const r = await apiRequest("POST", "/api/r2/upload", {
        key,
        data:        base64,
        contentType: file.type || "application/octet-stream",
      });
      return r.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/r2/list"] });
      toast({ title: "Uploaded", description: data.key });
    },
    onError: () => toast({ title: "Upload failed", variant: "destructive" }),
  });

  const presignMutation = useMutation({
    mutationFn: (key: string) =>
      fetch(`/api/r2/url?key=${encodeURIComponent(key)}&expiresIn=3600`).then(r => r.json()),
    onSuccess: (data) => {
      window.open(data.url, "_blank");
    },
    onError: () => toast({ title: "Could not generate URL", variant: "destructive" }),
  });

  const filteredObjects = (objects.data?.objects ?? []).filter(o =>
    search ? o.key.toLowerCase().includes(search.toLowerCase()) : true,
  );

  return (
    <div className="min-h-screen bg-background" data-testid="ops-storage-page">
      <OpsNav />
      <div className="px-6 py-6 space-y-6 max-w-[1400px] mx-auto">

        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-xl font-semibold">R2 Object Storage</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Cloudflare R2 bucket — {health.data?.bucket ?? "…"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {health.isLoading ? (
              <Skeleton className="h-7 w-28" />
            ) : health.data?.ok ? (
              <Badge variant="outline" className="gap-1 text-green-400 border-green-800" data-testid="status-connected">
                <CheckCircle2 className="w-3 h-3" /> Connected
              </Badge>
            ) : (
              <Badge variant="destructive" className="gap-1" data-testid="status-error">
                <XCircle className="w-3 h-3" /> {health.data?.error ?? "Unavailable"}
              </Badge>
            )}
            <Button
              variant="outline" size="sm"
              onClick={() => {
                health.refetch();
                objects.refetch();
              }}
              data-testid="btn-refresh-storage"
            >
              <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${objects.isFetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>

        {/* Controls */}
        <div className="flex flex-wrap gap-3 items-center">
          <div className="flex items-center gap-2 flex-1 min-w-48">
            <FolderOpen className="w-4 h-4 text-muted-foreground shrink-0" />
            <Input
              placeholder="Prefix / folder (valgfri)"
              value={prefix}
              onChange={e => setPrefix(e.target.value)}
              className="h-8 text-sm"
              data-testid="input-prefix"
            />
          </div>
          <Input
            placeholder="Søg i nøgler…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="h-8 text-sm flex-1 min-w-48"
            data-testid="input-search"
          />
          <Button
            size="sm"
            onClick={() => fileRef.current?.click()}
            disabled={uploadMutation.isPending || !health.data?.ok}
            data-testid="btn-upload"
          >
            <Upload className="w-3.5 h-3.5 mr-1.5" />
            {uploadMutation.isPending ? "Uploader…" : "Upload fil"}
          </Button>
          <input
            type="file"
            ref={fileRef}
            className="hidden"
            onChange={e => {
              const f = e.target.files?.[0];
              if (f) uploadMutation.mutate(f);
              e.target.value = "";
            }}
            data-testid="input-file"
          />
        </div>

        {/* Summary */}
        {objects.data && (
          <div className="flex gap-6 text-sm text-muted-foreground" data-testid="storage-summary">
            <span data-testid="summary-count">
              <strong className="text-foreground">{filteredObjects.length}</strong> objekter
            </span>
            <span data-testid="summary-total-size">
              <strong className="text-foreground">
                {formatBytes(filteredObjects.reduce((s, o) => s + o.size, 0))}
              </strong>{" "}
              samlet
            </span>
          </div>
        )}

        {/* Objects table */}
        <Card data-testid="objects-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <HardDrive className="w-4 h-4" /> Objekter
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0 pb-2">
            {objects.isLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-2.5 border-b border-border last:border-0">
                  <Skeleton className="h-4 flex-1" />
                  <Skeleton className="h-4 w-16" />
                  <Skeleton className="h-6 w-16" />
                </div>
              ))
            ) : !health.data?.ok ? (
              <p className="px-4 py-6 text-sm text-muted-foreground text-center" data-testid="r2-unavailable-msg">
                R2 er ikke tilgængeligt. Tjek dine credentials.
              </p>
            ) : filteredObjects.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground text-center" data-testid="empty-bucket-msg">
                {search ? "Ingen objekter matcher søgningen." : "Bucket er tomt."}
              </p>
            ) : (
              filteredObjects.map((obj, i) => (
                <div
                  key={obj.key}
                  className="flex items-center gap-3 px-4 py-2.5 border-b border-border last:border-0 hover:bg-muted/30 transition-colors group"
                  data-testid={`object-row-${i}`}
                >
                  <div className="flex-1 min-w-0">
                    <p
                      className="text-sm font-mono truncate cursor-pointer hover:underline"
                      title={obj.key}
                      onClick={() => presignMutation.mutate(obj.key)}
                      data-testid={`object-key-${i}`}
                    >
                      {obj.key}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(obj.lastModified).toLocaleString("da-DK")}
                    </p>
                  </div>
                  <span className="text-xs text-muted-foreground w-16 text-right shrink-0" data-testid={`object-size-${i}`}>
                    {formatBytes(obj.size)}
                  </span>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button
                      variant="ghost" size="sm"
                      onClick={() => presignMutation.mutate(obj.key)}
                      title="Åbn / download"
                      data-testid={`btn-download-${i}`}
                    >
                      <Download className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      variant="ghost" size="sm"
                      onClick={() => {
                        if (confirm(`Slet ${obj.key}?`)) deleteMutation.mutate(obj.key);
                      }}
                      title="Slet"
                      data-testid={`btn-delete-${i}`}
                    >
                      <Trash2 className="w-3.5 h-3.5 text-red-400" />
                    </Button>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
