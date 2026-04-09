import { useState, useRef, useEffect, useCallback } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Send, Bot, User, ChevronDown, ChevronUp, ShieldAlert, BookOpen,
  AlertTriangle, CheckCircle2, HelpCircle, Paperclip, X,
  FileText, Image, Video, Sparkles, Zap, RefreshCw, Clock, WifiOff,
  TrendingUp, Hourglass, Save, Database, ChevronRight,
} from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";
import { getSessionToken } from "@/lib/supabase";
import { fastExtractText, classifyForFastExtract, renderPdfPagesToImages } from "@/lib/document-extractor";
import { pollForCompletedOcr } from "@shared/upgrade-chain";
import { useToast } from "@/hooks/use-toast";
import { useReadinessStream, type ReadinessSnapshot, type ReadinessUxState } from "@/hooks/use-readiness-stream";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChatSource { id: string; name: string; sourceType?: string }
interface ChatRule   { id: string; title: string }
type ConfidenceBand  = "high" | "medium" | "low" | "unknown";

type RouteType = "attachment_first" | "hybrid" | "expert_auto" | "processing" | "not_ready" | "no_context";

interface ChatResponse {
  answer: string;
  document_validation?: string | null;
  conversation_id: string;
  route_type?: RouteType;
  expert: { id: string; name: string; category: string | null };
  source?: { type: "expert" | "system"; name?: string };
  used_sources: ChatSource[];
  used_rules: ChatRule[];
  warnings: string[];
  latency_ms: number;
  confidence_band: ConfidenceBand;
  needs_manual_review: boolean;
  routing_explanation: string;
  // Phase 5Z.3 — progressive answer metadata (camelCase from enrichment spread)
  answerCompleteness?:    "none" | "partial" | "complete";
  sourceCoveragePercent?: number;
  partialWarning?:        string | null;
  hasFailedSegments?:     boolean;
  fullCompletionBlocked?: boolean;
  isPartial?:             boolean;
  canRefreshForBetterAnswer?: boolean;
  triggerKeyUsed?:        string | null;
  answerGeneration?:      number;
  // Phase 5Z.5 — refinement metadata (snake_case from API, mirrors above)
  answer_completeness?:    "partial" | "complete";
  refinement_generation?:  number;
  supersedes_generation?:  number | null;
  source_coverage_percent?: number;
  partial_warning?:        string | null;
  _answer_cache_hit?:      boolean;
}

interface AttachedFile {
  id: string;
  file: File;
  type: "document" | "image" | "video";
  status: "ready" | "uploading" | "processing" | "done" | "failed";
  previewUrl?: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  attachments?: AttachedFile[];
  response?: ChatResponse;
  timestamp: Date;
  isError?: boolean;
  isStreaming?: boolean;
  /** Phase 5Z.5 — true when a newer refined/final answer has superseded this one. */
  isSuperseded?: boolean;
  /** OCR partial mode marker (used for upgrade flow metadata). */
  isProcessingPlaceholder?: boolean;
  /** Phase 2+3 — tracked chat assets for "Gem til vidensbase" */
  assetRefs?: AssetRef[];
}

/** Phase 2+3 — reference to a knowledge_document created for a chat upload. */
interface AssetRef {
  assetId: string;
  filename: string;
  scope: "temporary_chat" | "persistent_storage";
  /** Phase 5: true = existing asset row reused — no new row created */
  isDeduped?: boolean;
  /** Phase 5: true = R2 upload can be skipped (asset already has r2Key) */
  skipUpload?: boolean;
  /** Phase 5: existing r2Key if asset already uploaded — used to skip R2 in SLOW path */
  existingR2Key?: string | null;
}

/** Phase 5: return value from createChatAssetForFile including dedup flags */
interface AssetCreateResult {
  assetId: string;
  isDeduped: boolean;
  skipUpload: boolean;
  ocrReady: boolean;
  /** Phase 5: r2Key from the existing asset row, if already uploaded */
  existingR2Key: string | null;
}

// ─── File helpers ─────────────────────────────────────────────────────────────

const MAX_SIZE_MB = 25;
const ACCEPT_DOCS  = ".pdf,.doc,.docx,.txt,.csv,.xlsx,.xls";
const ACCEPT_IMG   = "image/jpeg,image/png,image/gif,image/webp";
const ACCEPT_VIDEO = "video/mp4,video/quicktime,video/x-msvideo";
const ACCEPT_ALL   = `${ACCEPT_DOCS},${ACCEPT_IMG},${ACCEPT_VIDEO}`;

function fileType(f: File): AttachedFile["type"] {
  if (f.type.startsWith("image/")) return "image";
  if (f.type.startsWith("video/")) return "video";
  return "document";
}

function fileIcon(type: AttachedFile["type"]) {
  if (type === "image") return <Image className="w-3.5 h-3.5 text-blue-400" />;
  if (type === "video") return <Video className="w-3.5 h-3.5 text-purple-400" />;
  return <FileText className="w-3.5 h-3.5 text-primary" />;
}

// ─── Phase 2+3 helpers ────────────────────────────────────────────────────────

/** SHA-256 file hash using WebCrypto — used for Phase 5 deduplication. */
async function computeFileHash(file: File): Promise<string> {
  try {
    const buf = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(digest))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return "";
  }
}

/**
 * Phase 5: Creates or reuses a temporary_chat knowledge_document for a single file.
 *
 * Flow:
 *  1. Compute SHA-256 hash
 *  2. GET /api/knowledge/assets/by-hash?fileHash=... (HASH_HIT / HASH_MISS)
 *  3a. HASH_HIT  → reuse existing assetId; skip R2 upload if asset already uploaded
 *  3b. HASH_MISS → POST /api/knowledge/assets to create new row
 *
 * Returns AssetCreateResult on success, or null on failure (non-blocking).
 * INV: Tenant isolation enforced server-side — by-hash scoped to orgId.
 */
async function createChatAssetForFile(
  file: File,
  afType: AttachedFile["type"],
  chatSessionId: string,
): Promise<AssetCreateResult | null> {
  try {
    const fileHash = await computeFileHash(file);

    // ── Phase 5: deduplication check ──────────────────────────────────────────
    if (fileHash) {
      const hashRes = await apiRequest("GET", `/api/knowledge/assets/by-hash?fileHash=${encodeURIComponent(fileHash)}`);
      if (hashRes.ok) {
        const { asset } = await hashRes.json() as {
          asset: { id: string; documentStatus: string; r2Key: string | null }
        };
        if (asset?.id) {
          const ocrReady       = asset.documentStatus === "ready";
          const existingR2Key  = asset.r2Key ?? null;
          const skipUpload     = existingR2Key !== null; // already has r2Key in R2
          console.log(
            `[ASSETS][DEDUP] HASH_HIT file="${file.name}" hash=${fileHash.slice(0,16)}…` +
            ` assetId=${asset.id} status=${asset.documentStatus}` +
            (skipUpload ? " SKIP_R2_UPLOAD" : "") +
            (ocrReady   ? " OCR_REUSED EMBEDDINGS_REUSED" : ""),
          );
          return { assetId: asset.id, isDeduped: true, skipUpload, ocrReady, existingR2Key };
        }
      }
      // 404 or error → fall through to create
    }

    console.log(`[ASSETS][DEDUP] HASH_MISS file="${file.name}" hash=${fileHash ? fileHash.slice(0,16)+"…" : "(no-hash)"} → creating new asset`);

    // ── HASH_MISS: create new row ─────────────────────────────────────────────
    const res = await apiRequest("POST", "/api/knowledge/assets", {
      title:         file.name,
      fileHash:      fileHash || undefined,
      mimeType:      file.type || "application/octet-stream",
      sizeBytes:     file.size,
      chatThreadId:  chatSessionId,
      retentionMode: "session",
      documentType:  afType,
    });
    if (!res.ok) return null;
    const data = await res.json() as { asset: { id: string } };
    const assetId = data.asset?.id;
    if (!assetId) return null;
    return { assetId, isDeduped: false, skipUpload: false, ocrReady: false, existingR2Key: null };
  } catch {
    return null;
  }
}

/**
 * Patches an asset with the R2 key after a successful upload.
 * Fire-and-forget — never throws.
 */
async function patchAssetR2KeyFF(
  assetId: string,
  r2Key: string,
  file: File,
): Promise<void> {
  try {
    await apiRequest("PATCH", `/api/knowledge/assets/${assetId}`, {
      r2Key,
      mimeType:   file.type || "application/octet-stream",
      sizeBytes:  file.size,
      documentStatus: "processing",
    });
  } catch {
    // Non-critical — asset still exists, just without r2Key
  }
}

async function resizeImageToBase64(
  file: File,
  maxWidth = 1200,
  quality = 0.7,
): Promise<string | null> {
  try {
    const url = URL.createObjectURL(file);
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = document.createElement("img");
      el.onload  = () => resolve(el);
      el.onerror = reject;
      el.src     = url;
    });
    URL.revokeObjectURL(url);

    const scale  = Math.min(1, maxWidth / img.naturalWidth);
    const canvas = document.createElement("canvas");
    canvas.width  = Math.floor(img.naturalWidth  * scale);
    canvas.height = Math.floor(img.naturalHeight * scale);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    const base64  = dataUrl.split(",")[1] ?? null;

    canvas.width = 0;
    canvas.height = 0;
    return base64;
  } catch (e: any) {
    console.warn(`[IMG] resizeImageToBase64 failed for "${file.name}": ${e?.message}`);
    return null;
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Confidence Badge ─────────────────────────────────────────────────────────

function ConfidenceBadge({ band }: { band: ConfidenceBand }) {
  const map: Record<ConfidenceBand, { label: string; color: string; icon: typeof CheckCircle2 }> = {
    high:    { label: "Høj sikkerhed",    color: "text-green-400 border-green-400/30 bg-green-400/10",   icon: CheckCircle2  },
    medium:  { label: "Middel sikkerhed", color: "text-yellow-400 border-yellow-400/30 bg-yellow-400/10", icon: HelpCircle   },
    low:     { label: "Lav sikkerhed",    color: "text-red-400 border-red-400/30 bg-red-400/10",          icon: AlertTriangle },
    unknown: { label: "Ukendt",           color: "text-muted-foreground border-border bg-muted/20",       icon: HelpCircle   },
  };
  const { label, color, icon: Icon } = map[band];
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium", color)}>
      <Icon className="w-3 h-3" />{label}
    </span>
  );
}

// ─── Refinement Badge (Phase 5Z.5) ────────────────────────────────────────────

/**
 * Shows the refinement state of an answer.
 * gen=1 (partial) → no badge shown (internal OCR state, not user-facing)
 * gen=2 → "Forbedret"
 * gen>=2 + completeness=complete → "Fuldt svar"
 */
function RefinementBadge({
  completeness, generation, coverage, cacheHit,
}: {
  completeness?: "partial" | "complete";
  generation?:   number;
  coverage?:     number;
  cacheHit?:     boolean;
}) {
  // Never show badge for first-generation answers (gen=1 or unset).
  // "Delsvar" with a fake percentage exposes internal OCR state to users.
  if (!generation || generation < 2) return null;

  if (!completeness || completeness === "complete") {
    return (
      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium text-green-400 border-green-400/30 bg-green-400/10">
        <CheckCircle2 className="w-3 h-3" />Fuldt svar
        {coverage != null && coverage > 0 && <span className="opacity-70 ml-0.5">({coverage}%)</span>}
      </span>
    );
  }

  if (generation === 2) {
    return (
      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium text-blue-400 border-blue-400/30 bg-blue-400/10">
        <TrendingUp className="w-3 h-3" />Forbedret
        {coverage != null && <span className="opacity-70 ml-0.5">({coverage}%)</span>}
      </span>
    );
  }

  // Delsvar badge removed — customers don't need to see partial-answer state
  return null;
}

// ─── Validation parser ────────────────────────────────────────────────────────

// Raw struct parsed from backend text
interface ParsedValidation {
  status: "ok" | "warning" | "review_required";
  code: string | null;       // classification code set by backend (LOW_CONFIDENCE, PARSE_ERROR, …)
  completeness_summary: string;
  trust_summary: string;
  issues: string[];
  recommendation: string;
}

function parseValidationText(text: string): ParsedValidation | null {
  if (!text.startsWith("**Valideringsstatus:**")) return null;
  const field = (label: string) => {
    const re = new RegExp(`\\*\\*${label}:\\*\\*\\s*([\\s\\S]*?)(?=\\n\\n\\*\\*|$)`);
    return (text.match(re)?.[1] ?? "").trim();
  };
  const statusRaw = field("Valideringsstatus");
  const status: ParsedValidation["status"] =
    statusRaw.includes("OK") ? "ok" :
    statusRaw.includes("Advarsel") ? "warning" :
    "review_required";
  const problemsRaw = field("Problemer");
  const issues = problemsRaw
    .split("\n")
    .map(l => l.replace(/^\s*[•·\-]\s*/, "").trim())
    .filter(l => l && !l.toLowerCase().includes("ingen problemer"));
  const codeRaw = field("ClassificationCode");
  return {
    status,
    code: codeRaw || null,
    completeness_summary: field("Fuldstændighed"),
    trust_summary: field("Troværdighed"),
    issues,
    recommendation: field("Anbefaling"),
  };
}

// ─── Validation view-model ────────────────────────────────────────────────────

interface ValidationCardViewModel {
  status: "ok" | "warning" | "review_required";
  summary: string;
  primaryAction: string;
  secondaryAction: string | null;
  trustText: string | null;
  issueItems: string[];
  detailsLabel: string;
}

function mapValidationToViewModel(parsed: ParsedValidation): ValidationCardViewModel {
  const issueItems = parsed.issues ?? [];
  const n = issueItems.length;
  const detailsLabel = n > 0 ? `Se detaljer (${n} ${n === 1 ? "forhold" : "forhold"})` : "Se detaljer";

  if (parsed.code === "LOW_CONFIDENCE") {
    return {
      status: "review_required",
      summary: "Dokumentet kan læses, men kan ikke verificeres som en officiel eller autentisk kilde.",
      primaryAction: "Send til manuel gennemgang",
      secondaryAction: null,
      trustText: parsed.trust_summary || null,
      issueItems,
      detailsLabel,
    };
  }

  if (parsed.code === "PARSE_ERROR") {
    return {
      status: "review_required",
      summary: "Dokumentet kunne ikke behandles pålideligt.",
      primaryAction: "Kontrollér dokumentets format",
      secondaryAction: "Send til manuel gennemgang",
      trustText: parsed.trust_summary || null,
      issueItems,
      detailsLabel,
    };
  }

  // Default: use raw AI result — backend is the source of truth
  return {
    status: parsed.status,
    summary: parsed.completeness_summary || "Dokumentet er behandlet.",
    primaryAction: parsed.recommendation || "Send til manuel gennemgang",
    secondaryAction: null,
    trustText: parsed.trust_summary || null,
    issueItems,
    detailsLabel,
  };
}

// ─── Validation Card ──────────────────────────────────────────────────────────

const VALIDATION_STATUS_CONFIG: Record<ValidationCardViewModel["status"], { label: string; color: string; Icon: typeof CheckCircle2 }> = {
  ok:               { label: "Godkendt",         color: "text-green-400 border-green-400/30 bg-green-400/10",    Icon: CheckCircle2 },
  warning:          { label: "Advarsel",          color: "text-yellow-400 border-yellow-400/30 bg-yellow-400/10", Icon: AlertTriangle },
  review_required:  { label: "Kræver gennemgang", color: "text-red-400 border-red-400/30 bg-red-400/10",     Icon: ShieldAlert   },
};

function ValidationCard({ vm, warnings }: { vm: ValidationCardViewModel; warnings: string[] }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const { label, color, Icon } = VALIDATION_STATUS_CONFIG[vm.status];
  const hasDetails = !!(vm.trustText || vm.issueItems.length > 0);

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-muted-foreground">Dokumentvalidering</span>
        <span className={cn("inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium", color)}>
          <Icon className="w-3 h-3" />{label}
        </span>
      </div>

      {warnings.map((w, i) => (
        <div key={i} className="flex items-start gap-2 text-xs text-amber-300 bg-amber-400/5 border border-amber-400/20 rounded-lg p-2">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />{w}
        </div>
      ))}

      {/* Summary */}
      <p className="text-sm font-medium text-foreground leading-relaxed" data-testid="text-chat-answer">
        {vm.summary}
      </p>

      {/* Primary action — inline text button, no box, no icon */}
      <button className="mt-2 text-sm font-medium text-primary hover:underline text-left" data-testid="button-primary-action">
        → {vm.primaryAction}
      </button>

      {/* Secondary action — muted, smaller */}
      {vm.secondaryAction && (
        <p className="text-xs text-muted-foreground mt-1">
          {vm.secondaryAction}
        </p>
      )}

      {/* Details toggle */}
      {hasDetails && (
        <>
          <button
            onClick={() => setDetailsOpen(v => !v)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mt-2"
            data-testid="button-toggle-details"
          >
            {detailsOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {detailsOpen ? "Skjul detaljer" : vm.detailsLabel}
          </button>
          {detailsOpen && (
            <div className="mt-2 space-y-2 border-l-2 border-border/40 pl-3" data-testid="panel-chat-details">
              {vm.trustText && (
                <p className="text-xs text-muted-foreground">{vm.trustText}</p>
              )}
              {vm.issueItems.length > 0 && (
                <ul className="space-y-0.5">
                  {vm.issueItems.map((item, i) => (
                    <li key={i} className="text-xs text-muted-foreground flex items-start gap-1.5">
                      <span className="shrink-0 mt-0.5">•</span>{item}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Status Badge (non-validation cards) ──────────────────────────────────────

const ROUTE_BADGE: Record<RouteType, { label: string; className: string }> = {
  attachment_first: { label: "Dokumentsvar",     className: "text-blue-400 border-blue-400/30 bg-blue-400/10" },
  hybrid:           { label: "Hybrid",            className: "text-violet-400 border-violet-400/30 bg-violet-400/10" },
  expert_auto:      { label: "Ekspertsvar",       className: "text-emerald-400 border-emerald-400/30 bg-emerald-400/10" },
  processing:       { label: "Behandler...",      className: "text-amber-400 border-amber-400/30 bg-amber-400/10" },
  not_ready:        { label: "Fejl i dokument",   className: "text-red-400 border-red-400/30 bg-red-400/10" },
  no_context:       { label: "Ingen kontekst",    className: "text-muted-foreground border-border bg-muted/30" },
};

function RoutingBadge({ routeType }: { routeType?: RouteType }) {
  if (!routeType || routeType === "expert_auto") return null;
  const cfg = ROUTE_BADGE[routeType];
  return (
    <span className={`inline-flex items-center gap-1 text-xs border rounded-full px-2 py-0.5 font-medium ${cfg.className}`}>
      {cfg.label}
    </span>
  );
}

function StatusBadge({ response }: { response: ChatResponse }) {
  if (response.needs_manual_review) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-amber-400 border border-amber-400/30 bg-amber-400/10 rounded-full px-2 py-0.5 font-medium">
        <ShieldAlert className="w-3 h-3" />Kræver gennemgang
      </span>
    );
  }
  if (response.confidence_band === "unknown" || response.confidence_band === "low") return null;
  return <ConfidenceBadge band={response.confidence_band} />;
}

// ─── Answer Card ──────────────────────────────────────────────────────────────

function AnswerCard({ response, text }: { response: ChatResponse; text: string }) {
  const [expanded, setExpanded] = useState(false);
  const isExpert = response.source?.type === "expert";

  // Ny arkitektur: document_validation-feltet bærer valideringsresultat separat fra svaret.
  // Legacy: text starter med "**Valideringsstatus:**" (gamle beskeder uden doc QA).
  const docValidation = response.document_validation
    ? parseValidationText(response.document_validation)
    : null;
  const legacyValidation = !docValidation ? parseValidationText(text) : null;

  // Legacy: kun validering, intet svar → vis kun ValidationCard
  if (legacyValidation) {
    return <ValidationCard vm={mapValidationToViewModel(legacyValidation)} warnings={response.warnings} />;
  }

  // Normal grounded Q&A card (med evt. validering ovenover)
  const hasDetails = response.used_sources.length > 0 || response.used_rules.length > 0;
  return (
    <div className="space-y-3">
      {/* Valideringskort — vises øverst når dokumentet er valideret */}
      {docValidation && (
        <ValidationCard vm={mapValidationToViewModel(docValidation)} warnings={[]} />
      )}

      <div className="space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-muted-foreground">
            {docValidation
              ? "Dokumentsvar"
              : isExpert
                ? (response.source?.name ?? response.expert.name)
                : "Systemsvar"}
          </span>
          <div className="flex items-center gap-1.5 flex-wrap">
            <RefinementBadge
              completeness={response.answer_completeness ?? (response.answerCompleteness as "partial" | "complete" | undefined)}
              generation={response.refinement_generation}
              coverage={response.source_coverage_percent ?? response.sourceCoveragePercent}
              cacheHit={response._answer_cache_hit}
            />
            <RoutingBadge routeType={response.route_type} />
            <StatusBadge response={response} />
          </div>
        </div>

        {response.warnings.map((w, i) => (
          <div key={i} className="flex items-start gap-2 text-xs text-amber-300 bg-amber-400/5 border border-amber-400/20 rounded-lg p-2">
            <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />{w}
          </div>
        ))}

        {/* Phase 5Z.5 — Partial answer trust state */}
        {(response.partial_warning ?? response.partialWarning) && (
          <div className="flex items-center gap-1.5 text-xs text-amber-400/80">
            <Hourglass className="w-3 h-3 shrink-0" />
            {response.partial_warning ?? response.partialWarning}
          </div>
        )}

        <div className="text-sm leading-relaxed whitespace-pre-wrap text-foreground" data-testid="text-chat-answer">
          {text}
        </div>

        {(hasDetails || response.used_sources.length > 0) && (
        <div className="flex items-center justify-between pt-0.5">
          {response.used_sources.length > 0 && (
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <BookOpen className="w-3 h-3 shrink-0" />
              {response.used_sources.slice(0, 2).map(s => s.name).join(", ")}
              {response.used_sources.length > 2 && ` +${response.used_sources.length - 2}`}
            </p>
          )}
          {hasDetails && (
            <button
              onClick={() => setExpanded(v => !v)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors ml-auto"
              data-testid="button-toggle-details"
            >
              {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              {expanded ? "Skjul" : "Detaljer"}
            </button>
          )}
        </div>
      )}

      {expanded && (
        <div className="rounded-xl border border-border/60 bg-muted/20 p-3 space-y-2 text-xs" data-testid="panel-chat-details">
          {response.expert.name && (
            <p className="text-muted-foreground">
              <span className="text-foreground/70 font-medium">Ekspert: </span>{response.expert.name}
              {response.expert.category && ` · ${response.expert.category}`}
            </p>
          )}
          {response.used_sources.length > 0 && (
            <div>
              <p className="text-muted-foreground font-medium mb-1">Kilder</p>
              {response.used_sources.map(s => (
                <div key={s.id} className="flex items-center gap-2 text-foreground/80 mb-0.5">
                  <BookOpen className="w-3 h-3 text-primary/70 shrink-0" />{s.name}
                </div>
              ))}
            </div>
          )}
          {response.used_rules.length > 0 && (
            <div>
              <p className="text-muted-foreground font-medium mb-1">Regler</p>
              {response.used_rules.map(r => (
                <div key={r.id} className="flex items-center gap-2 text-foreground/80 mb-0.5">
                  <ShieldAlert className="w-3 h-3 text-primary/70 shrink-0" />{r.title}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  );
}

// ─── Attachment Chip ──────────────────────────────────────────────────────────

function AttachmentChip({ file, onRemove }: { file: AttachedFile; onRemove?: () => void }) {
  const statusColors: Record<AttachedFile["status"], string> = {
    ready:      "border-border/60 bg-muted/30",
    uploading:  "border-yellow-400/30 bg-yellow-400/5",
    processing: "border-blue-400/30 bg-blue-400/5",
    done:       "border-green-400/30 bg-green-400/5",
    failed:     "border-red-400/30 bg-red-400/5",
  };
  const statusLabel: Record<AttachedFile["status"], string> = {
    ready: "", uploading: "Uploader…", processing: "Behandler…", done: "Klar", failed: "Fejl",
  };

  return (
    <div className={cn("flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-xs max-w-[200px]", statusColors[file.status])}>
      {fileIcon(file.type)}
      <span className="truncate text-foreground/80">{file.file.name}</span>
      <span className="text-muted-foreground shrink-0">{formatBytes(file.file.size)}</span>
      {statusLabel[file.status] && (
        <span className="text-muted-foreground shrink-0">{statusLabel[file.status]}</span>
      )}
      {onRemove && file.status === "ready" && (
        <button onClick={onRemove} className="shrink-0 hover:text-red-400 transition-colors" data-testid="button-remove-attachment">
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}
// ─── OCR Processing Card ───────────────────────────────────────────────────────────────────────────────
/**
 * Shown while OCR is still processing the full document.
 * Replaces the old "Jeg har kun analyseret..." provisional text.
 */
function OcrProcessingCard() {
  const [phase, setPhase] = useState(0);
  const steps = [
    "Læser dokumentets sider...",
    "Analyserer tekst og struktur...",
    "Identificerer nøgleoplysninger...",
    "Forbereder fuldt svar...",
  ];
  useEffect(() => {
    const t = setInterval(() => setPhase(p => (p + 1) % steps.length), 2800);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="space-y-3 py-0.5">
      <div className="flex items-center gap-2">
        <svg className="w-4 h-4 animate-spin shrink-0 text-primary/70" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <span className="text-sm font-medium text-foreground">Analyserer dokument</span>
      </div>
      <p className="text-sm text-muted-foreground transition-all duration-500">
        {steps[phase]}
      </p>
      <div className="flex gap-1 pt-0.5">
        {steps.map((_, i) => (
          <div
            key={i}
            className={cn(
              "h-1 rounded-full transition-all duration-500",
              i <= phase ? "bg-primary/60 flex-1" : "bg-muted flex-[0.4]",
            )}
          />
        ))}
      </div>
    </div>
  );
}
// ─── Message Bubble ───────────────────────────────────────────────────────────────────────────────
function MessageBubble({
  msg,
  kbList,
  onPromote,
  promotingAssetId,
}: {
  msg: ChatMessage;
  kbList?: Array<{ id: string; name: string }>;
  onPromote?: (assetId: string, targetKbId: string, userMsgId: string) => void;
  promotingAssetId?: string | null;
}) {
  if (msg.role === "user") {
    const pendingAssetRefs = (msg.assetRefs ?? []).filter(r => r.scope === "temporary_chat");
    const savedAssetRefs  = (msg.assetRefs ?? []).filter(r => r.scope === "persistent_storage");
    const hasSaveUI = pendingAssetRefs.length > 0 && kbList && kbList.length > 0 && onPromote;
    const hasSavedBadge = savedAssetRefs.length > 0;

    return (
      <div className="mb-6 last:mb-0 flex justify-end" data-testid={`msg-user-${msg.id}`}>
        <div className="flex items-end gap-2 max-w-[80%]">
          <div className="space-y-1.5">
            {msg.attachments && msg.attachments.length > 0 && (
              <div className="flex flex-wrap gap-1.5 justify-end">
                {msg.attachments.map(a => <AttachmentChip key={a.id} file={a} />)}
              </div>
            )}
            <div className="bg-primary/15 border border-primary/20 rounded-2xl rounded-br-sm px-4 py-2.5 text-sm text-foreground">
              {msg.text}
            </div>
            {/* "Gem til vidensbase" — ét knap pr. pending asset */}
            {hasSaveUI && pendingAssetRefs.map(ref => (
              <div key={ref.assetId} className="flex justify-end">
                {kbList!.length === 1 ? (
                  <button
                    data-testid={`btn-save-asset-${ref.assetId}`}
                    onClick={() => onPromote!(ref.assetId, kbList![0].id, msg.id)}
                    disabled={promotingAssetId === ref.assetId}
                    className="flex items-center gap-1.5 text-xs text-primary/80 hover:text-primary border border-primary/20 hover:border-primary/40 rounded-lg px-2.5 py-1 bg-primary/5 hover:bg-primary/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {promotingAssetId === ref.assetId
                      ? <><span className="w-3 h-3 border border-primary/50 border-t-primary rounded-full animate-spin" />Gemmer…</>
                      : <><Save className="w-3 h-3" />Gem til vidensbase</>}
                  </button>
                ) : (
                  <select
                    data-testid={`select-save-asset-${ref.assetId}`}
                    disabled={promotingAssetId === ref.assetId}
                    defaultValue=""
                    onChange={e => { if (e.target.value) onPromote!(ref.assetId, e.target.value, msg.id); }}
                    className="text-xs border border-primary/20 rounded-lg px-2 py-1 bg-background text-primary/80 cursor-pointer disabled:opacity-50"
                  >
                    <option value="" disabled>
                      {promotingAssetId === ref.assetId ? "Gemmer…" : `Gem "${ref.filename}" i…`}
                    </option>
                    {kbList!.map(kb => (
                      <option key={kb.id} value={kb.id}>{kb.name}</option>
                    ))}
                  </select>
                )}
              </div>
            ))}
            {/* Allerede gemt-badges */}
            {hasSavedBadge && savedAssetRefs.map(ref => (
              <div key={ref.assetId} className="flex justify-end">
                <span
                  data-testid={`badge-saved-asset-${ref.assetId}`}
                  className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400"
                >
                  <Database className="w-3 h-3" />Gemt i vidensbase
                </span>
              </div>
            ))}
          </div>
          <div className="shrink-0 w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center mb-0.5">
            <User className="w-3.5 h-3.5 text-primary" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn("mb-6 last:mb-0 flex justify-start transition-opacity duration-300",
        msg.isSuperseded && "opacity-40")}
      data-testid={`msg-assistant-${msg.id}`}
    >
      <div className="flex items-end gap-2 max-w-[88%]">
        <div className={cn(
          "shrink-0 w-7 h-7 rounded-full bg-muted flex items-center justify-center mb-0.5",
          msg.isSuperseded && "opacity-60",
        )}>
          <Bot className="w-3.5 h-3.5 text-primary" />
        </div>
        <div className="flex flex-col gap-1">
          {/* Phase 5Z.5 — superseded label */}
          {msg.isSuperseded && (
            <span className="text-xs text-muted-foreground/60 flex items-center gap-1 pl-1">
              <TrendingUp className="w-3 h-3" />Erstattet af opdateret svar
            </span>
          )}
          <div className={cn(
            "rounded-2xl border bg-card px-4 py-3 shadow-sm rounded-bl-sm",
            msg.isError && "border-red-400/30 bg-red-400/5",
            msg.isSuperseded && "border-border/40",
          )}>
            {msg.isError ? (
              <div className="flex items-start gap-2 text-sm text-red-400">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />{msg.text}
              </div>
            ) : msg.isStreaming ? (
              <p className="text-sm text-foreground whitespace-pre-wrap">
                {msg.text || <span className="text-muted-foreground text-xs">Skriver...</span>}
                <span className="inline-block w-0.5 h-4 bg-primary/70 ml-0.5 align-middle animate-pulse" />
              </p>
            ) : msg.isProcessingPlaceholder && !msg.isSuperseded ? (
              <>
                <AnswerCard response={msg.response!} text={msg.text} />
                <div className="flex items-center gap-1.5 mt-2 text-xs text-amber-400/80">
                  <svg className="w-3 h-3 animate-spin shrink-0" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Analyserer resten af dokumentet… svaret opdateres automatisk
                </div>
              </>
            ) : msg.response ? (
              <AnswerCard response={msg.response} text={msg.text} />
            ) : (
              <p className="text-sm text-foreground">{msg.text}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Typing Indicator ─────────────────────────────────────────────────────────

function TypingIndicator() {
  return (
    <div className="mb-6 flex justify-start">
      <div className="flex items-end gap-2">
        <div className="shrink-0 w-7 h-7 rounded-full bg-muted flex items-center justify-center">
          <Bot className="w-3.5 h-3.5 text-primary" />
        </div>
        <div className="rounded-2xl border bg-card px-4 py-3 shadow-sm rounded-bl-sm flex items-center gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce [animation-delay:0ms]" />
          <div className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce [animation-delay:150ms]" />
          <div className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce [animation-delay:300ms]" />
        </div>
      </div>
    </div>
  );
}

// ─── Readiness Stream Banner (Phase 5Z.3) ─────────────────────────────────────

interface ReadinessStreamBannerProps {
  uxState:   ReadinessUxState;
  snapshot:  ReadinessSnapshot | null;
  isConnected: boolean;
  onRefreshAnswer?: () => void;
}

function ReadinessStreamBanner({ uxState, snapshot, isConnected, onRefreshAnswer }: ReadinessStreamBannerProps) {
  if (uxState === "idle" || uxState === "complete_answer_available") return null;

  const coveragePct  = snapshot?.coveragePercent ?? 0;
  const segsReady    = snapshot?.segmentsReady ?? 0;
  const segsTotal    = snapshot?.segmentsTotal ?? 0;
  const partialWarn  = snapshot?.partialWarning;
  const canRefresh   = snapshot?.canRefreshForBetterAnswer ?? false;
  const isBlocked    = snapshot?.fullCompletionBlocked ?? false;

  if (uxState === "dead_letter_document") {
    return (
      <div className="flex items-center gap-2 px-4 py-2 text-sm text-red-500 bg-red-50 dark:bg-red-950/30 rounded-md mx-4 mb-2" data-testid="readiness-banner-dead-letter">
        <AlertTriangle className="w-4 h-4 shrink-0" />
        <span>Dokumentet kunne ikke behandles fuldt ud. Svar baseres på tilgængeligt indhold.</span>
      </div>
    );
  }

  if (uxState === "failed_document") {
    return (
      <div className="flex items-center gap-2 px-4 py-2 text-sm text-orange-500 bg-orange-50 dark:bg-orange-950/30 rounded-md mx-4 mb-2" data-testid="readiness-banner-failed">
        <AlertTriangle className="w-4 h-4 shrink-0" />
        <span>Behandling fejlede for dele af dokumentet. Forsøger igen automatisk…</span>
      </div>
    );
  }

  if (uxState === "blocked_partial_answer") {
    return (
      <div className="flex items-center gap-2 px-4 py-2 text-sm text-amber-600 bg-amber-50 dark:bg-amber-950/30 rounded-md mx-4 mb-2" data-testid="readiness-banner-blocked">
        <WifiOff className="w-4 h-4 shrink-0" />
        <span>Fuld dokumentbehandling er blokeret. Svaret er baseret på delvist tilgængeligt indhold.</span>
      </div>
    );
  }

  if (uxState === "improving_answer") {
    return (
      <div className="flex items-center gap-2 px-4 py-2 text-sm text-blue-500 bg-blue-50 dark:bg-blue-950/30 rounded-md mx-4 mb-2" data-testid="readiness-banner-improving">
        <RefreshCw className="w-4 h-4 shrink-0 animate-spin" />
        <span>Forbedrer svar med mere indhold ({coveragePct}% dækning)…</span>
      </div>
    );
  }

  if (uxState === "partial_answer_available") {
    return (
      <div className="flex items-center gap-2 px-4 py-2 text-sm text-primary/80 bg-primary/5 rounded-md mx-4 mb-2" data-testid="readiness-banner-partial">
        <Zap className="w-4 h-4 shrink-0 text-primary" />
        <span className="flex-1">
          {partialWarn ?? `Delvist svar: ${coveragePct}% af dokumentet er klar (${segsReady}/${segsTotal} segmenter)`}
          {isBlocked && " · Fuld behandling er blokeret"}
        </span>
        {canRefresh && onRefreshAnswer && (
          <button
            onClick={onRefreshAnswer}
            className="text-primary hover:underline shrink-0"
            data-testid="button-refresh-answer"
          >
            Opdater svar
          </button>
        )}
      </div>
    );
  }

  if (uxState === "connecting_to_document_stream") {
    return (
      <div className="flex items-center gap-2 px-4 py-2 text-sm text-muted-foreground" data-testid="readiness-banner-connecting">
        <Clock className="w-4 h-4 shrink-0 animate-pulse" />
        <span>Forbinder til dokumentstream…</span>
      </div>
    );
  }

  if (uxState === "processing_document") {
    return (
      <div className="flex items-center gap-2 px-4 py-2 text-sm text-muted-foreground animate-pulse" data-testid="readiness-banner-processing">
        <svg className="w-4 h-4 animate-spin shrink-0" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <span>
          Behandler dokument{segsTotal > 0 ? ` — ${segsReady}/${segsTotal} segmenter klar` : "…"}
        </span>
      </div>
    );
  }

  return null;
}

// ─── Empty State ──────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex flex-col items-center text-center gap-1.5" data-testid="empty-state-chat">
      <h2 className="text-base font-semibold text-foreground tracking-tight">
        Hvad vil du analysere?
      </h2>
      <p className="text-sm text-muted-foreground/60 max-w-xs">
        Stil et spørgsmål eller upload et dokument for at komme i gang.
      </p>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AiChatPage() {
  const { toast } = useToast();
  const [location] = useLocation();
  const [messages, setMessages]           = useState<ChatMessage[]>([]);
  const [input, setInput]                 = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [attachments, setAttachments]     = useState<AttachedFile[]>([]);
  const [ocrStatusLabel, setOcrStatusLabel] = useState<string | null>(null);
  // isFastPath: true while a confirmed ALL_FAST request is in flight.
  // Gates the OCR status card so it NEVER shows for text-PDF fast-path flows.
  const [isFastPath, setIsFastPath] = useState(false);
  const bottomRef   = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Phase 5Z.3 — Document readiness monitoring ────────────────────────────
  // Activate when URL contains ?monitorDocumentId=<kb-doc-id>
  const monitorDocumentId = new URLSearchParams(
    typeof window !== "undefined" ? window.location.search : "",
  ).get("monitorDocumentId");

  // Phase 2+3 — stable session ID used as chatThreadId for all asset rows in this session
  const chatSessionIdRef = useRef<string>(crypto.randomUUID());

  // Phase 5.5 — persists the last built text document context for follow-up continuity.
  // Cleared when thread is reset (component remount / new chat). Text-only — never vision images.
  const activeDocumentContextRef = useRef<any[]>([]);

  // Phase 2+3 — promote mutation for "Gem til vidensbase"
  const [promotingAssetId, setPromotingAssetId] = useState<string | null>(null);

  // Phase 2+3 — fetch user's knowledge bases for the KB picker
  const { data: kbListData } = useQuery<{ kbs: Array<{ id: string; name: string }> }>({
    queryKey: ["/api/kb"],
  });
  const kbList = kbListData?.kbs ?? [];

  const autoTriggeredKeysRef = useRef<Set<string>>(new Set());
  // chatMutateRef holds a stable reference to chatMutation.mutate (set after hook declaration)
  const chatMutateRef = useRef<((payload: { text: string; attachments: AttachedFile[]; documentIds?: string[]; triggerKey?: string; _documentContextOverride?: any[]; _upgradeStreamMsgId?: string; _userMsgId?: string }) => void) | null>(null);
  // Upgrade ref: set when partial_ready break → onSuccess starts upgrade SSE subscription
  const pendingOcrUpgradeRef = useRef<{ taskId: string; filename: string; mime: string } | null>(null);
  // Set to true while an upgrade mutation is in flight — suppresses error toast in onError
  const isUpgradeAttemptRef = useRef(false);

  const handleAutoTrigger = useCallback((snap: ReadinessSnapshot, isImprovement: boolean) => {
    if (!snap.triggerKey) return;
    if (autoTriggeredKeysRef.current.has(snap.triggerKey)) return; // idempotent
    if (!chatMutateRef.current) return; // mutation not ready yet
    autoTriggeredKeysRef.current.add(snap.triggerKey);

    const defaultQuestion = isImprovement
      ? "Opdater analysen med det nyeste indhold fra dokumentet."
      : "Hvad indeholder dokumentet? Giv en præcis analyse baseret på det tilgængelige indhold.";

    chatMutateRef.current({
      text:        defaultQuestion,
      attachments: [],
      documentIds: monitorDocumentId ? [monitorDocumentId] : [],
      triggerKey:  snap.triggerKey,
    });
  }, [monitorDocumentId]);

  const { uxState, snapshot, isConnected, answerGeneration, duplicatesPrevented } =
    useReadinessStream({
      documentId:         monitorDocumentId,
      onAutoTrigger:      handleAutoTrigger,
      autoTriggerEnabled: !ocrStatusLabel,
    });

  const handleRefreshAnswer = useCallback(() => {
    if (!snapshot?.triggerKey || !snapshot.canRefreshForBetterAnswer) return;
    autoTriggeredKeysRef.current.delete(snapshot.triggerKey);
    handleAutoTrigger(snapshot, true);
  }, [snapshot, handleAutoTrigger]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ── File picker ──────────────────────────────────────────────────────────────

  const openPicker = useCallback(() => {
    setTimeout(() => fileInputRef.current?.click(), 0);
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    const tooBig = files.filter(f => f.size > MAX_SIZE_MB * 1024 * 1024);
    if (tooBig.length) {
      toast({ title: "Fil for stor", description: `Maksimum størrelse er ${MAX_SIZE_MB} MB.`, variant: "destructive" });
    }
    const valid = files.filter(f => f.size <= MAX_SIZE_MB * 1024 * 1024);
    const newFiles: AttachedFile[] = valid.map(f => ({
      id: crypto.randomUUID(),
      file: f,
      type: fileType(f),
      status: "ready",
      previewUrl: f.type.startsWith("image/") ? URL.createObjectURL(f) : undefined,
    }));
    setAttachments(prev => [...prev, ...newFiles]);
  };

  const removeAttachment = (id: string) => {
    setAttachments(prev => {
      const a = prev.find(x => x.id === id);
      if (a?.previewUrl) URL.revokeObjectURL(a.previewUrl);
      return prev.filter(x => x.id !== id);
    });
  };

  // ── Send ─────────────────────────────────────────────────────────────────────

  const chatMutation = useMutation({
    mutationFn: async (payload: { text: string; attachments: AttachedFile[]; useCase?: string; documentIds?: string[]; triggerKey?: string; _documentContextOverride?: any[]; submitAt?: number; _upgradeStreamMsgId?: string; _userMsgId?: string }) => {
      const traceId = crypto.randomUUID().slice(0, 8);
      const T0 = Date.now();
      const tClick = payload.submitAt ?? T0;
      const isUpgradeReuse = !!payload._upgradeStreamMsgId;

      const streamMsgId = payload._upgradeStreamMsgId ?? crypto.randomUUID();
      let streamBubbleCreated = false;

      if (isUpgradeReuse) {
        streamBubbleCreated = true;
        setMessages(prev => prev.map(m =>
          m.id === streamMsgId ? { ...m, isStreaming: true } : m
        ));
        console.log(`[UPGRADE-REUSE] Reusing msgId=${streamMsgId} — marking as streaming`);
      }

      const createStreamBubble = (decision: string) => {
        if (streamBubbleCreated) return;
        streamBubbleCreated = true;
        setMessages(prev => [...prev, {
          id: streamMsgId, role: "assistant" as const,
          text: "", isStreaming: true, timestamp: new Date(),
        }]);
        const tBubble = Date.now();
        console.log(`[TIMING] MESSAGE_STATE_CREATED t=${tBubble} +${tBubble - tClick}ms_since_CLICK decision=${decision}`);
        console.log(`[UI] UI_STREAM_MSG_CREATED t=${tBubble} +${tBubble - tClick}ms_since_CLICK decision=${decision} traceId=${traceId}`);
      };

      // ── TRACE STAGE 1: FRONTEND SEND ─────────────────────────────────────
      // Video-filer behandles som dokumenter: R2 upload → finalize → Gemini 2.5 Flash video-analyse
      const docFiles = payload.attachments.filter(a => a.type === "document" || a.type === "video");
      const imgFiles = payload.attachments.filter(a => a.type === "image");
      console.log(
        `[TIMING] FILES_SELECTED t=${T0} docFiles=${docFiles.length} imgFiles=${imgFiles.length}` +
        ` names=[${docFiles.map(a => a.file.name).join(",")}]`,
      );
      console.log(
        `[LIVE][${traceId}] T0_UPLOAD_RECEIVED t=${T0}` +
        ` doc_files=${docFiles.length} img_files=${imgFiles.length}` +
        ` names=[${docFiles.map(a => a.file.name).join(",")}]` +
        ` env=${import.meta.env.MODE} isProd=${import.meta.env.PROD}`,
      );
      console.log(`[TRACE-1][${traceId}] use_case="${payload.useCase ?? "grounded_chat"}" attachments_total=${payload.attachments.length} doc_files=${docFiles.length} img_files=${imgFiles.length} names=[${docFiles.map(a=>a.file.name).join(",")}]`);

      // ── Step A: Ekstraher dokumentindhold via direkte R2-upload ───────────
      // Filer uploades ALDRIG igennem Vercel — Browser → R2 direkte via presigned URL.
      // Vercel modtager kun lille JSON (presign-request + finalize-request).
      // _documentContextOverride: bruges til upgrade-chat (partial→complete) — springer upload over.
      let documentContext: any[] = payload._documentContextOverride ?? [];

      // ── Phase 5.5: follow-up asset continuity ─────────────────────────────
      // If no new files attached and no override, reuse the last active thread context.
      // This ensures follow-up questions are grounded in previously uploaded documents.
      if (documentContext.length === 0 && docFiles.length === 0 && imgFiles.length === 0) {
        if (activeDocumentContextRef.current.length > 0) {
          documentContext = activeDocumentContextRef.current;
          console.log(
            `[ASSETS] FOLLOWUP_ASSET_REFS_ATTACHED thread=${chatSessionIdRef.current.slice(0,8)}` +
            ` count=${documentContext.length}` +
            ` sources=[${documentContext.map((r:any)=>r.source).join(",")}]`,
          );
        } else {
          console.log(`[ASSETS] FOLLOWUP_ASSET_REFS_MISSING thread=${chatSessionIdRef.current.slice(0,8)} — no active thread context`);
        }
      }

      if (docFiles.length > 0) {
        try {
          // ─── DUAL-PATH: Client-side fast extraction → immediate AI answer ──────
          // Avoids 40s R2→finalize→OCR wait for text-based PDFs and text files.
          const t2a = performance.now();
          console.log(`[TIMING] DOC_PREP_START t=${Date.now()} +${Date.now() - tClick}ms_since_CLICK files=${docFiles.length}`);
          console.log(`[FAST-PATH][${traceId}] START: ${docFiles.length} file(s) names=[${docFiles.map(a=>a.file.name).join(",")}] t=${Date.now()}`);

          const fastResults: any[] = [];
          const slowFiles: { af: typeof docFiles[0]; reason: string }[] = [];

          // Phase 2+3 + Phase 5: start asset creation/dedup-check in parallel with extraction
          const _assetPromises: Array<{ filename: string; af: typeof docFiles[0]; promise: Promise<AssetCreateResult | null> }> = [];

          for (const af of docFiles) {
            const file = af.file;
            const mode = classifyForFastExtract(file);

            // Start asset creation immediately — runs in parallel with extraction
            _assetPromises.push({
              filename: file.name,
              af,
              promise: createChatAssetForFile(file, af.type, chatSessionIdRef.current),
            });

            const T1 = Date.now();
            console.log(
              `[LIVE][${traceId}] T1_CLASSIFY_DONE t=${T1} +${T1 - T0}ms` +
              ` file="${file.name}" classify=${mode} size=${file.size} mime="${file.type}"`,
            );
            console.log(`[FAST-PATH][${traceId}] CLASSIFY ${file.name}: mode=${mode} size=${file.size} mime="${file.type}"`);

            if (mode === "unsupported") {
              const reason = `unsupported_mime_or_size:${file.type || "empty"}:${file.size}b`;
              console.log(`[FAST-PATH][${traceId}] SKIP ${file.name}: ${reason} → slowFiles`);
              slowFiles.push({ af, reason });
              continue;
            }

            const T2 = Date.now();
            console.log(
              `[LIVE][${traceId}] T2_EXTRACT_START t=${T2} +${T2 - T0}ms` +
              ` file="${file.name}" mode=${mode}`,
            );

            const extractResult = await fastExtractText(file, `[${traceId}]${file.name}`);

            const T3 = Date.now();
            const extractMs = T3 - T2;

            if (extractResult && extractResult.charCount > 0) {
              console.log(
                `[LIVE][${traceId}] T3_EXTRACT_DONE t=${T3} +${T3 - T0}ms` +
                ` extractMs=${extractMs}ms file="${file.name}"` +
                ` rawChars=${extractResult.rawChars} pagesWithText=${extractResult.pagesWithText}` +
                ` chars=${extractResult.charCount} gateForced=${extractResult.gateForced}` +
                ` workerSrc=${extractResult.workerSrc.slice(0, 60)}` +
                ` src=${extractResult.source} → FAST_PATH`,
              );
              console.log(`[FAST-PATH][${traceId}] OK ${file.name}: chars=${extractResult.charCount} words=${extractResult.wordCount} alpha=${extractResult.alphaRatio.toFixed(2)} dur=${extractResult.durationMs}ms src=${extractResult.source}`);
              fastResults.push({
                filename:       file.name,
                mime_type:      file.type || "application/octet-stream",
                char_count:     extractResult.charCount,
                extracted_text: extractResult.text,
                status:         "ok",
                source:         extractResult.source,
              });
            } else {
              const reason = extractResult === null ? "gate_rejected_or_error" : "zero_chars";
              console.log(
                `[LIVE][${traceId}] T3_EXTRACT_DONE t=${T3} +${T3 - T0}ms` +
                ` extractMs=${extractMs}ms file="${file.name}"` +
                ` result=REJECTED reason=${reason} slowFiles=${slowFiles.length + 1}` +
                ` → OCR fallback path`,
              );
              console.log(`[FAST-PATH][${traceId}] REJECTED ${file.name}: ${reason} — slow fallback`);
              slowFiles.push({ af, reason });
            }
          }

          // Phase 2+3 + Phase 5: resolve all asset creation promises and update user message
          const _assetRefs: AssetRef[] = (await Promise.all(
            _assetPromises.map(async p => {
              const result = await p.promise;
              if (!result) return null;
              return {
                assetId:       result.assetId,
                filename:      p.filename,
                scope:         "temporary_chat" as const,
                isDeduped:     result.isDeduped,
                skipUpload:    result.skipUpload,
                existingR2Key: result.existingR2Key,
              };
            }),
          )).filter((r): r is AssetRef => r !== null);

          if (payload._userMsgId && _assetRefs.length > 0) {
            setMessages(prev => prev.map(m =>
              m.id === payload._userMsgId ? { ...m, assetRefs: _assetRefs } : m,
            ));
            console.log(`[ASSETS][${traceId}] Created ${_assetRefs.length} chat asset(s): ${_assetRefs.map(r => r.assetId).join(",")}`);
          }

          const fastMs = Math.round(performance.now() - t2a);
          console.log(`[FAST-PATH][${traceId}] SUMMARY: fast=${fastResults.length} slow=${slowFiles.length} totalMs=${fastMs} t=${Date.now()}`);
          console.log(
            `[TIMING] DOC_PREP_DONE t=${Date.now()} +=${Date.now() - tClick}ms_since_CLICK` +
            ` fast=${fastResults.length} slow=${slowFiles.length} decision=${slowFiles.length === 0 && fastResults.length > 0 ? "ALL_FAST" : fastResults.length > 0 ? "MIXED" : "ALL_SLOW_or_SCANNED"}`,
          );

          // ── SCANNED_PREVIEW detektion: PDFs med nul tekst → render sideforhåndsvisning ──
          // Kør FØR if/else-beslutning så vi ved om vision-rendering lykkes.
          // Kun for ALL_SLOW tilfælde (ingen fastResults) og kun PDF-filer med zero_chars/gate_rejected.
          let _scannedVisionEntries: any[] | null = null;
          const _isScannedPdfCandidate =
            fastResults.length === 0 &&
            slowFiles.length > 0 &&
            slowFiles.every(({ af, reason }) => {
              const mime = af.file.type || "";
              return mime === "application/pdf" &&
                     (reason === "gate_rejected_or_error" || reason === "zero_chars");
            });

          if (_isScannedPdfCandidate) {
            const tRender = Date.now();
            console.log(`[SCANNED][${traceId}] CANDIDATE_DETECTED files=${slowFiles.length} — rendering PDF pages for vision preview`);
            _scannedVisionEntries = [];
            for (const { af } of slowFiles) {
              const rendered = await renderPdfPagesToImages(af.file, 3);
              if (rendered && rendered.images.length > 0) {
                const _scannedPlaceholder = `[scanned_pdf_vision_preview: ${af.file.name}]`;
                _scannedVisionEntries.push({
                  filename:       af.file.name,
                  mime_type:      af.file.type || "application/pdf",
                  char_count:     _scannedPlaceholder.length,
                  extracted_text: _scannedPlaceholder,
                  status:         "ok",
                  source:         "vision_preview_pdf",
                  vision_images:  rendered.images,
                });
                console.log(`[SCANNED][${traceId}] RENDER_OK file="${af.file.name}" pages=${rendered.images.length}/${rendered.pageCount} durMs=${Date.now() - tRender}`);
              } else {
                console.warn(`[SCANNED][${traceId}] RENDER_FAIL file="${af.file.name}" — fallback til ALL_SLOW OCR`);
              }
            }
            if (_scannedVisionEntries.length === 0) {
              _scannedVisionEntries = null;
              console.warn(`[SCANNED][${traceId}] NO_VISION_ENTRIES — alle renderinger fejlede, falder tilbage til ALL_SLOW`);
            }
          }

          // ── ALL FAST: every file extracted client-side ──────────────────────
          if (slowFiles.length === 0 && fastResults.length > 0) {
            documentContext = fastResults;
            const tDecision = Date.now();
            console.log(
              `[LIVE][${traceId}] DECISION=ALL_FAST t=${tDecision} +${tDecision - T0}ms` +
              ` fast=${fastResults.length} slow=0` +
              ` sources=[${fastResults.map((r:any)=>r.source).join(",")}]` +
              ` → T4_AI_START fires next — NO OCR/R2 wait`,
            );
            console.log(`[FAST-PATH][${traceId}] DECISION=ALL_FAST → skipping server path, AI starts now at t=${tDecision}`);
            console.log(`[UI] UI_PROCESSING_CARD_SKIPPED reason=ALL_FAST t=${tDecision} traceId=${traceId}`);

            // Set isFastPath so the OCR status card is gated off for this entire request
            setIsFastPath(true);

            // Create streaming bubble NOW — text will start flowing in ~1-2s
            createStreamBubble("ALL_FAST");

            // Fire-and-forget durable R2 upload for persistence — does NOT block AI answer
            // Phase 2+3 + Phase 5: capture _assetRefs so patch can find the right assetId per file
            const _capturedAssetRefs = _assetRefs;
            ;(async () => {
              for (const af of docFiles) {
                const file = af.file;
                // Phase 5: skip R2 upload if asset is deduped and already has r2Key
                const _ref = _capturedAssetRefs.find(r => r.filename === file.name);
                if (_ref?.skipUpload) {
                  console.log(`[ASSETS][DEDUP] ALL_FAST SKIP_R2 file="${file.name}" assetId=${_ref.assetId} isDeduped=true`);
                  continue;
                }
                try {
                  const urlRes = await apiRequest("POST", "/api/upload/url", {
                    filename:    file.name,
                    contentType: file.type || "application/octet-stream",
                    size:        file.size,
                    context:     "chat",
                  });
                  if (!urlRes.ok) { console.warn(`[DURABLE][${traceId}] presign failed for ${file.name}: HTTP ${urlRes.status}`); continue; }
                  const { uploadUrl, objectKey } = await urlRes.json() as any;
                  const r2Res = await fetch(uploadUrl, { method: "PUT", body: file, headers: { "Content-Type": file.type || "application/octet-stream" } });
                  if (!r2Res.ok) { console.warn(`[DURABLE][${traceId}] R2 PUT failed for ${file.name}: HTTP ${r2Res.status}`); continue; }
                  const finRes = await apiRequest("POST", "/api/upload/finalize", {
                    objectKey,
                    filename:    file.name,
                    contentType: file.type || "application/octet-stream",
                    size:        file.size,
                    context:     "chat",
                    fileCount:   docFiles.length,
                  });
                  console.log(`[DURABLE][${traceId}] R2+finalize ${finRes.ok ? "OK" : `FAIL HTTP ${finRes.status}`} for ${file.name}`);
                  // Phase 2+3: patch asset row with r2Key
                  const assetRef = _capturedAssetRefs.find(r => r.filename === file.name);
                  if (assetRef) {
                    patchAssetR2KeyFF(assetRef.assetId, objectKey, file).catch(() => {});
                  }
                } catch (e: any) {
                  console.warn(`[DURABLE][${traceId}] error for ${file.name}: ${e?.message}`);
                }
              }
            })().catch(() => {});

          } else if (_scannedVisionEntries && _scannedVisionEntries.length > 0) {
            // ══════════════════════════════════════════════════════════════════════
            // SCANNED_PREVIEW: gpt-4o-mini vision forhåndsvisning (~8s)
            //   + baggrundsopgave: R2 upload → OCR (~40s) → opgradér SAMME besked
            // ══════════════════════════════════════════════════════════════════════
            const tScanned = Date.now();
            const totalPreviewPages = _scannedVisionEntries.reduce(
              (s: number, e: any) => s + (e.vision_images?.length ?? 0), 0,
            );
            console.log(
              `[SCANNED][${traceId}] DECISION=SCANNED_PREVIEW t=${tScanned} +${tScanned - T0}ms` +
              ` files=${slowFiles.length} previewPages=${totalPreviewPages}`,
            );

            // Vision context → sender til backend → hasVision=true → gpt-4o-mini vision path
            documentContext = _scannedVisionEntries;
            setIsFastPath(true); // Skjul OCR-statuskort — vi styrer vores eget messaging
            createStreamBubble("SCANNED_PREVIEW");

            // ── Baggrundsopgave: R2 upload → OCR → same-message upgrade ──────────
            // self-contained IIFE — ingen pendingOcrUpgradeRef race
            const _capturedMsgId  = streamMsgId;
            const _capturedText   = payload.text;
            const _capturedFiles  = slowFiles.map(s => s.af);

            ;(async () => {
              const upgradeId = crypto.randomUUID().slice(0, 8);
              console.log(`[SCANNED-UPGRADE-${upgradeId}] Starting background OCR upgrade for ${_capturedFiles.length} file(s) capturedMsgId=${_capturedMsgId}`);

              try {
                const token = await getSessionToken().catch(() => null);

                // Collect OCR results for all files before triggering upgrade
                const ocrEntries: Array<{ filename: string; mime_type: string; text: string }> = [];

                for (const af of _capturedFiles) {
                  const file = af.file;
                  console.log(`[SCANNED-UPGRADE-${upgradeId}] Processing file="${file.name}" size=${file.size}`);

                  // Phase 5: skip R2 upload entirely if this asset is deduped (already in R2)
                  const _scannedAssetRef = _assetRefs.find(r => r.filename === file.name);
                  if (_scannedAssetRef?.skipUpload) {
                    console.log(`[ASSETS][DEDUP] SCANNED SKIP_R2 file="${file.name}" assetId=${_scannedAssetRef.assetId} isDeduped=true`);
                    continue;
                  }

                  // Step 1: Presigned upload URL
                  const urlRes = await apiRequest("POST", "/api/upload/url", {
                    filename:    file.name,
                    contentType: file.type || "application/octet-stream",
                    size:        file.size,
                    context:     "chat",
                  });
                  if (!urlRes.ok) {
                    console.warn(`[SCANNED-UPGRADE-${upgradeId}] presign failed HTTP ${urlRes.status} for "${file.name}" — skipping`);
                    continue;
                  }
                  const { uploadUrl, objectKey } = await urlRes.json() as { uploadUrl: string; objectKey: string };

                  // Step 2: R2 PUT (direkte browser → R2)
                  const r2Res = await fetch(uploadUrl, {
                    method:  "PUT",
                    body:    file,
                    headers: { "Content-Type": file.type || "application/octet-stream" },
                  });
                  if (!r2Res.ok) {
                    console.warn(`[SCANNED-UPGRADE-${upgradeId}] R2 PUT failed HTTP ${r2Res.status} for "${file.name}" — skipping`);
                    continue;
                  }
                  if (_scannedAssetRef) {
                    patchAssetR2KeyFF(_scannedAssetRef.assetId, objectKey, file).catch(() => {});
                  }

                  // Step 3: Finalize → OCR task
                  const finalRes = await apiRequest("POST", "/api/upload/finalize", {
                    objectKey,
                    filename:    file.name,
                    contentType: file.type || "application/octet-stream",
                    size:        file.size,
                    context:     "chat",
                    fileCount:   _capturedFiles.length,
                    questionText: _capturedText?.trim() || undefined,
                  });
                  if (!finalRes.ok) {
                    console.warn(`[SCANNED-UPGRADE-${upgradeId}] finalize failed HTTP ${finalRes.status} for "${file.name}" — skipping`);
                    continue;
                  }
                  const finalData = await finalRes.json() as any;
                  if (finalData.mode === "B_FALLBACK") {
                    console.warn(`[SCANNED-UPGRADE-${upgradeId}] B_FALLBACK for "${file.name}" — OCR unavailable`);
                    continue;
                  }

                  const taskId = finalData.taskId as string | undefined;
                  if (!taskId) {
                    console.warn(`[SCANNED-UPGRADE-${upgradeId}] no taskId in finalData for "${file.name}" — skipping`);
                    continue;
                  }
                  console.log(`[SCANNED-UPGRADE-${upgradeId}] OCR task started taskId=${taskId} file="${file.name}" — polling...`);

                  // Step 4: Poll /api/ocr-status til completion
                  const POLL_INTERVAL = 5_000;
                  const POLL_TIMEOUT  = 360_000;
                  const pollStart     = Date.now();
                  let ocrText         = "";
                  let ocrDone         = false;

                  while (Date.now() - pollStart < POLL_TIMEOUT) {
                    await new Promise<void>(r => setTimeout(r, POLL_INTERVAL));
                    try {
                      const h: Record<string, string> = {};
                      if (token) h["Authorization"] = `Bearer ${token}`;
                      const sr = await fetch(
                        `/api/ocr-status?id=${encodeURIComponent(taskId)}`,
                        { headers: h, credentials: "include" },
                      );
                      if (!sr.ok) {
                        if (sr.status === 401 || sr.status === 403) {
                          console.warn(`[SCANNED-UPGRADE-${upgradeId}] poll auth error ${sr.status} — aborting`);
                          break;
                        }
                        continue;
                      }
                      const sj = await sr.json() as any;
                      console.log(`[SCANNED-UPGRADE-${upgradeId}] poll taskId=${taskId} status=${sj.status} chars=${sj.text?.length ?? 0}`);
                      if (sj.status === "DONE" || sj.status === "COMPLETED") {
                        ocrText = sj.text ?? "";
                        ocrDone = true;
                        break;
                      }
                      if (sj.status === "FAILED" || sj.status === "ERROR") {
                        console.warn(`[SCANNED-UPGRADE-${upgradeId}] OCR failed status=${sj.status}`);
                        break;
                      }
                    } catch (pollErr: any) {
                      console.warn(`[SCANNED-UPGRADE-${upgradeId}] poll error: ${pollErr?.message}`);
                    }
                  }

                  if (ocrDone && ocrText.trim()) {
                    console.log(`[SCANNED-UPGRADE-${upgradeId}] OCR DONE file="${file.name}" chars=${ocrText.length}`);
                    ocrEntries.push({ filename: file.name, mime_type: file.type || "application/pdf", text: ocrText });
                  } else {
                    console.warn(`[SCANNED-UPGRADE-${upgradeId}] OCR incomplete for "${file.name}" ocrDone=${ocrDone} chars=${ocrText.length} — skipping`);
                  }
                }

                if (ocrEntries.length === 0) {
                  console.warn(`[SCANNED-UPGRADE-${upgradeId}] No OCR results — skipping upgrade`);
                  return;
                }

                // Step 5: Opgradér SAMME besked-boble med OCR-tekst
                console.log(`[SCANNED-UPGRADE-${upgradeId}] Firing upgrade msgId=${_capturedMsgId} files=${ocrEntries.length}`);
                if (!chatMutateRef.current) {
                  console.error(`[SCANNED-UPGRADE-${upgradeId}] chatMutateRef.current is null — cannot upgrade`);
                  return;
                }
                chatMutateRef.current({
                  text:        _capturedText,
                  attachments: [],
                  _documentContextOverride: ocrEntries.map(e => ({
                    filename:       e.filename,
                    mime_type:      e.mime_type,
                    char_count:     e.text.length,
                    extracted_text: e.text.slice(0, 80_000),
                    status:         "ok",
                    source:         "r2_ocr_async",
                  })),
                  _upgradeStreamMsgId: _capturedMsgId,
                });

              } catch (upgradeErr: any) {
                // Guard: don't remove the message bubble on upgrade failure
                console.warn(`[SCANNED-UPGRADE-${upgradeId}] upgrade IIFE error: ${upgradeErr?.message}`);
              }
            })().catch(() => {});

          } else {
            // SLOW (or mixed): run server path for slow files; merge fast results in
            const tDecisionSlow = Date.now();
            const decisionLabel = fastResults.length > 0 ? "MIXED" : "ALL_SLOW";
            console.log(`[TIMING] T1_UPLOAD_RECEIVED t=${tDecisionSlow} +${tDecisionSlow - tClick}ms_since_CLICK files=${slowFiles.length}`);
            console.log(
              `[LIVE][${traceId}] DECISION=${decisionLabel} t=${tDecisionSlow} +${tDecisionSlow - T0}ms` +
              ` slow=${slowFiles.length} fast=${fastResults.length}` +
              ` slowReasons=[${slowFiles.map(s=>s.reason).join(",")}]` +
              ` → T4_AI_START BLOCKED — awaiting R2 upload + OCR finalize`,
            );
            console.log(`[FAST-PATH][${traceId}] DECISION=${decisionLabel}: slow=${slowFiles.length} fast_preloaded=${fastResults.length} — server path starts at t=${tDecisionSlow}`);

            const finalizeResults: any[] = [];
            for (const { af } of slowFiles) {
              const file = af.file;
              const _slowAssetRef = _assetRefs.find(r => r.filename === file.name);

              // Phase 5: if asset has r2Key already, skip presign + R2 PUT (reuse existing objectKey)
              let objectKey: string;
              if (_slowAssetRef?.skipUpload && _slowAssetRef.existingR2Key) {
                objectKey = _slowAssetRef.existingR2Key;
                console.log(`[ASSETS][DEDUP] SLOW SKIP_R2 file="${file.name}" assetId=${_slowAssetRef.assetId} existingR2Key=${objectKey}`);
              } else {
                console.log(`[TRACE-2e][${traceId}] requesting presigned URL for ${file.name} (${file.size}b)`);
                const urlRes = await apiRequest("POST", "/api/upload/url", {
                  filename:    file.name,
                  contentType: file.type || "application/octet-stream",
                  size:        file.size,
                  context:     "chat",
                });
                if (!urlRes.ok) {
                  const errBody = await urlRes.json().catch(() => ({})) as any;
                  throw Object.assign(new Error(errBody?.message ?? "Fil kunne ikke klargøres til upload."), { errorCode: "PRESIGN_FAILED" });
                }
                const presignData = await urlRes.json() as { uploadUrl: string; objectKey: string; expiresIn: number };
                objectKey = presignData.objectKey;

                const r2Res = await fetch(presignData.uploadUrl, {
                  method:  "PUT",
                  body:    file,
                  headers: { "Content-Type": file.type || "application/octet-stream" },
                });
                if (!r2Res.ok) {
                  throw Object.assign(new Error("Fil upload fejlede. Prøv igen."), { errorCode: "R2_UPLOAD_FAILED" });
                }
                // Phase 2+3: patch asset row med r2Key efter vellykket R2 upload
                if (_slowAssetRef) {
                  patchAssetR2KeyFF(_slowAssetRef.assetId, objectKey, file).catch(() => {});
                }
              }

              const tFinalizeStart = Date.now();
              console.log(`[TIMING] FINALIZE_START t=${tFinalizeStart} +${tFinalizeStart - tClick}ms_since_CLICK file="${file.name}"`);
              const isVideoMime = (file.type || "").startsWith("video/");
              if (isVideoMime) setOcrStatusLabel(`Analyserer video: ${file.name}`);
              const finalRes = await apiRequest("POST", "/api/upload/finalize", {
                objectKey,
                filename:    file.name,
                contentType: file.type || "application/octet-stream",
                size:        file.size,
                context:     "chat",
                fileCount:   slowFiles.length,
                questionText: payload.text?.trim() || undefined,
              });
              if (isVideoMime) setOcrStatusLabel(null);
              if (!finalRes.ok) {
                const errBody = await finalRes.json().catch(() => ({})) as any;
                throw Object.assign(new Error(errBody?.message ?? "Dokument kunne ikke behandles."), { errorCode: "FINALIZE_FAILED" });
              }
              const finalData = await finalRes.json() as { mode: string; results?: any[]; message?: string; taskId?: string };
              const tFinalizeDone = Date.now();
              console.log(`[TIMING] FINALIZE_DONE t=${tFinalizeDone} +${tFinalizeDone - tClick}ms_since_CLICK mode=${finalData.mode} file="${file.name}"`);

              // B_FALLBACK for video = Gemini fejlede — tillad fortsat med tom context i stedet for hård fejl
              if (finalData.mode === "B_FALLBACK") {
                if (isVideoMime) {
                  console.warn(`[VID][${traceId}] Gemini video-analyse fejlede for "${file.name}": ${finalData.message}`);
                  finalizeResults.push({
                    filename:       file.name,
                    mime_type:      file.type || "video/mp4",
                    char_count:     0,
                    extracted_text: `[Video-fil: ${file.name} — kunne ikke analyseres automatisk. Beskriv venligst hvad du ser i videoen, eller stil et generelt spørgsmål.]`,
                    status:         "ok",
                    source:         "video_fallback",
                  });
                } else {
                  throw Object.assign(new Error(finalData.message ?? "OCR-systemet er ikke tilgængeligt."), { errorCode: "DOCUMENT_UNREADABLE" });
                }
              }

              if (finalData.mode === "OCR_PENDING" && finalData.taskId) {
                const taskId = finalData.taskId;
                console.log(`[TRACE-2ocr][${traceId}] OCR_PENDING taskId=${taskId} SSE-subscribe...`);

                const OCR_TIMEOUT = 360_000;
                const ocrStart    = Date.now();
                let ocrResult: any = null;
                let ocrHandled = false;

                const stageLabel = (stage: string | null | undefined): string => {
                  if (!stage) return "Analyserer dokument";
                  if (stage === "ocr")       return "Læser tekst via AI";
                  if (stage === "chunking")  return "Opdeler tekst";
                  if (stage === "embedding") return "Indekserer indhold";
                  if (stage === "storing")   return "Gemmer indhold";
                  return "Behandler";
                };

                const tOcrStart = Date.now();
                console.log(`[TIMING] T2_OCR_START t=${tOcrStart} +${tOcrStart - tClick}ms_since_CLICK taskId=${taskId} file="${file.name}"`);
                console.log(`[TIMING] OCR_STATUS_POLL_START t=${tOcrStart} +${tOcrStart - tClick}ms_since_CLICK taskId=${taskId} file="${file.name}"`);
                console.log(`[UI] UI_PROCESSING_CARD_CREATED t=${tOcrStart} +${tOcrStart - tClick}ms_since_CLICK file="${file.name}" traceId=${traceId}`);
                setOcrStatusLabel("Behandler dokument…");

                let sseResolved = false;
                let sseError: Error | null = null;
                try {
                  const token = await getSessionToken();
                  const sseHeaders: Record<string, string> = { Accept: "text/event-stream" };
                  if (token) sseHeaders["Authorization"] = `Bearer ${token}`;

                  const sseRes = await fetch(`/api/ocr-task-stream?taskId=${encodeURIComponent(taskId)}`, {
                    headers: sseHeaders,
                    credentials: "include",
                    signal: AbortSignal.timeout(OCR_TIMEOUT),
                  });

                  if (sseRes.ok && sseRes.body) {
                    const reader  = sseRes.body.getReader();
                    const decoder = new TextDecoder();
                    let   buf     = "";

                    outer: while (true) {
                      const { done, value } = await reader.read();
                      if (done) break;
                      buf += decoder.decode(value, { stream: true });
                      const lines = buf.split("\n");
                      buf = lines.pop() ?? "";

                      for (const line of lines) {
                        if (!line.startsWith("data:")) continue;
                        let evt: any;
                        try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }

                        const { type, data } = evt;
                        if (!type || !data) continue;

                        if (type !== "keepalive") {
                          console.log(`[OCR:SSE] taskId=${taskId} type=${type} charCount=${data.charCount ?? "-"} stage=${data.stage ?? "-"}`);
                        }

                        if (type === "partial_ready") {
                          if (!data.ocrText?.trim()) {
                            console.warn(`[OCR:partial_ready] taskId=${taskId} ocrText=EMPTY — ignoring, waiting for completed`);
                          // continue SSE loop — do not generate provisional from empty text
                          continue;
                        }
                        const partialText = (data.ocrText as string).slice(0, 80_000);

                        // Client-side gate removed: server already applied deterministic
                        // partial-readiness policy before emitting partial_ready.
                        // Always forward partial text immediately for provisional answer.

                        // Build document_context directly — do NOT rely on ocrResult fallthrough chain.
                        // ocrHandled = true skips the post-SSE ocrResult→finalizeResults block.
                        finalizeResults.push({
                          filename:       file.name,
                          mime_type:      file.type || "application/pdf",
                          char_count:     data.charCount ?? partialText.length,
                          extracted_text: partialText,
                          status:         "ok",
                          source:         "ocr_partial",
                        });
                        ocrHandled = true;
                        ocrResult = { status: "running", stage: "partial_ready" }; // sentinel: passes !ocrResult check
                        pendingOcrUpgradeRef.current = { taskId, filename: file.name, mime: file.type || "application/pdf" };
                        setOcrStatusLabel(null);
                        console.log(`[OCR:partial_ready] taskId=${taskId} chars=${data.charCount} — provisional queued, upgrade ref set`);
                        sseResolved = true;
                        reader.cancel().catch(() => {});
                        break outer;
                      }

                      // ── TASK 6: completed is NEVER gated — runs unconditionally ───────────
                      if (type === "completed") {
                        // completed event contains ocrText (full document).
                        // Gate cannot reach this branch — it only runs inside partial_ready above.
                        console.log(`[OCR:completed] taskId=${taskId} inline_ocrText=${data.ocrText?.trim() ? "YES" : "NO"} chars=${data.charCount ?? 0}`);
                        if (data.ocrText?.trim()) {
                          ocrResult = { ocrText: data.ocrText, charCount: data.charCount, status: "completed", stage: "completed" };
                          console.log(`[OCR:completed] taskId=${taskId} ocrText=YES chars=${data.charCount} — using inline text`);
                        } else {
                          // completed but no inline text — retry fetching from /api/ocr-status
                          // DB write can be slightly delayed; up to 3 retries with 2s gaps.
                          console.log(`[OCR:completed] taskId=${taskId} ocrText=NO — fetching from /api/ocr-status (up to 3 retries)`);
                          const FETCH_RETRIES = 3;
                          for (let ri = 1; ri <= FETCH_RETRIES; ri++) {
                            if (ri > 1) {
                              console.log(`[OCR:completed] taskId=${taskId} fallback retry ${ri}/${FETCH_RETRIES} — waiting 2s`);
                              await new Promise(r => setTimeout(r, 2_000));
                            }
                            const sr = await apiRequest("GET", `/api/ocr-status?id=${taskId}`).catch(() => null);
                            const fetched: any = sr ? await sr.json().catch(() => null) : null;
                            const fetchedLen = fetched?.ocrText?.length ?? 0;
                            console.log(`[OCR:completed] taskId=${taskId} fallback fetch retry=${ri} fetched_chars=${fetchedLen} status=${fetched?.status ?? "null"}`);
                            if (fetched?.ocrText?.trim()) {
                              ocrResult = fetched;
                              break;
                            }
                          }
                          if (!ocrResult) {
                            // All retries exhausted — proceed with empty sentinel so post-processing throws DOCUMENT_UNREADABLE
                            console.error(`[OCR:completed] taskId=${taskId} ocrText=EMPTY after ${FETCH_RETRIES} retries — pipeline will surface error`);
                            ocrResult = { status: "completed", charCount: data.charCount };
                          }
                        }
                        sseResolved = true;
                        reader.cancel().catch(() => {});
                        break outer;
                      }
                      if (type === "error") {
                        console.warn(`[OCR:SSE error] taskId=${taskId} message="${data.message}" fallback=${data.fallback}`);
                        sseResolved = true;   // prevent polling fallback from starting
                        if (data.fallback) {
                          // PHASE A — OCR failed but server provides fallback path.
                          // Continue chat pipeline with synthetic "document unreadable" context.
                          ocrResult = {
                            status:       "unsupported",
                            fallback:     true,
                            reason:       "ocr_failed",
                            questionText: data.questionText ?? "",
                            filename:     data.filename ?? file.name,
                            message:      data.message ?? "Dokumentet kunne ikke læses",
                            ocrText:      null,
                            charCount:    0,
                          };
                          console.log(`[OCR:SSE error] taskId=${taskId} fallback=true — continuing with synthetic context`);
                        } else {
                          sseError = Object.assign(
                            new Error(data.message ?? "OCR-job fejlede — prøv at uploade filen igen"),
                            { errorCode: "DOCUMENT_UNREADABLE" },
                          );
                        }
                        reader.cancel().catch(() => {});
                        break outer;
                      }
                      if (type === "keepalive") {
                        const elapsedSec = Math.round((Date.now() - ocrStart) / 1000);
                        setOcrStatusLabel(`Læser tekst via AI: ${file.name} (${elapsedSec}s)`);
                      } else if (type !== "partial_ready" && type !== "completed" && type !== "error") {
                        // Catch-all: log unrecognized event types so protocol changes are visible
                        console.warn(`[OCR:SSE] taskId=${taskId} unrecognized event type="${type}" — ignored`);
                      }
                    }
                  }
                }
              } catch (sseErr: any) {
                console.warn(`[TRACE-2ocr][${traceId}] SSE fejlede (falder tilbage til polling): ${sseErr?.message}`);
              }

              // ── Polling-fallback: bruges hvis SSE fejlede ──────────────────
              if (!sseResolved) {
                console.log(`[TRACE-2ocr][${traceId}] SSE-fallback: starter polling for taskId=${taskId}`);
                while (Date.now() - ocrStart < OCR_TIMEOUT) {
                  const elapsed = Date.now() - ocrStart;
                  const pollMs  = elapsed < 10_000 ? 1_500 : elapsed < 30_000 ? 3_000 : 6_000;
                  await new Promise<void>((r) => setTimeout(r, pollMs));

                  const elapsedSec = Math.round((Date.now() - ocrStart) / 1000);
                  const pollRes = await apiRequest("GET", `/api/ocr-status?id=${taskId}`).catch((e: any) => {
                    console.warn(`[TRACE-2ocr][${traceId}] poll error: ${e?.message}`);
                    return null;
                  });
                  if (!pollRes) continue;
                  const pollData = await pollRes.json() as any;
                  console.log(`[TRACE-2ocr][${traceId}] poll status=${pollData.status} stage=${pollData.stage ?? "-"} elapsed=${elapsedSec}s`);

                  if (pollData.status === "running" || pollData.status === "pending") {
                    const sLabel   = stageLabel(pollData.stage);
                    const progress = ""; // chunksProcessed progress removed — always 0 for image-based PDFs
                    setOcrStatusLabel(`${sLabel}: ${file.name} (${elapsedSec}s${progress})`);
                  }
                  if (pollData.status === "running" && pollData.stage === "partial_ready" && pollData.ocrText?.trim()) {
                    ocrResult = pollData;
                    // Set upgrade ref so onSuccess starts completed-upgrade SSE (same as SSE path)
                    pendingOcrUpgradeRef.current = { taskId, filename: file.name, mime: file.type || "application/pdf" };
                    setOcrStatusLabel(null);
                    console.log(`[TRACE-2ocr][${traceId}] poll partial_ready chars=${pollData.charCount} — early trigger, upgrade ref set`);
                    break;
                  }
                  if (pollData.status === "completed") { ocrResult = pollData; break; }
                  if (pollData.status === "dead_letter") {
                    setOcrStatusLabel(null);
                    console.error(`[OCR-FAIL][${traceId}] PATH=dead_letter reason="${pollData.errorReason}"`);
                    throw Object.assign(new Error(pollData.errorReason ?? "PDF kan ikke læses — for mange fejlede forsøg"), { errorCode: "DOCUMENT_UNREADABLE" });
                  }
                  if (pollData.status === "failed") {
                    if (pollData.nextRetryAt) {
                      setOcrStatusLabel("Behandler dokument…");
                      continue;
                    }
                    setOcrStatusLabel("Skriver svar…");
                    console.error(`[OCR-FAIL][${traceId}] PATH=failed_no_retry reason="${pollData.errorReason}"`);
                    throw Object.assign(new Error(pollData.errorReason ?? "PDF OCR fejlede"), { errorCode: "DOCUMENT_UNREADABLE" });
                  }
                }
              }

              const tOcrDone = Date.now();
              console.log(`[TIMING] T3_OCR_DONE t=${tOcrDone} +${tOcrDone - tClick}ms_since_CLICK +${tOcrDone - tOcrStart}ms_ocr_elapsed`);
              console.log(
                `[TIMING] OCR_STATUS_POLL_DONE t=${tOcrDone} +${tOcrDone - tClick}ms_since_CLICK` +
                ` +${tOcrDone - tOcrStart}ms_since_POLL_START sseResolved=${sseResolved} ocrStatus=${ocrResult?.status ?? "null"}`,
              );

              // Throw SSE error immediately — exact message from server
              if (sseError) throw sseError;

              setOcrStatusLabel(null);

              if (!ocrResult) {
                console.error(`[OCR-FAIL][${traceId}] PATH=timeout elapsed=360s task never completed`);
                throw Object.assign(new Error("OCR tog for lang tid (>6 min). Prøv igen — store filer kan tage tid."), { errorCode: "DOCUMENT_UNREADABLE" });
              }

              // PHASE A — OCR post-processing (skipped when partial_ready already pushed directly)
              if (!ocrHandled && ocrResult.status === "fallback") {
                const fallbackMsg = ocrResult.message ?? "Ingen læsbar tekst fundet i dokumentet";
                const fallbackFilename = ocrResult.filename ?? file.name;
                console.log(`[TRACE-2ocr][${traceId}] OCR fallback path — building synthetic context for "${fallbackFilename}"`);
                setOcrStatusLabel(null);
                finalizeResults.push({
                  filename:       fallbackFilename,
                  mime_type:      file.type || "application/pdf",
                  char_count:     0,
                  extracted_text: `[DOKUMENT UEGNET TIL TEKSTUDTRÆK: ${fallbackFilename}]\n\n${fallbackMsg}\n\nJeg kunne ikke læse nogen brugbar tekst i dokumentet. Dokumentet kan være scannet, tomt eller uegnet til tekstudtræk. Upload gerne en mere læsbar version eller stil et nyt spørgsmål.`,
                  status:         "unsupported",
                  fallback:       true,
                  reason:         "ocr_failed",
                  source:         "r2_ocr_fallback",
                });
              } else if (!ocrHandled) {
                const ocrText = (ocrResult.ocrText ?? "").slice(0, 80_000);
                if (!ocrText.trim()) {
                  console.error(`[OCR-FAIL][${traceId}] PATH=ocr_empty_text charCount=${ocrResult.charCount} quality=${ocrResult.qualityScore}`);
                  throw Object.assign(new Error("OCR fandt ingen læsbar tekst i dokumentet. Tjek at PDF-filen ikke er krypteret."), { errorCode: "DOCUMENT_UNREADABLE" });
                }

                finalizeResults.push({
                  filename:       file.name,
                  mime_type:      file.type || "application/pdf",
                  char_count:     ocrResult.charCount ?? 0,
                  extracted_text: ocrText,
                  status:         "ok",
                  // Preserve partial marker so server-side safeguard detects partial mode correctly
                  source:         ocrResult.stage === "partial_ready" ? "ocr_partial" : "r2_ocr_async",
                });
              }
              console.log(`[TRACE-2ocr][${traceId}] OCR complete chars=${ocrResult.charCount ?? 0} quality=${ocrResult.qualityScore ?? "-"}`);
            } else if (finalData.results && finalData.results.length > 0) {
              finalizeResults.push(...finalData.results);
            }
          }

          // Merge: fast-extracted files (pre-loaded) + server-processed slow files
          documentContext = [...fastResults, ...finalizeResults];
          console.log(`[FAST-PATH][${traceId}] SLOW_DONE: fast=${fastResults.length} server=${finalizeResults.length} total=${documentContext.length} statuses=[${documentContext.map((r:any)=>r.status).join(",")}] chars=[${documentContext.map((r:any)=>r.extracted_text?.length??0).join(",")}] t=${Date.now()}`);
          if (documentContext.length > 0) {
            console.log(`[FAST-PATH][${traceId}] first200="${(documentContext[0] as any).extracted_text?.slice(0,200)?.replace(/\n/g," ")}"`);
          }

          // HARD STOP: ingen gyldige dokumenter
          // fallback entries (status=unsupported + fallback:true) er gyldige — modellen svarer med "dokument uegnet" besked
          const validEntries = documentContext.filter((r: any) =>
            (r.status === "ok" || (r.status === "unsupported" && r.fallback === true)) && r.extracted_text?.trim()
          );
          if (validEntries.length === 0) {
            const errorEntry = documentContext.find((r: any) => r.status === "error" && r.message);
            const hasOcrSource = documentContext.some((r: any) => r.source === "r2_ocr_async");
            const specificMsg = errorEntry?.message
              ?? (hasOcrSource ? "OCR fandt ingen læsbar tekst i dokumentet." : "Dokumentet indeholder ingen læsbar tekst. Kontrollér at filen ikke er krypteret eller tom.");
            console.error(`[OCR-FAIL][${traceId}] PATH=empty_extracted_text entries=${documentContext.length} chars=[${documentContext.map((r:any)=>r.extracted_text?.length??0).join(",")}] statuses=[${documentContext.map((r:any)=>r.status).join(",")}] hasOcr=${hasOcrSource} — ${specificMsg}`);
            throw Object.assign(new Error(specificMsg), { errorCode: "DOCUMENT_UNREADABLE" });
          }
          } // close else (ALL SLOW path)
        } catch (e: any) {
          if (!isUpgradeReuse) {
            setMessages(prev => prev.filter(m => m.id !== streamMsgId));
          } else {
            setMessages(prev => prev.map(m =>
              m.id === streamMsgId ? { ...m, isStreaming: false } : m
            ));
          }
          if (e?.errorCode) throw e;
          console.error(`[HARD-STOP][${traceId}] UPLOAD_PIPELINE_FAILED:`, e);
          throw Object.assign(new Error("Upload fejlede. Prøv igen."), { errorCode: "DOCUMENT_UNREADABLE" });
        }
      } else {
        console.log(`[TRACE-2-SKIP][${traceId}] no doc files — skipping upload`);
      }

      // ── Step A2: Billeder → base64 vision context ─────────────────────────
      // Bypasses grounded_chat gate (hasVision=true) + uses existing gpt-4o-mini vision path.
      // No OCR, no R2 upload — inline base64 via canvas resize (max 1200px, 0.7 quality).
      if (imgFiles.length > 0) {
        const tImgStart = Date.now();
        console.log(`[IMG][${traceId}] ATTACH_IMAGE_RECEIVED files=${imgFiles.length} names=[${imgFiles.map(a=>a.file.name).join(",")}]`);
        for (const af of imgFiles) {
          const file = af.file;
          console.log(`[IMG][${traceId}] ATTACHMENT_RECEIVED name="${file.name}" MIME_TYPE="${file.type}" FILE_SIZE=${file.size} CLASSIFIED_AS=image ROUTE_SELECTED=vision_base64`);
          const base64 = await resizeImageToBase64(file);
          if (base64) {
            console.log(`[IMG][${traceId}] UPLOAD_DONE name="${file.name}" base64_bytes=${base64.length} VALIDATION_PASSED=true PROCESSING_STARTED=vision`);
            const _imgPlaceholder = `[vision_image: ${file.name}]`;
            documentContext.push({
              filename:       file.name,
              mime_type:      file.type || "image/jpeg",
              char_count:     _imgPlaceholder.length,
              extracted_text: _imgPlaceholder,
              status:         "ok",
              source:         "vision_image",
              vision_images:  [base64],
            });
          } else {
            console.warn(`[IMG][${traceId}] PROCESSING_FAILED name="${file.name}" VALIDATION_FAILED=resize_error`);
          }
        }
        console.log(`[IMG][${traceId}] IMAGE_CONTEXT_BUILT entries=${documentContext.filter((d:any)=>d.source==="vision_image").length} +${Date.now()-tImgStart}ms`);
      }

      // Video-filer håndteres nu via docFiles (a.type === "video" inkluderet i docFiles filter)
      // → classifyForFastExtract returnerer "unsupported" → slowFiles → R2 upload → finalize
      // → server/lib/chat/direct-attachment-processor.ts → extractWithGemini (Gemini 2.5 Flash video-analyse)

      // ── Step B: Byg besked-tekst ───────────────────────────────────────────
      const fullMessage = payload.text || "Analysér venligst det uploadede dokument.";

      // ── Phase 5.5: persist text-based context for follow-up continuity ────────
      // Only update when new files were just processed (docFiles > 0).
      // Vision images are excluded — text only, safe to resend across turns.
      if (docFiles.length > 0) {
        const _textCtx = documentContext.filter((r: any) =>
          typeof r.extracted_text === "string" && r.extracted_text.length > 0 && !Array.isArray(r.vision_images),
        );
        if (_textCtx.length > 0) {
          activeDocumentContextRef.current = _textCtx;
          console.log(
            `[ASSETS] THREAD_ACTIVE_ASSETS_FOUND thread=${chatSessionIdRef.current.slice(0,8)}` +
            ` count=${_textCtx.length} sources=[${_textCtx.map((r:any)=>r.source).join(",")}]`,
          );
        }
      }

      // ── TRACE STAGE 3: CHAT REQUEST (streaming) ───────────────────────────
      const T4 = Date.now();
      console.log(
        `[LIVE][${traceId}] T4_AI_START t=${T4} +${T4 - T0}ms` +
        ` context_entries=${documentContext.length}` +
        ` sources=[${documentContext.map((r: any) => r.source).join(",")}]` +
        ` totalDocChars=${documentContext.reduce((s:number,r:any)=>s+(r.char_count??r.extracted_text?.length??0),0)}` +
        ` — /api/chat-stream fires NOW`,
      );
      console.log(`[FAST-PATH][${traceId}] AI_START: context_entries=${documentContext.length} sources=[${documentContext.map((r:any)=>r.source).join(",")}] t=${T4} — sending to /api/chat-stream now`);
      console.log(`[TIMING] T4_MODEL_START t=${T4} +${T4 - tClick}ms_since_CLICK`);
      // Phase 5.5: grounding telemetry
      if (documentContext.length > 0 && docFiles.length === 0) {
        console.log(`[ASSETS] GROUNDED_CONTEXT_FROM_THREAD thread=${chatSessionIdRef.current.slice(0,8)} count=${documentContext.length}`);
      } else if (documentContext.length === 0 && docFiles.length === 0) {
        console.log(`[ASSETS] HARD_GATE_WITHOUT_THREAD_ASSETS thread=${chatSessionIdRef.current.slice(0,8)} — no document context`);
      }

      // ── Step C: SSE-streaming til /api/chat-stream ──────────────────────────
      // For ALL_SLOW: bubble created here (after OCR) — no empty "Skriver..." during OCR.
      // For ALL_FAST: createStreamBubble is idempotent — already created at decision point.
      // For no-doc requests: also created here (~100ms from click).
      createStreamBubble(docFiles.length === 0 ? "NO_DOC" : "ALL_SLOW_or_MIXED");

      let doneData: (ChatResponse & { _trace?: any }) | null = null;

      // Declared outside try so catch/finally can access them
      let streamText = "";
      let chunkCount = 0;

      // AbortController: guarantees loading cannot last forever (90s hard limit)
      const streamAbort = new AbortController();
      const streamTimeout = setTimeout(() => {
        console.warn(`[LIVE][${traceId}] STREAM_TIMEOUT_90S — aborting`);
        streamAbort.abort();
      }, 90_000);

      // "no first chunk" safety — vision (Gemini) gets 45s, all other paths get 10s
      // Gemini multimodal processes images before first token → needs more headroom
      const hasVisionRequest = documentContext.some((r: any) => Array.isArray(r.vision_images) && r.vision_images.length > 0);
      const firstChunkDeadlineMs = hasVisionRequest ? 45_000 : 10_000;
      let firstChunkReceived = false;
      const firstChunkTimeout = setTimeout(() => {
        if (!firstChunkReceived) {
          console.warn(`[LIVE][${traceId}] STREAM_NO_FIRST_CHUNK_${firstChunkDeadlineMs}MS — aborting hasVision=${hasVisionRequest}`);
          streamAbort.abort();
        }
      }, firstChunkDeadlineMs);

      try {
        const tFetchStart = Date.now();
        console.log(
          `[TIMING] CHAT_FETCH_START t=${tFetchStart} +${tFetchStart - tClick}ms_since_CLICK` +
          ` +${tFetchStart - T0}ms_since_MUTATIONFN_START`,
        );
        console.log(
          `[LIVE][${traceId}] FETCH_START t=${tFetchStart} +${tFetchStart - T0}ms` +
          ` — POST /api/chat-stream`,
        );

        // Use statically-imported getSessionToken (already imported at top of file)
        // DO NOT use dynamic import() here — if it fails, the finally block is bypassed
        // and the streaming placeholder stays stuck as isStreaming: true forever.
        const sessionToken = await getSessionToken().catch(() => null);

        const res = await fetch("/api/chat-stream", {
          method:  "POST",
          headers: {
            "Content-Type": "application/json",
            ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
          },
          credentials: "include",
          signal: streamAbort.signal,
          body: JSON.stringify({
            message: fullMessage,
            conversation_id: conversationId ?? null,
            document_context: documentContext,
            context: {
              document_ids: payload.documentIds ?? [],
              preferred_expert_id: null,
            },
            idempotency_key: payload.triggerKey
              ? `${payload.triggerKey}:${fullMessage.slice(0, 64)}`
              : traceId,
          }),
        });

        if (!res.ok) {
          let errorCode = "UNKNOWN_ERROR";
          let message   = res.statusText;
          try {
            const body = await res.json() as { error_code?: string; message?: string };
            if (body.error_code) errorCode = body.error_code;
            if (body.message)    message   = body.message;
          } catch { /* non-JSON */ }
          throw Object.assign(new Error(message), { errorCode });
        }

        const tFetchHeaders = Date.now();
        console.log(
          `[TIMING] CHAT_FETCH_HEADERS_RECEIVED t=${tFetchHeaders}` +
          ` +${tFetchHeaders - tClick}ms_since_CLICK +${tFetchHeaders - tFetchStart}ms_since_FETCH_START` +
          ` status=${res.status}`,
        );
        console.log(
          `[LIVE][${traceId}] FETCH_HEADERS_RECEIVED t=${tFetchHeaders}` +
          ` +${tFetchHeaders - tFetchStart}ms_since_FETCH_START` +
          ` status=${res.status}`,
        );

        const reader  = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer     = "";
        let firstChunkLogged  = false;
        let firstRenderLogged = false;
        let streamClosed      = false;

        try {
          while (true) {
            const { done, value } = await reader.read();

            if (done) {
              streamClosed = true;
              console.log(
                `[LIVE][${traceId}] STREAM_CLOSED chunkCount=${chunkCount}` +
                ` textLen=${streamText.length} doneReceived=${!!doneData}` +
                ` +${Date.now() - T0}ms_since_T0`,
              );
              break;
            }

            chunkCount++;
            firstChunkReceived = true; // disarms the 5s no-first-chunk timeout
            if (!firstChunkLogged) {
              firstChunkLogged = true;
              const tFirstChunk = Date.now();
              console.log(`[TIMING] T5_FIRST_TOKEN t=${tFirstChunk} +${tFirstChunk - tClick}ms_since_CLICK +${tFirstChunk - tFetchStart}ms_since_MODEL_START`);
              console.log(`[TIMING] FIRST_CHUNK t=${tFirstChunk} +${tFirstChunk - tClick}ms_since_CLICK +${tFirstChunk - tFetchStart}ms_since_FETCH_START`);
              setOcrStatusLabel(null);
              console.log(
                `[LIVE][${traceId}] FIRST_CHUNK t=${tFirstChunk}` +
                ` +${tFirstChunk - tFetchStart}ms_since_FETCH_START` +
                ` +${tFirstChunk - T0}ms_since_T0` +
                ` bytes=${value?.length ?? 0}`,
              );
            }

            buffer += decoder.decode(value, { stream: true });
            console.log(
              `[LIVE][${traceId}] CHUNK_APPEND chunk=${chunkCount}` +
              ` length=${value?.length ?? 0} bufferLen=${buffer.length}`,
            );

            const lines = buffer.split("\n");
            buffer = lines.pop()!;

            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const raw = line.slice(6).trim();
              if (!raw) continue;
              let event: any;
              try { event = JSON.parse(raw); } catch { continue; }

              if (event.type === "delta") {
                streamText += event.text;
                setMessages(prev => prev.map(m =>
                  m.id === streamMsgId ? { ...m, text: streamText } : m
                ));

                if (!firstRenderLogged && streamText.length > 0) {
                  firstRenderLogged = true;
                  const tFirstRender = Date.now();
                  console.log(`[TIMING] FIRST_RENDER t=${tFirstRender} +${tFirstRender - tClick}ms_since_CLICK textLen=${streamText.length}`);
                  console.log(
                    `[LIVE][${traceId}] FIRST_RENDER t=${tFirstRender}` +
                    ` +${tFirstRender - T0}ms_since_T0` +
                    ` textLen=${streamText.length}`,
                  );
                }
              } else if (event.type === "replace" && event.text) {
                streamText = event.text;
                setMessages(prev => prev.map(m =>
                  m.id === streamMsgId ? { ...m, text: streamText } : m
                ));
              } else if (event.type === "status" && event.text) {
                setOcrStatusLabel(event.text);
              } else if (event.type === "gated") {
                const gatedMsg = event.message ?? "Forespørgslen kan ikke behandles i øjeblikket.";
                setMessages(prev => [
                  ...prev.filter(m => m.id !== streamMsgId),
                  { id: streamMsgId, role: "assistant" as const, text: gatedMsg, timestamp: new Date() },
                ]);
                doneData = {
                  answer: gatedMsg,
                  conversation_id: "",
                  route_type: event.routeType,
                  expert: { id: "", name: "", category: null },
                  used_sources: [], used_rules: [], warnings: [],
                  latency_ms: 0, confidence_band: "unknown",
                  needs_manual_review: false,
                  routing_explanation: event.routeType ?? "gated",
                } as any;
              } else if (event.type === "done") {
                doneData = event as ChatResponse & { _trace?: any };
                const tDoneReceived = Date.now();
                console.log(`[TIMING] T6_RESPONSE_DONE t=${tDoneReceived} +${tDoneReceived - tClick}ms_since_CLICK textLen=${streamText.length}`);
                setOcrStatusLabel(null);
                console.log(`[TIMING] DONE_EVENT_RECEIVED t=${tDoneReceived} +${tDoneReceived - tClick}ms_since_CLICK textLen=${streamText.length}`);
                console.log(
                  `[LIVE][${traceId}] DONE_EVENT_RECEIVED t=${tDoneReceived}` +
                  ` +${tDoneReceived - T0}ms_since_T0` +
                  ` textLen=${streamText.length}` +
                  ` latency_ms=${(event as any).latency_ms ?? "?"}`,
                );
                const isRefined = (event.refinement_generation ?? 1) >= 2;
                setMessages(prev => prev.map(m => {
                  if (m.id === streamMsgId) {
                    return {
                      ...m,
                      text: streamText,
                      isStreaming: false,
                      response: doneData ?? undefined,
                      isProcessingPlaceholder: false,
                    };
                  }
                  if (isRefined && m.role === "assistant" && !m.isError && !m.isStreaming && m.id !== streamMsgId) {
                    return { ...m, isSuperseded: true };
                  }
                  return m;
                }));
                console.log(`[TIMING] FINAL_STATE_COMMITTED t=${Date.now()} +${Date.now() - tClick}ms_since_CLICK`);
                console.log(`[UI] UI_FINAL_COMMIT source=stream t=${Date.now()} +${Date.now() - tClick}ms_since_CLICK traceId=${traceId}`);
                console.log(`[LIVE][${traceId}] FINAL_STATE_COMMITTED +${Date.now() - T0}ms_since_T0`);
              } else if (event.type === "error") {
                throw Object.assign(new Error(event.message ?? "Ukendt fejl"), { errorCode: event.errorCode });
              }
            }
          }
        } finally {
          reader.cancel().catch(() => {});
        }

        // ── Fallback finalizer ────────────────────────────────────────────────
        // If stream closed without a `done` event (network abort, Vercel timeout,
        // function restart mid-stream) but we received content, commit it anyway.
        // This ensures isStreaming is always cleared so the spinner never hangs.
        if (!doneData && streamText.length > 0) {
          console.warn(
            `[LIVE][${traceId}] FALLBACK_FINALIZER — stream closed without done event` +
            ` textLen=${streamText.length} chunkCount=${chunkCount}`,
          );
          doneData = {
            answer: streamText,
            conversation_id: conversationId ?? "",
            route_type: "expert.chat" as any,
            expert: { id: "", name: "", category: null },
            used_sources: [], used_rules: [], warnings: [],
            latency_ms: Date.now() - T0,
            confidence_band: "unknown",
            needs_manual_review: false,
            routing_explanation: "fallback_close",
          } as any;
          setMessages(prev => prev.map(m =>
            m.id === streamMsgId
              ? { ...m, text: streamText, isStreaming: false, isProcessingPlaceholder: false, response: doneData ?? undefined }
              : m,
          ));
          console.log(`[LIVE][${traceId}] FINAL_STATE_COMMITTED via FALLBACK +${Date.now() - T0}ms_since_T0`);
        } else if (!doneData && streamText.length === 0) {
          console.error(`[LIVE][${traceId}] STREAM_EMPTY — no content received, no done event`);
          if (!isUpgradeReuse) {
            setMessages(prev => prev.filter(m => m.id !== streamMsgId));
          } else {
            setMessages(prev => prev.map(m =>
              m.id === streamMsgId ? { ...m, isStreaming: false } : m
            ));
          }
          throw Object.assign(new Error("Ingen svar modtaget fra serveren."), { errorCode: "EMPTY_STREAM" });
        }

      } catch (streamErr) {
        // If the stream errors without a done event, commit whatever was received
        // (if any) so the spinner never hangs — then rethrow for onError handling.
        if (!doneData) {
          if (streamText.length > 0) {
            console.warn(`[LIVE][${traceId}] STREAM_ERROR_PARTIAL — committing partial text textLen=${streamText.length}`);
            setMessages(prev => prev.map(m =>
              m.id === streamMsgId
                ? { ...m, text: streamText, isStreaming: false, isProcessingPlaceholder: false }
                : m,
            ));
            // Don't rethrow — partial answer is better than error for network glitches
            doneData = {
              answer: streamText, conversation_id: conversationId ?? "",
              route_type: "expert.chat" as any,
              expert: { id: "", name: "", category: null },
              used_sources: [], used_rules: [], warnings: [],
              latency_ms: Date.now() - T0, confidence_band: "unknown",
              needs_manual_review: false, routing_explanation: "partial_stream_error",
            } as any;
          } else {
            if (!isUpgradeReuse) {
              setMessages(prev => prev.filter(m => m.id !== streamMsgId));
            } else {
              setMessages(prev => prev.map(m =>
                m.id === streamMsgId ? { ...m, isStreaming: false } : m
              ));
            }
            throw streamErr;
          }
        }
      } finally {
        clearTimeout(streamTimeout);
        clearTimeout(firstChunkTimeout);
        // Ultimate safety net: ensure isStreaming is NEVER left as true
        setMessages(prev => prev.map(m =>
          m.id === streamMsgId && m.isStreaming ? { ...m, isStreaming: false } : m,
        ));
      }

      // ── TRACE STAGE 5: SERVER RESPONSE ────────────────────────────────────
      if (doneData) {
        console.log(`[TRACE-5][${traceId}] streaming done conversation_id=${doneData.conversation_id} answer_len=${doneData.answer?.length}`);
      }

      return doneData ?? ({ answer: "", conversation_id: "", expert: { id: "", name: "", category: null }, used_sources: [], used_rules: [], warnings: [], latency_ms: 0, confidence_band: "unknown", needs_manual_review: false, routing_explanation: "" } as ChatResponse);
    },
    onSuccess: (data) => {
      // Besked er allerede tilføjet til messages via streaming-callback.
      // Her sætter vi kun conversationId og rydder OCR-status.
      if (data?.conversation_id) setConversationId(data.conversation_id);

      if (isUpgradeAttemptRef.current) {
        isUpgradeAttemptRef.current = false;
        console.log(`[upgrade] onSuccess — upgrade mutation completed successfully`);
      }

      // ── UPGRADE: polling-based OCR completion detection (SSE through Vercel proxy is unreliable) ──
      const upgrade = pendingOcrUpgradeRef.current;
      if (upgrade) {
        pendingOcrUpgradeRef.current = null;
        const { taskId, filename, mime } = upgrade;
        const upgradeId = crypto.randomUUID().slice(0, 8);
        console.log(`[UPGRADE-${upgradeId}] Starting upgrade flow taskId=${taskId}`);
        // Processing card in message bubble handles the visual — no need for bottom status label
        (async () => {
          const label = `[upgrade:${taskId.slice(-8)}]`;
          const clearProcessingPlaceholder = () => {
            setMessages(prev => prev.map(m =>
              m.isProcessingPlaceholder ? { ...m, isProcessingPlaceholder: false } : m
            ));
          };
          try {
            const token = await getSessionToken().catch(() => null);

            // ── Helper: fire the upgrade chat mutation ──
            const triggerUpgrade = (fullText: string) => {
              console.log(`[UPGRADE-${upgradeId}] triggerUpgrade chars=${fullText.length} hasMutate=${!!chatMutateRef.current}`);
              console.log(`[UI] UI_FINAL_COMMIT source=legacy_replacement t=${Date.now()} upgradeId=${upgradeId}`);
              setOcrStatusLabel(null);
              if (!chatMutateRef.current) {
                console.error(`[UPGRADE-${upgradeId}] chatMutateRef.current is null — cannot fire upgrade`);
                clearProcessingPlaceholder();
                return;
              }
              isUpgradeAttemptRef.current = true;
              chatMutateRef.current({
                text: payload.text,
                attachments: [],
                _documentContextOverride: [{
                  filename, mime_type: mime,
                  char_count: fullText.length,
                  extracted_text: fullText.slice(0, 80_000),
                  status: "ok",
                  source: "r2_ocr_async",
                }],
              });
            };

            // ── Helper: poll /api/ocr-status ──
            // Returns: ocrText string (may be empty) if completed, "ERROR" if failed, null if still running
            const pollOnce = async (): Promise<{ done: boolean; text: string; error: boolean }> => {
              try {
                const h: Record<string, string> = {};
                if (token) h["Authorization"] = `Bearer ${token}`;
                const sr = await fetch(`/api/ocr-status?id=${encodeURIComponent(taskId)}`, { headers: h, credentials: "include" });
                if (!sr.ok) {
                  console.warn(`[UPGRADE-${upgradeId}] poll HTTP ${sr.status}`);
                  if (sr.status === 401 || sr.status === 403) return { done: true, text: "", error: true };
                  return { done: false, text: "", error: false };
                }
                const sd = await sr.json() as any;
                console.log(`[UPGRADE-${upgradeId}] poll status=${sd.status} stage=${sd.stage ?? "-"} chars=${(sd.ocrText ?? "").length}`);
                if (sd.status === "completed") {
                  return { done: true, text: sd.ocrText ?? sd.ocr_text ?? "", error: false };
                }
                if (sd.status === "failed" || sd.status === "dead_letter") {
                  return { done: true, text: "", error: true };
                }
              } catch (e) {
                console.warn(`[UPGRADE-${upgradeId}] poll error:`, e);
              }
              return { done: false, text: "", error: false };
            };

            // ── Direct polling for OCR completion ──
            // SSE through Vercel proxy is unreliable (30s timeout). Poll directly instead.
            console.log(`[UPGRADE-${upgradeId}] Starting direct polling`);
            const tStart = Date.now();
            const MAX_MS = 5 * 60 * 1000; // 5 minutes
            let n = 0;
            let upgraded = false;
            while (Date.now() - tStart < MAX_MS) {
              await new Promise(r => setTimeout(r, 2_000));
              n++;
              console.log(`[UPGRADE-${upgradeId}] Poll #${n} t=${Math.round((Date.now()-tStart)/1000)}s`);
              const { done, text, error } = await pollOnce();
              if (error) {
                console.warn(`[UPGRADE-${upgradeId}] OCR failed — aborting upgrade`);
                setOcrStatusLabel(null);
                clearProcessingPlaceholder();
                break;
              }
              if (done) {
                upgraded = true;
                triggerUpgrade(text);
                break;
              }
            }
            if (!upgraded && Date.now() - tStart >= MAX_MS) {
              console.warn(`[UPGRADE-${upgradeId}] Polling timed out after 5 minutes`);
              setOcrStatusLabel(null);
              clearProcessingPlaceholder();
              setMessages(prev => [...prev, {
                id: crypto.randomUUID(), role: "assistant" as const,
                text: "Dokumentanalysen tog for lang tid. Det delvise svar ovenfor er fortsat gyldigt — prøv at sende dit spørgsmål igen for et komplet svar.",
                timestamp: new Date(),
              }]);
            }
          } catch (e) {
            console.error(`[UPGRADE] Upgrade flow error:`, e);
            setOcrStatusLabel(null);
            clearProcessingPlaceholder();
          }
        })();
      } else {
        // No upgrade pending — clear any leftover OCR status from the initial request.
        setOcrStatusLabel(null);
      }
    },
    onError: (err: any) => {
      setOcrStatusLabel(null);
      const code = err?.errorCode ?? err?.code ?? "";
      const serverMsg = err?.message ?? "";

      // Business blocks — render as normal assistant message, no red toast
      const businessBlockMsg =
        code === "DOCUMENT_REQUIRED" || serverMsg.includes("DOCUMENT_REQUIRED")
          ? "Du skal uploade et dokument for at kunne validere."
          : code === "NO_INTERNAL_DATA" || serverMsg.includes("NO_INTERNAL_DATA")
          ? "Jeg kan ikke finde det i jeres interne data."
          : null;

      if (businessBlockMsg) {
        setMessages(prev => [...prev, { id: crypto.randomUUID(), role: "assistant", text: businessBlockMsg, timestamp: new Date() }]);
        return;
      }

      // ── Upgrade-mutation guard ─────────────────────────────────────────────
      // If this error came from the background upgrade mutation (partial → complete),
      // reset the flag and log — but do NOT add an inline message here.
      // The retry loop in the upgrade IIFE handles the final fallback message
      // after all attempts are exhausted, avoiding duplicate error messages.
      if (isUpgradeAttemptRef.current) {
        isUpgradeAttemptRef.current = false;
        console.error(`[upgrade] mutation attempt failed — clearing placeholder. code=${code} msg=${serverMsg.slice(0, 120)}`);
        setMessages(prev => prev.map(m =>
          m.isProcessingPlaceholder ? { ...m, isProcessingPlaceholder: false } : m
        ));
        return;
      }

      // Real errors — show red toast
      const msg = code === "NO_EXPERTS_AVAILABLE" || serverMsg.includes("NO_EXPERTS_AVAILABLE")
        ? "Ingen AI-eksperter er tilgængelige. Aktivér mindst én ekspert til chat i indstillingerne."
        : code === "NO_RELEVANT_EXPERT" || serverMsg.includes("NO_RELEVANT_EXPERT")
        ? "Ingen relevant ekspert fundet. Prøv at omformulere dit spørgsmål."
        : code === "AI_EXECUTION_FAILED"
        ? "AI-eksperten kunne ikke svare i øjeblikket. Prøv igen om lidt."
        : code === "UNAUTHENTICATED"
        ? "Du er ikke logget ind. Genindlæs siden og log ind igen."
        : code === "DOCUMENT_UNREADABLE" || code === "DOCUMENT_CONTEXT_MISSING"
        ? (serverMsg && serverMsg !== "DOCUMENT_UNREADABLE" && serverMsg !== "DOCUMENT_CONTEXT_MISSING"
            ? serverMsg
            : "Dokument kunne ikke læses.")
        : serverMsg || "Der opstod en fejl. Prøv igen.";
      setMessages(prev => [...prev, { id: crypto.randomUUID(), role: "assistant", text: msg, timestamp: new Date(), isError: true }]);
      toast({ title: "Chat fejl", description: msg, variant: "destructive" });
    },
  });

  // Set chatMutateRef so handleAutoTrigger (declared before chatMutation) can use it
  chatMutateRef.current = chatMutation.mutate as typeof chatMutateRef.current;

  // ── Phase 2+3 — promote handler ───────────────────────────────────────────────
  const handlePromoteAsset = useCallback(async (assetId: string, targetKbId: string, userMsgId: string) => {
    setPromotingAssetId(assetId);
    try {
      const res = await apiRequest("POST", `/api/knowledge/assets/${assetId}/promote`, {
        targetKbId,
        retentionMode: "days",
        retentionDays: 365,
        isPinned: false,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as any;
        if (res.status === 409) {
          toast({ title: "Allerede gemt", description: "Dette dokument er allerede i vidensbasen.", variant: "default" });
        } else {
          toast({ title: "Fejl", description: err.error ?? "Kunne ikke gemme til vidensbase.", variant: "destructive" });
        }
        return;
      }
      // Update assetRef scope to persistent_storage in the message
      setMessages(prev => prev.map(m => {
        if (m.id !== userMsgId || !m.assetRefs) return m;
        return { ...m, assetRefs: m.assetRefs.map(r => r.assetId === assetId ? { ...r, scope: "persistent_storage" as const } : r) };
      }));
      toast({ title: "Gemt til vidensbase", description: "Dokumentet er nu tilgængeligt i din vidensbase.", variant: "default" });
    } catch {
      toast({ title: "Fejl", description: "Kunne ikke gemme til vidensbase.", variant: "destructive" });
    } finally {
      setPromotingAssetId(null);
    }
  }, [toast]);

  const handleSend = () => {
    const tClick = Date.now();
    const text = input.trim();
    if ((!text && attachments.length === 0) || chatMutation.isPending) return;
    const displayText = text || (attachments.length === 1 ? `[${attachments[0].file.name}]` : `[${attachments.length} filer vedhæftet]`);
    const useCase = "grounded_chat";
    setIsFastPath(false); // reset before each request
    console.log(
      `[TIMING] USER_SUBMIT_CLICK t=${tClick}` +
      ` attachments=${attachments.length}` +
      ` docFiles=${attachments.filter(a => a.type === "document").length}` +
      ` text_len=${text.length}`,
    );
    const userMsgId = crypto.randomUUID();
    setMessages(prev => [...prev, {
      id: userMsgId,
      role: "user",
      text: displayText,
      attachments: [...attachments],
      timestamp: new Date(),
    }]);
    setOcrStatusLabel("Uploader dokument…");
    chatMutation.mutate({ text: text || "Analysér venligst det uploadede dokument.", attachments, useCase, submitAt: tClick, _userMsgId: userMsgId });
    setInput("");
    setAttachments([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const hasStreamingMessage = messages.some(m => m.isStreaming);
  const isEmpty = messages.length === 0 && !chatMutation.isPending;
  const canSend = (input.trim().length > 0 || attachments.length > 0) && !chatMutation.isPending;

  return (
    <div className="flex flex-col h-full" data-testid="page-ai-chat">

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ACCEPT_ALL}
        className="hidden"
        onChange={handleFileChange}
        data-testid="input-file-upload"
      />

      {/* Header */}
      <div className="shrink-0 px-4 py-2.5 border-b border-border/40 flex items-center gap-2.5">
        <div className="w-6 h-6 rounded-md flex items-center justify-center shrink-0"
          style={{ background: "rgba(34,211,238,0.08)", border: "1px solid rgba(34,211,238,0.15)" }}>
          <Sparkles className="w-3.5 h-3.5 text-primary" />
        </div>
        <div className="min-w-0">
          <h1 className="text-sm font-medium text-foreground">AI Ekspert</h1>
          <p className="text-xs text-muted-foreground/60 truncate">Få svar baseret på jeres egne data, dokumenter og regler.</p>
        </div>
        {conversationId && (
          <Badge variant="outline" className="ml-auto shrink-0 text-xs text-muted-foreground">Aktiv samtale</Badge>
        )}
      </div>

      {/* Thread */}
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        <div className="mx-auto w-full max-w-3xl sm:max-w-4xl min-h-full flex flex-col">
          {isEmpty ? (
            <div className="flex-1 flex items-center justify-center py-8 -translate-y-[10%]">
              {monitorDocumentId && uxState !== "idle" ? (
                <div className="w-full max-w-md space-y-3">
                  <ReadinessStreamBanner
                    uxState={uxState}
                    snapshot={snapshot}
                    isConnected={isConnected}
                    onRefreshAnswer={handleRefreshAnswer}
                  />
                  <EmptyState />
                </div>
              ) : (
                <EmptyState />
              )}
            </div>
          ) : (
            <div className="pt-6">
              {messages.map(msg => (
                <MessageBubble
                  key={msg.id}
                  msg={msg}
                  kbList={kbList}
                  onPromote={handlePromoteAsset}
                  promotingAssetId={promotingAssetId}
                />
              ))}
              {chatMutation.isPending && !ocrStatusLabel && !hasStreamingMessage && <TypingIndicator />}
              {ocrStatusLabel && !isFastPath && (
                <div className="flex gap-3 px-4 py-3" data-testid="status-ocr-pending">
                  <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                    <svg className="w-4 h-4 animate-spin text-primary" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  </div>
                  <div className="flex flex-col gap-1 justify-center">
                    <p className="text-sm font-medium text-foreground">{ocrStatusLabel}</p>
                    <p className="text-xs text-muted-foreground">Svaret opdateres automatisk når dokumentet er fuldt indlæst</p>
                  </div>
                </div>
              )}
              {/* Phase 5Z.3 — Readiness banner shown during/after processing */}
              {monitorDocumentId && (
                <ReadinessStreamBanner
                  uxState={uxState}
                  snapshot={snapshot}
                  isConnected={isConnected}
                  onRefreshAnswer={handleRefreshAnswer}
                />
              )}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Composer area */}
      <div className="shrink-0 border-t border-border px-4 pt-3" style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}>
        <div className="mx-auto max-w-3xl sm:max-w-4xl space-y-2">

          {/* Attachment previews */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-1" data-testid="attachment-preview-area">
              {attachments.map(a => (
                <AttachmentChip key={a.id} file={a} onRemove={() => removeAttachment(a.id)} />
              ))}
            </div>
          )}

          {/* Input row — crisp enterprise style */}
          <div className="flex items-center gap-1.5 bg-background border border-foreground/12 rounded-lg px-3 py-2 focus-within:ring-2 focus-within:ring-primary/20 focus-within:border-primary/40 transition-all shadow-sm">
            <button
              onClick={() => openPicker()}
              disabled={chatMutation.isPending}
              data-testid="button-attach-file"
              className="shrink-0 h-8 w-8 flex items-center justify-center rounded text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted transition-all disabled:opacity-30"
              title="Vedhæft fil"
            >
              <Paperclip className="w-4 h-4" />
            </button>

            <Textarea
              id="chat-input"
              placeholder="Stil et spørgsmål eller upload et dokument…"
              className="flex-1 min-h-[36px] max-h-[140px] resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 text-sm placeholder:text-muted-foreground/40 py-1.5 px-1"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={chatMutation.isPending}
              data-testid="input-chat-message"
            />

            <button
              onClick={handleSend}
              disabled={!canSend}
              data-testid="button-chat-send"
              className={cn(
                "shrink-0 h-8 w-8 flex items-center justify-center rounded transition-all",
                canSend
                  ? "text-primary hover:bg-primary/10"
                  : "text-muted-foreground/30 cursor-not-allowed"
              )}
            >
              <Send className="w-4 h-4" />
            </button>
          </div>

          <p className="text-xs text-muted-foreground/30 text-center">
            Understøtter dokumenter, billeder og tekst · Max {MAX_SIZE_MB} MB
          </p>

        </div>{/* /max-w */}
      </div>
    </div>
  );
}
