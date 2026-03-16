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
  Upload, Trash2, Download, RefreshCw, FolderOpen,
  CheckCircle2, XCircle, HardDrive, Shield, AlertTriangle,
  Building2, Server, ChevronDown, Layers,
} from "lucide-react";

interface R2Object {
  key:          string;
  size:         number;
  lastModified: string;
}

interface BucketUsage {
  totalObjects: number;
  totalBytes:   number;
  tenantCount:  number;
  topPrefixes:  { prefix: string; objectCount: number; totalBytes: number }[];
  computedAt:   string;
}

interface TenantUsage {
  tenantId:    string;
  objectCount: number;
  totalBytes:  number;
  byCategory:  { prefix: string; objectCount: number; totalBytes: number }[];
}

interface DeleteDecision {
  allowed:       boolean;
  riskLevel:     "low" | "medium" | "high" | "critical";
  reason:        string;
  requiresAdmin: boolean;
  key:           string;
}

function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B";
  const k = 1024, sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function riskColor(level: string) {
  if (level === "critical") return "text-red-400";
  if (level === "high")     return "text-orange-400";
  if (level === "medium")   return "text-yellow-400";
  return "text-green-400";
}

function keyBadge(key: string) {
  if (key.startsWith("tenants/"))  return { label: "tenant", color: "bg-blue-950 text-blue-300 border-blue-800" };
  if (key.startsWith("platform/")) return { label: "platform", color: "bg-purple-950 text-purple-300 border-purple-800" };
  return { label: "unscoped", color: "bg-yellow-950 text-yellow-300 border-yellow-800" };
}

type UploadMode = "simple" | "signed" | "multipart";
type ViewFilter = "tenant" | "platform" | "all";

export default function OpsStorage() {
  const { toast }        = useToast();
  const [prefix, setPrefix]         = useState("");
  const [search, setSearch]         = useState("");
  const [viewFilter, setViewFilter] = useState<ViewFilter>("tenant");
  const [uploadMode, setUploadMode] = useState<UploadMode>("simple");
  const [deleteTarget, setDeleteTarget] = useState<R2Object | null>(null);
  const [deleteDecision, setDeleteDecision] = useState<DeleteDecision | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const health = useQuery<{ ok: boolean; bucket: string; error?: string }>({
    queryKey: ["/api/r2/health"],
    retry: false,
  });

  const effectivePrefix = (() => {
    if (viewFilter === "platform") return "platform/";
    if (viewFilter === "all")      return "";
    return prefix || "";   // tenant — server enforces scope
  })();

  const objects = useQuery<{ objects: R2Object[]; count: number; prefix: string }>({
    queryKey: ["/api/r2/list", effectivePrefix],
    queryFn: async () => {
      const qs = new URLSearchParams({ maxKeys: "200" });
      if (effectivePrefix) qs.set("prefix", effectivePrefix);
      const r = await fetch(`/api/r2/list?${qs}`);
      return r.json();
    },
    enabled: health.data?.ok === true,
  });

  const tenantUsage = useQuery<TenantUsage>({
    queryKey: ["/api/r2/tenant-usage"],
    enabled: health.data?.ok === true,
  });

  // Presign & open in new tab
  const presignMutation = useMutation({
    mutationFn: (key: string) =>
      fetch(`/api/r2/url?key=${encodeURIComponent(key)}&expiresIn=3600`).then(r => r.json()),
    onSuccess: (data) => {
      if (data.url) window.open(data.url, "_blank");
      else toast({ title: "No URL returned", variant: "destructive" });
    },
    onError: () => toast({ title: "Could not generate URL", variant: "destructive" }),
  });

  // Check delete policy
  const checkDeleteMutation = useMutation({
    mutationFn: (key: string) =>
      fetch(`/api/r2/delete-policy?key=${encodeURIComponent(key)}`).then(r => r.json()),
    onSuccess: (decision: DeleteDecision, key: string) => {
      const obj = objects.data?.objects.find(o => o.key === key) ?? { key, size: 0, lastModified: "" };
      setDeleteTarget(obj);
      setDeleteDecision(decision);
    },
  });

  // Execute delete
  const deleteMutation = useMutation({
    mutationFn: (key: string) =>
      apiRequest("DELETE", `/api/r2/object?key=${encodeURIComponent(key)}`).then(r => r.json()),
    onSuccess: (data, key) => {
      queryClient.invalidateQueries({ queryKey: ["/api/r2/list"] });
      queryClient.invalidateQueries({ queryKey: ["/api/r2/tenant-usage"] });
      toast({ title: "Deleted", description: key });
      setDeleteTarget(null);
      setDeleteDecision(null);
    },
    onError: (err: any) => toast({ title: "Delete failed", description: err?.message, variant: "destructive" }),
  });

  // Simple upload
  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      if (uploadMode === "signed") {
        // Get presigned URL, then PUT directly
        const urlResp = await apiRequest("POST", "/api/r2/upload-url", {
          filename:    file.name,
          contentType: file.type || "application/octet-stream",
        }).then(r => r.json());
        if (urlResp.error) throw new Error(urlResp.error);

        await fetch(urlResp.url, {
          method:  "PUT",
          body:    file,
          headers: { "Content-Type": file.type || "application/octet-stream" },
        });
        return { key: urlResp.key };
      }

      // Default: base64 via backend
      const base64 = await new Promise<string>((res, rej) => {
        const reader = new FileReader();
        reader.onload  = () => res((reader.result as string).split(",")[1]);
        reader.onerror = rej;
        reader.readAsDataURL(file);
      });
      return apiRequest("POST", "/api/r2/upload", {
        filename:    file.name,
        data:        base64,
        contentType: file.type || "application/octet-stream",
      }).then(r => r.json());
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/r2/list"] });
      queryClient.invalidateQueries({ queryKey: ["/api/r2/tenant-usage"] });
      toast({ title: "Uploaded", description: data.key });
    },
    onError: (err: any) => toast({ title: "Upload failed", description: err?.message ?? "Unknown error", variant: "destructive" }),
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
              Bucket: <span className="font-mono">{health.data?.bucket ?? "…"}</span>
              {" · "}Tenant-scoped paths enforced
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
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
              onClick={() => { health.refetch(); objects.refetch(); tenantUsage.refetch(); }}
              data-testid="btn-refresh-storage"
            >
              <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${objects.isFetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>

        {/* Usage summary cards */}
        {tenantUsage.data && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4" data-testid="usage-summary-cards">
            <Card className="p-4" data-testid="card-object-count">
              <p className="text-xs text-muted-foreground">Mine objekter</p>
              <p className="text-2xl font-bold mt-1">{tenantUsage.data.objectCount}</p>
            </Card>
            <Card className="p-4" data-testid="card-total-bytes">
              <p className="text-xs text-muted-foreground">Samlet størrelse</p>
              <p className="text-2xl font-bold mt-1">{formatBytes(tenantUsage.data.totalBytes)}</p>
            </Card>
            <Card className="p-4 col-span-2 sm:col-span-1" data-testid="card-categories">
              <p className="text-xs text-muted-foreground">Kategorier</p>
              <p className="text-2xl font-bold mt-1">{tenantUsage.data.byCategory.length}</p>
            </Card>
          </div>
        )}

        {/* Category breakdown */}
        {(tenantUsage.data?.byCategory ?? []).length > 0 && (
          <Card data-testid="category-breakdown-card">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Layers className="w-4 h-4" /> Fordeling pr. kategori
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-3 py-2">
              {tenantUsage.data!.byCategory.map((cat, i) => (
                <div key={i} className="flex flex-col border border-border rounded px-3 py-2 min-w-32" data-testid={`category-card-${i}`}>
                  <p className="text-xs text-muted-foreground font-mono">{cat.prefix.split("/").at(-2)}</p>
                  <p className="text-sm font-semibold">{cat.objectCount} filer</p>
                  <p className="text-xs text-muted-foreground">{formatBytes(cat.totalBytes)}</p>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Controls */}
        <div className="flex flex-wrap gap-3 items-center">
          {/* View filter */}
          <div className="flex items-center gap-1 border border-border rounded-md overflow-hidden text-xs">
            {(["tenant", "platform", "all"] as ViewFilter[]).map(f => (
              <button
                key={f}
                onClick={() => setViewFilter(f)}
                className={`px-3 py-1.5 capitalize transition-colors ${viewFilter === f ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground"}`}
                data-testid={`filter-${f}`}
              >
                {f === "tenant" ? <><Building2 className="w-3 h-3 inline mr-1" />Min tenant</> :
                 f === "platform" ? <><Server className="w-3 h-3 inline mr-1" />Platform</> :
                 <><Layers className="w-3 h-3 inline mr-1" />Alle</>}
              </button>
            ))}
          </div>

          {viewFilter === "tenant" && (
            <div className="flex items-center gap-2 flex-1 min-w-40">
              <FolderOpen className="w-4 h-4 text-muted-foreground shrink-0" />
              <Input
                placeholder="Prefix / mappe"
                value={prefix}
                onChange={e => setPrefix(e.target.value)}
                className="h-8 text-sm"
                data-testid="input-prefix"
              />
            </div>
          )}

          <Input
            placeholder="Søg i nøgler…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="h-8 text-sm flex-1 min-w-40"
            data-testid="input-search"
          />

          {/* Upload mode */}
          <div className="flex items-center gap-1 border border-border rounded-md overflow-hidden text-xs">
            {(["simple", "signed", "multipart"] as UploadMode[]).map(m => (
              <button
                key={m}
                onClick={() => setUploadMode(m)}
                className={`px-2 py-1.5 capitalize transition-colors ${uploadMode === m ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground"}`}
                data-testid={`upload-mode-${m}`}
              >
                {m}
              </button>
            ))}
          </div>

          <Button
            size="sm"
            onClick={() => fileRef.current?.click()}
            disabled={uploadMutation.isPending || !health.data?.ok || uploadMode === "multipart"}
            title={uploadMode === "multipart" ? "Multipart bruges via API direkte" : ""}
            data-testid="btn-upload"
          >
            <Upload className="w-3.5 h-3.5 mr-1.5" />
            {uploadMutation.isPending ? "Uploader…" : `Upload (${uploadMode})`}
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

        {/* Active prefix info */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="active-prefix-info">
          <FolderOpen className="w-3.5 h-3.5" />
          <span>Viser: <span className="font-mono text-foreground">{objects.data?.prefix || "(alle)"}</span></span>
          {objects.data && (
            <span className="ml-2">
              <strong className="text-foreground">{filteredObjects.length}</strong> objekter ·
              <strong className="text-foreground ml-1">{formatBytes(filteredObjects.reduce((s, o) => s + o.size, 0))}</strong>
            </span>
          )}
        </div>

        {/* Objects table */}
        <Card data-testid="objects-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <HardDrive className="w-4 h-4" /> Objekter
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0 pb-2">
            {objects.isLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-2.5 border-b border-border last:border-0">
                  <Skeleton className="h-4 flex-1" /><Skeleton className="h-4 w-16" />
                </div>
              ))
            ) : !health.data?.ok ? (
              <p className="px-4 py-6 text-sm text-muted-foreground text-center" data-testid="r2-unavailable-msg">
                R2 er ikke tilgængeligt.
              </p>
            ) : filteredObjects.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground text-center" data-testid="empty-bucket-msg">
                {search ? "Ingen objekter matcher søgningen." : "Ingen objekter under dette prefix."}
              </p>
            ) : (
              filteredObjects.map((obj, i) => {
                const badge = keyBadge(obj.key);
                return (
                  <div
                    key={obj.key}
                    className="flex items-center gap-3 px-4 py-2.5 border-b border-border last:border-0 hover:bg-muted/30 transition-colors group"
                    data-testid={`object-row-${i}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-xs px-1.5 py-0.5 rounded border font-mono shrink-0 ${badge.color}`}
                          data-testid={`object-scope-badge-${i}`}
                        >
                          {badge.label}
                        </span>
                        <p
                          className="text-sm font-mono truncate cursor-pointer hover:underline"
                          title={obj.key}
                          onClick={() => presignMutation.mutate(obj.key)}
                          data-testid={`object-key-${i}`}
                        >
                          {obj.key}
                        </p>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
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
                        title="Åbn"
                        data-testid={`btn-download-${i}`}
                      >
                        <Download className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        variant="ghost" size="sm"
                        onClick={() => checkDeleteMutation.mutate(obj.key)}
                        title="Slet"
                        data-testid={`btn-delete-${i}`}
                      >
                        <Trash2 className="w-3.5 h-3.5 text-red-400" />
                      </Button>
                    </div>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>

        {/* Delete confirmation modal */}
        {deleteTarget && deleteDecision && (
          <div
            className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4"
            data-testid="delete-confirm-modal"
          >
            <Card className="w-full max-w-md">
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  {deleteDecision.riskLevel === "critical" || deleteDecision.riskLevel === "high"
                    ? <AlertTriangle className="w-4 h-4 text-orange-400" />
                    : <Shield className="w-4 h-4" />}
                  Bekræft sletning
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs font-mono bg-muted px-3 py-2 rounded break-all" data-testid="delete-confirm-key">
                  {deleteTarget.key}
                </p>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Risikoniveau:</span>
                  <span className={`text-xs font-semibold ${riskColor(deleteDecision.riskLevel)}`} data-testid="delete-risk-level">
                    {deleteDecision.riskLevel.toUpperCase()}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground" data-testid="delete-policy-reason">
                  {deleteDecision.reason}
                </p>
                {!deleteDecision.allowed && (
                  <p className="text-xs text-destructive font-medium">
                    Du har ikke tilladelse til at slette dette objekt.
                  </p>
                )}
                <div className="flex gap-2 pt-2">
                  <Button
                    variant="outline" size="sm"
                    onClick={() => { setDeleteTarget(null); setDeleteDecision(null); }}
                    data-testid="btn-cancel-delete"
                  >
                    Annuller
                  </Button>
                  <Button
                    variant="destructive" size="sm"
                    disabled={!deleteDecision.allowed || deleteMutation.isPending}
                    onClick={() => deleteMutation.mutate(deleteTarget.key)}
                    data-testid="btn-confirm-delete"
                  >
                    {deleteMutation.isPending ? "Sletter…" : "Slet"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
