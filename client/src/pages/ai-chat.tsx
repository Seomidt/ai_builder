import { useState, useRef, useEffect, useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Send, Bot, User, ChevronDown, ChevronUp, ShieldAlert, BookOpen,
  AlertTriangle, CheckCircle2, HelpCircle, Paperclip, X,
  FileText, Image, Video, Sparkles, Zap, RefreshCw, Clock, WifiOff,
  TrendingUp, Hourglass,
} from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";
import { getSessionToken } from "@/lib/supabase";
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
 * Shows the refinement state of an answer:
 *  gen=1 → Partial (first page only)
 *  gen=2 → Improved (more context added)
 *  gen=3 → Complete (full document)
 */
function RefinementBadge({
  completeness, generation, coverage, cacheHit,
}: {
  completeness?: "partial" | "complete";
  generation?:   number;
  coverage?:     number;
  cacheHit?:     boolean;
}) {
  if (!completeness || completeness === "complete") {
    // Only show if we have a generation marker
    if (!generation || generation < 2) return null;
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

  return (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium text-amber-400 border-amber-400/30 bg-amber-400/10">
      <Hourglass className="w-3 h-3" />Delsvar
      {coverage != null && <span className="opacity-70 ml-0.5">({coverage}%)</span>}
      {cacheHit && <span className="opacity-50 ml-0.5">·cache</span>}
    </span>
  );
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

// ─── Message Bubble ───────────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: ChatMessage }) {
  if (msg.role === "user") {
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
  const bottomRef   = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Phase 5Z.3 — Document readiness monitoring ────────────────────────────
  // Activate when URL contains ?monitorDocumentId=<kb-doc-id>
  const monitorDocumentId = new URLSearchParams(
    typeof window !== "undefined" ? window.location.search : "",
  ).get("monitorDocumentId");

  const autoTriggeredKeysRef = useRef<Set<string>>(new Set());
  // chatMutateRef holds a stable reference to chatMutation.mutate (set after hook declaration)
  const chatMutateRef = useRef<((payload: { text: string; attachments: AttachedFile[]; documentIds?: string[]; triggerKey?: string; _documentContextOverride?: any[] }) => void) | null>(null);
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
    mutationFn: async (payload: { text: string; attachments: AttachedFile[]; useCase?: string; documentIds?: string[]; triggerKey?: string; _documentContextOverride?: any[] }) => {
      const traceId = crypto.randomUUID().slice(0, 8);

      // ── TRACE STAGE 1: FRONTEND SEND ─────────────────────────────────────
      const docFiles = payload.attachments.filter(a => a.type === "document");
      const imgFiles = payload.attachments.filter(a => a.type === "image");
      console.log(`[TRACE-1][${traceId}] use_case="${payload.useCase ?? "grounded_chat"}" attachments_total=${payload.attachments.length} doc_files=${docFiles.length} img_files=${imgFiles.length} names=[${docFiles.map(a=>a.file.name).join(",")}]`);

      // ── Step A: Ekstraher dokumentindhold via direkte R2-upload ───────────
      // Filer uploades ALDRIG igennem Vercel — Browser → R2 direkte via presigned URL.
      // Vercel modtager kun lille JSON (presign-request + finalize-request).
      // _documentContextOverride: bruges til upgrade-chat (partial→complete) — springer upload over.
      let documentContext: any[] = payload._documentContextOverride ?? [];

      if (docFiles.length > 0) {
        try {
          console.log(`[TRACE-2a][${traceId}] starting direct-to-R2 upload for ${docFiles.length} file(s)`);

          // Upload alle doc-filer direkte til R2 og finaliser
          const finalizeResults: any[] = [];

          for (const af of docFiles) {
            const file = af.file;

            // ── 1. Hent presigned URL ─────────────────────────────────────
            console.log(`[TRACE-2b][${traceId}] requesting presigned URL for ${file.name} (${file.size}b)`);
            const urlRes = await apiRequest("POST", "/api/upload/url", {
              filename:    file.name,
              contentType: file.type || "application/octet-stream",
              size:        file.size,
              context:     "chat",
            });
            if (!urlRes.ok) {
              const errBody = await urlRes.json().catch(() => ({})) as any;
              console.error(`[HARD-STOP][${traceId}] presign failed HTTP ${urlRes.status}`, errBody);
              throw Object.assign(new Error(errBody?.message ?? "Fil kunne ikke klargøres til upload."), { errorCode: "PRESIGN_FAILED" });
            }
            const { uploadUrl, objectKey } = await urlRes.json() as { uploadUrl: string; objectKey: string; expiresIn: number };

            // ── 2. Upload fil direkte fra browser til R2 (bypasser Vercel) ─
            console.log(`[TRACE-2c][${traceId}] uploading directly to R2 key=${objectKey}`);
            const r2Res = await fetch(uploadUrl, {
              method:  "PUT",
              body:    file,
              headers: { "Content-Type": file.type || "application/octet-stream" },
            });
            if (!r2Res.ok) {
              console.error(`[HARD-STOP][${traceId}] R2 PUT failed HTTP ${r2Res.status}`);
              throw Object.assign(new Error("Fil upload til lager fejlede. Prøv igen."), { errorCode: "R2_UPLOAD_FAILED" });
            }
            console.log(`[TRACE-2d][${traceId}] R2 upload OK for ${file.name}`);

            // ── 3. Finaliser upload — ekstraher tekst server-side fra R2 ──
            console.log(`[TRACE-2e][${traceId}] finalizing upload for ${file.name}`);
            const finalRes = await apiRequest("POST", "/api/upload/finalize", {
              objectKey,
              filename:    file.name,
              contentType: file.type || "application/octet-stream",
              size:        file.size,
              context:     "chat",
              fileCount:   docFiles.length,
              // PHASE 5Z.7 — question passed at upload time for server-driven orchestration
              questionText: payload.text?.trim() || undefined,
            });
            if (!finalRes.ok) {
              const errBody = await finalRes.json().catch(() => ({})) as any;
              console.error(`[HARD-STOP][${traceId}] finalize failed HTTP ${finalRes.status}`, errBody);
              throw Object.assign(new Error(errBody?.message ?? "Dokument kunne ikke behandles."), { errorCode: "FINALIZE_FAILED" });
            }
            const finalData = await finalRes.json() as { mode: string; results?: any[]; message?: string; taskId?: string };
            console.log(`[TRACE-2f][${traceId}] finalize OK mode=${finalData.mode} results=${finalData.results?.length ?? 0} msg=${finalData.message ?? "-"}`);

            // ── B_FALLBACK: OCR-task creation failed (DB/queue error) ─────
            if (finalData.mode === "B_FALLBACK") {
              const reason = finalData.message ?? "OCR-systemet er ikke tilgængeligt. Prøv igen om lidt.";
              console.error(`[OCR-FAIL][${traceId}] PATH=b_fallback reason="${reason}"`);
              throw Object.assign(new Error(reason), { errorCode: "DOCUMENT_UNREADABLE" });
            }

            // ── OCR_PENDING: scanned PDF → SSE-stream + polling-fallback ─────
            if (finalData.mode === "OCR_PENDING" && finalData.taskId) {
              const taskId = finalData.taskId;
              console.log(`[TRACE-2ocr][${traceId}] OCR_PENDING taskId=${taskId} SSE-subscribe...`);

              const OCR_TIMEOUT = 360_000;
              const ocrStart    = Date.now();
              let ocrResult: any = null;
              let ocrHandled = false; // set true when partial_ready pushes directly to finalizeResults

              // Stage → brugervenlig tekst
              const stageLabel = (stage: string | null | undefined): string => {
                if (!stage) return "Analyserer dokument";
                if (stage === "ocr")       return "Læser tekst via AI";
                if (stage === "chunking")  return "Opdeler tekst";
                if (stage === "embedding") return "Indekserer indhold";
                if (stage === "storing")   return "Gemmer indhold";
                return "Behandler";
              };

              setOcrStatusLabel(`Behandler scannet PDF: ${file.name}`);

              // ── PHASE 5Z.7: SSE-baseret subscription ─────────────────────
              // Forsøger at modtage real-time events fra serveren (nul polling-latency).
              // Falder tilbage til polling-loop hvis SSE ikke virker.
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

                      if (type === "partial_ready" && data.ocrText?.trim()) {
                        // Build document_context directly — do NOT rely on ocrResult fallthrough chain.
                        // ocrHandled = true skips the post-SSE ocrResult→finalizeResults block.
                        const partialText = (data.ocrText as string).slice(0, 80_000);
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
                        console.log(`[TRACE-2ocr][${traceId}] SSE partial_ready chars=${data.charCount} — direct push, bryder øjeblikkeligt`);
                        sseResolved = true;
                        reader.cancel().catch(() => {});
                        break outer;
                      }
                      if (type === "completed") {
                        // completed event indeholder nu ocrText (full dokument)
                        if (data.ocrText?.trim()) {
                          ocrResult = { ocrText: data.ocrText, charCount: data.charCount, status: "completed", stage: "completed" };
                          console.log(`[TRACE-2ocr][${traceId}] SSE completed med ocrText chars=${data.charCount}`);
                        } else {
                          // Fallback: hent via status-endpoint
                          const sr = await apiRequest("GET", `/api/ocr-status?id=${taskId}`).catch(() => null);
                          if (sr?.ok) ocrResult = await sr.json().catch(() => null);
                          if (!ocrResult) ocrResult = { status: "completed", charCount: data.charCount };
                          console.log(`[TRACE-2ocr][${traceId}] SSE completed (status-fetch) chars=${data.charCount}`);
                        }
                        sseResolved = true;
                        reader.cancel().catch(() => {});
                        break outer;
                      }
                      if (type === "error") {
                        console.warn(`[TRACE-2ocr][${traceId}] SSE error event: ${data.message} fallback=${data.fallback}`);
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
                          console.log(`[TRACE-2ocr][${traceId}] SSE fallback path — continuing chat with synthetic context`);
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
                    const progress = pollData.chunksProcessed > 0 ? ` · ${pollData.chunksProcessed} blokke` : "";
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
                      setOcrStatusLabel(`Prøver igen: ${file.name} (forsøg ${(pollData.attemptCount ?? 0) + 1}/${pollData.maxAttempts ?? 3})`);
                      continue;
                    }
                    setOcrStatusLabel(null);
                    console.error(`[OCR-FAIL][${traceId}] PATH=failed_no_retry reason="${pollData.errorReason}"`);
                    throw Object.assign(new Error(pollData.errorReason ?? "PDF OCR fejlede"), { errorCode: "DOCUMENT_UNREADABLE" });
                  }
                }
              }

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

          documentContext = finalizeResults;
          console.log(`[TRACE-2g][${traceId}] total context entries=${documentContext.length} statuses=[${documentContext.map((r:any)=>r.status).join(",")}] chars=[${documentContext.map((r:any)=>r.extracted_text?.length??0).join(",")}]`);
          if (documentContext.length > 0) {
            console.log(`[TRACE-2h][${traceId}] first200="${(documentContext[0] as any).extracted_text?.slice(0,200)?.replace(/\n/g," ")}"`);
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
        } catch (e: any) {
          if (e?.errorCode) throw e; // re-throw hard-stops
          console.error(`[HARD-STOP][${traceId}] UPLOAD_PIPELINE_FAILED:`, e);
          throw Object.assign(new Error("Upload fejlede. Prøv igen."), { errorCode: "DOCUMENT_UNREADABLE" });
        }
      } else {
        console.log(`[TRACE-2-SKIP][${traceId}] no doc files — skipping upload`);
      }

      // ── Step B: Byg besked-tekst ───────────────────────────────────────────
      const fullMessage = payload.text || "Analysér venligst det uploadede dokument.";

      // ── TRACE STAGE 3: CHAT REQUEST (streaming) ───────────────────────────
      console.log(`[TRACE-3][${traceId}] streaming /api/chat/stream message_len=${fullMessage.length} document_context_len=${documentContext.length}`);

      // ── Step C: SSE-streaming til /api/chat/stream ─────────────────────────
      // Tilføj streaming-placeholder INDEN vi sender, så brugeren ser noget med det samme
      const streamMsgId = crypto.randomUUID();
      setMessages(prev => [...prev, {
        id: streamMsgId, role: "assistant" as const,
        text: "", isStreaming: true, timestamp: new Date(),
      }]);

      let doneData: (ChatResponse & { _trace?: any }) | null = null;

      try {
        const res = await apiRequest("POST", "/api/chat/stream", {
          message: fullMessage,
          conversation_id: conversationId ?? null,
          document_context: documentContext,
          context: {
            document_ids: payload.documentIds ?? [],
            preferred_expert_id: null,
          },
          ...(payload.triggerKey ? { idempotency_key: `${payload.triggerKey}:${fullMessage.slice(0, 64)}` } : {}),
        });

        const reader  = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer    = "";
        let streamText = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
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
            } else if (event.type === "status" && event.text) {
              setOcrStatusLabel(event.text);
            } else if (event.type === "gated") {
              // Routing gate: processing/no_context — show as assistant info message
              const gatedMsg = event.message ?? "Forespørgslen kan ikke behandles i øjeblikket.";
              setMessages(prev => [
                ...prev.filter(m => m.id !== streamMsgId),
                { id: streamMsgId, role: "assistant" as const, text: gatedMsg, timestamp: new Date() },
              ]);
              // Synthesise a fake done response so onSuccess/cleanup runs
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
              const isRefined = (event.refinement_generation ?? 1) >= 2;
              setMessages(prev => prev.map(m => {
                if (m.id === streamMsgId) {
                  // Current message: finalise it
                  return { ...m, text: streamText, isStreaming: false, response: doneData ?? undefined };
                }
                // Phase 5Z.5 — supersede earlier assistant answers when a refined one arrives
                if (isRefined && m.role === "assistant" && !m.isError && !m.isStreaming && m.id !== streamMsgId) {
                  return { ...m, isSuperseded: true };
                }
                return m;
              }));
            } else if (event.type === "error") {
              throw Object.assign(new Error(event.message ?? "Ukendt fejl"), { errorCode: event.errorCode });
            }
          }
        }
      } catch (streamErr) {
        // Fjern streaming-placeholder ved fejl — onError tilføjer fejlbesked
        setMessages(prev => prev.filter(m => m.id !== streamMsgId));
        throw streamErr;
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
      setOcrStatusLabel(null);
      // Reset upgrade flag — mutation succeeded (whether initial or upgrade)
      isUpgradeAttemptRef.current = false;

      // ── Upgrade: partial_ready broke the initial SSE → now poll until completed ──
      // Uses pollForCompletedOcr (shared/upgrade-chain.ts) which retries up to 8 min.
      // Replaces the old SSE-based approach which timed out after 90s for large PDFs.
      const upgrade = pendingOcrUpgradeRef.current;
      if (upgrade) {
        pendingOcrUpgradeRef.current = null;
        const { taskId, filename, mime } = upgrade;
        (async () => {
          const label = `[upgrade:${taskId.slice(-8)}]`;
          try {
            console.log(`${label} upgrade started for "${filename}" (polling /api/ocr-status)`);

            // Build a fetchStatus function that calls /api/ocr-status with auth headers.
            const fetchStatus = async (id: string) => {
              const tok = await getSessionToken().catch(() => null);
              const headers: Record<string, string> = tok ? { Authorization: `Bearer ${tok}` } : {};
              const sr = await fetch(
                `/api/ocr-status?id=${encodeURIComponent(id)}`,
                { headers, credentials: "include", signal: AbortSignal.timeout(12_000) },
              );
              if (!sr.ok) throw new Error(`ocr-status HTTP ${sr.status}`);
              return sr.json();
            };

            const fullText = await pollForCompletedOcr(taskId, fetchStatus, {
              deadlineMs:       8 * 60 * 1_000,
              initialPollMs:    3_000,
              maxPollMs:        10_000,
              backoffFactor:    1.4,
              emptyTextRetries: 5,
              emptyTextRetryMs: 2_000,
              logger: ({ level, message, data }) => {
                const msg = `${label} ${message}`;
                if (level === "error")      console.error(msg, data ?? "");
                else if (level === "warn")  console.warn(msg, data ?? "");
                else                        console.log(msg, data ?? "");
              },
            });

            if (!fullText.trim()) {
              console.error(`${label} upgrade aborted — no OCR text after polling`);
              return;
            }
            if (!chatMutateRef.current) {
              console.error(`${label} chatMutateRef is null — cannot launch upgrade mutation`);
              return;
            }

            console.log(`${label} launching full-document mutation chars=${fullText.length}`);
            isUpgradeAttemptRef.current = true;
            chatMutateRef.current({
              text: "Det komplette dokument er nu klar. Giv en opdateret og komplet analyse.",
              attachments: [],
              _documentContextOverride: [{
                filename, mime_type: mime,
                char_count: fullText.length,
                extracted_text: fullText,
                status: "ok",
                source: "r2_ocr_async",
              }],
            });
            console.log(`${label} mutation launched`);
          } catch (err) {
            console.error(`${label} upgrade IIFE threw:`, err);
          }
        })();
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
      // AND there is already a valid partial answer visible, do NOT show an error state.
      // The partial answer remains intact — the user sees a complete response once the
      // upgrade retries or the next interaction triggers it.
      if (isUpgradeAttemptRef.current) {
        isUpgradeAttemptRef.current = false;
        console.warn(`[upgrade] mutation failed (suppressed toast) code=${code} msg=${serverMsg.slice(0, 80)}`);
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

  const handleSend = () => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || chatMutation.isPending) return;
    const displayText = text || (attachments.length === 1 ? `[${attachments[0].file.name}]` : `[${attachments.length} filer vedhæftet]`);
    // Dokument-upload → grounded_chat: svarer spørgsmål direkte fra dokumentindholdet.
    // "validation" bruges kun hvis eksperten eksplicit er en valideringsekspert.
    const useCase = "grounded_chat";
    console.log(`[TRACE-SEND] use_case="${useCase}" attachments=${attachments.length}`);
    setMessages(prev => [...prev, {
      id: crypto.randomUUID(),
      role: "user",
      text: displayText,
      attachments: [...attachments],
      timestamp: new Date(),
    }]);
    chatMutation.mutate({ text: text || "Analysér venligst det uploadede dokument.", attachments, useCase });
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
              {messages.map(msg => <MessageBubble key={msg.id} msg={msg} />)}
              {chatMutation.isPending && !ocrStatusLabel && !hasStreamingMessage && <TypingIndicator />}
              {ocrStatusLabel && (
                <div className="flex items-center gap-2 px-4 py-2 text-sm text-muted-foreground animate-pulse" data-testid="status-ocr-pending">
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  {ocrStatusLabel}
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
