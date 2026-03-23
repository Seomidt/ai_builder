import { useState, useRef, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { Send, MessageSquare, Bot, User, ChevronDown, ChevronUp, ShieldAlert, BookOpen, AlertTriangle, Clock, CheckCircle2, HelpCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChatSource {
  id: string;
  name: string;
  sourceType?: string;
}

interface ChatRule {
  id: string;
  title: string;
}

type ConfidenceBand = "high" | "medium" | "low" | "unknown";

interface ChatResponse {
  answer: string;
  conversation_id: string;
  expert: { id: string; name: string; category: string | null };
  used_sources: ChatSource[];
  used_rules: ChatRule[];
  warnings: string[];
  latency_ms: number;
  confidence_band: ConfidenceBand;
  needs_manual_review: boolean;
  routing_explanation: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  response?: ChatResponse;
  timestamp: Date;
  isError?: boolean;
}

// ─── Confidence Badge ──────────────────────────────────────────────────────────

function ConfidenceBadge({ band }: { band: ConfidenceBand }) {
  const map: Record<ConfidenceBand, { label: string; color: string; icon: typeof CheckCircle2 }> = {
    high:    { label: "Høj sikkerhed",   color: "text-green-400 border-green-400/30 bg-green-400/10",  icon: CheckCircle2 },
    medium:  { label: "Middel sikkerhed", color: "text-yellow-400 border-yellow-400/30 bg-yellow-400/10", icon: HelpCircle },
    low:     { label: "Lav sikkerhed",   color: "text-red-400 border-red-400/30 bg-red-400/10",        icon: AlertTriangle },
    unknown: { label: "Ukendt",          color: "text-muted-foreground border-border bg-muted/20",     icon: HelpCircle },
  };
  const { label, color, icon: Icon } = map[band];
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium", color)}>
      <Icon className="w-3 h-3" />
      {label}
    </span>
  );
}

// ─── Answer Card ──────────────────────────────────────────────────────────────

function AnswerCard({ response, text }: { response: ChatResponse; text: string }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails =
    response.used_sources.length > 0 ||
    response.used_rules.length > 0 ||
    response.warnings.length > 0;

  return (
    <div className="space-y-2">
      {/* Expert badge */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-primary bg-primary/10 border border-primary/20 rounded-full px-2.5 py-1">
          <Bot className="w-3 h-3" />
          {response.expert.name}
        </span>
        <ConfidenceBadge band={response.confidence_band} />
        {response.needs_manual_review && (
          <span className="inline-flex items-center gap-1 text-xs text-amber-400 border border-amber-400/30 bg-amber-400/10 rounded-full px-2 py-0.5 font-medium">
            <ShieldAlert className="w-3 h-3" />
            Kræver manuel gennemgang
          </span>
        )}
      </div>

      {/* Warnings */}
      {response.warnings.length > 0 && (
        <div className="space-y-1">
          {response.warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-2 text-xs text-amber-300 bg-amber-400/5 border border-amber-400/20 rounded-lg p-2">
              <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
              {w}
            </div>
          ))}
        </div>
      )}

      {/* Answer text */}
      <div
        className="text-sm leading-relaxed whitespace-pre-wrap text-foreground"
        data-testid="text-chat-answer"
      >
        {text}
      </div>

      {/* Footer row */}
      <div className="flex items-center justify-between pt-1">
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {response.used_sources.length > 0 && (
            <span className="flex items-center gap-1">
              <BookOpen className="w-3 h-3" />
              {response.used_sources.length} {response.used_sources.length === 1 ? "kilde" : "kilder"}
            </span>
          )}
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {response.latency_ms}ms
          </span>
        </div>
        {hasDetails && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            data-testid="button-toggle-details"
          >
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {expanded ? "Skjul detaljer" : "Se detaljer"}
          </button>
        )}
      </div>

      {/* Expandable detail panel */}
      {expanded && (
        <div
          className="rounded-xl border border-border/60 bg-muted/20 p-3 space-y-3 text-xs"
          data-testid="panel-chat-details"
        >
          {response.used_sources.length > 0 && (
            <div>
              <p className="text-muted-foreground font-medium mb-1.5">Kilder brugt</p>
              <div className="space-y-1">
                {response.used_sources.map((s) => (
                  <div key={s.id} className="flex items-center gap-2 text-foreground/80">
                    <BookOpen className="w-3 h-3 text-primary/70 shrink-0" />
                    {s.name}
                  </div>
                ))}
              </div>
            </div>
          )}
          {response.used_rules.length > 0 && (
            <div>
              <p className="text-muted-foreground font-medium mb-1.5">Vigtige forhold</p>
              <div className="space-y-1">
                {response.used_rules.map((r) => (
                  <div key={r.id} className="flex items-center gap-2 text-foreground/80">
                    <ShieldAlert className="w-3 h-3 text-primary/70 shrink-0" />
                    {r.title}
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="pt-1 border-t border-border/40 text-muted-foreground space-y-0.5">
            <div>Ekspert: {response.expert.name}</div>
            {response.expert.category && <div>Domæne: {response.expert.category}</div>}
            <div>Svartid: {response.latency_ms}ms</div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Message Bubble ────────────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: ChatMessage }) {
  if (msg.role === "user") {
    return (
      <div className="flex justify-end" data-testid={`msg-user-${msg.id}`}>
        <div className="flex items-end gap-2 max-w-[80%]">
          <div className="bg-primary/15 border border-primary/20 rounded-2xl rounded-br-sm px-4 py-2.5 text-sm text-foreground">
            {msg.text}
          </div>
          <div className="shrink-0 w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center mb-0.5">
            <User className="w-3.5 h-3.5 text-primary" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start" data-testid={`msg-assistant-${msg.id}`}>
      <div className="flex items-end gap-2 max-w-[85%]">
        <div className="shrink-0 w-7 h-7 rounded-full bg-muted flex items-center justify-center mb-0.5">
          <Bot className="w-3.5 h-3.5 text-primary" />
        </div>
        <Card className={cn(
          "border-border/60 bg-card rounded-2xl rounded-bl-sm",
          msg.isError && "border-red-400/30 bg-red-400/5",
        )}>
          <CardContent className="p-4">
            {msg.isError ? (
              <div className="flex items-start gap-2 text-sm text-red-400">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                {msg.text}
              </div>
            ) : msg.response ? (
              <AnswerCard response={msg.response} text={msg.text} />
            ) : (
              <p className="text-sm text-foreground">{msg.text}</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ─── Typing indicator ──────────────────────────────────────────────────────────

function TypingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="flex items-end gap-2">
        <div className="shrink-0 w-7 h-7 rounded-full bg-muted flex items-center justify-center">
          <Bot className="w-3.5 h-3.5 text-primary" />
        </div>
        <Card className="border-border/60 bg-card rounded-2xl rounded-bl-sm">
          <CardContent className="p-3 flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce [animation-delay:0ms]" />
            <div className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce [animation-delay:150ms]" />
            <div className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce [animation-delay:300ms]" />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ─── Empty State ───────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center flex-1 text-center p-8 select-none" data-testid="empty-state-chat">
      <div
        className="w-16 h-16 rounded-2xl flex items-center justify-center mb-6"
        style={{ background: "rgba(34,211,238,0.12)", border: "1px solid rgba(34,211,238,0.20)" }}
      >
        <MessageSquare className="w-8 h-8 text-primary" />
      </div>
      <h2 className="text-lg font-semibold text-foreground mb-2">Spørg jeres AI Eksperter</h2>
      <p className="text-sm text-muted-foreground max-w-sm leading-relaxed">
        Stil spørgsmål til jeres virksomheds AI eksperter. Svar baseres på jeres data og regler.
      </p>
      <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-md text-left">
        {[
          "Hvad dækker vores forsikringspolitik?",
          "Hvad er reglerne for ferieplanlægning?",
          "Beskriv vores onboarding-proces",
          "Hvad er compliance-kravene for kontraktsindgåelse?",
        ].map((ex, i) => (
          <button
            key={i}
            className="text-xs text-left px-3 py-2 rounded-lg border border-border/60 text-muted-foreground hover:text-foreground hover:border-primary/30 hover:bg-primary/5 transition-all"
            data-testid={`suggestion-${i}`}
            onClick={() => {
              const el = document.getElementById("chat-input") as HTMLTextAreaElement | null;
              if (el) { el.value = ex; el.dispatchEvent(new Event("input", { bubbles: true })); el.focus(); }
            }}
          >
            {ex}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function AiChatPage() {
  const { toast } = useToast();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const chatMutation = useMutation({
    mutationFn: async (message: string) => {
      const res = await apiRequest("POST", "/api/chat", {
        message,
        conversation_id: conversationId ?? null,
        context: { document_ids: [], preferred_expert_id: null },
      });
      return res.json() as Promise<ChatResponse>;
    },
    onSuccess: (data) => {
      setConversationId(data.conversation_id);
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          text: data.answer,
          response: data,
          timestamp: new Date(),
        },
      ]);
    },
    onError: (err: any) => {
      const msg =
        err?.message?.includes("NO_EXPERTS_AVAILABLE")
          ? "Ingen AI-eksperter er opsat for din organisation endnu."
          : err?.message?.includes("NO_RELEVANT_EXPERT")
          ? "Ingen relevant ekspert fundet. Prøv at omformulere dit spørgsmål."
          : "Der opstod en fejl ved behandling af din besked. Prøv igen.";
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          text: msg,
          timestamp: new Date(),
          isError: true,
        },
      ]);
      toast({ title: "Chat fejl", description: msg, variant: "destructive" });
    },
  });

  function handleSend() {
    const text = input.trim();
    if (!text || chatMutation.isPending) return;

    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "user", text, timestamp: new Date() },
    ]);
    setInput("");
    chatMutation.mutate(text);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const isEmpty = messages.length === 0 && !chatMutation.isPending;

  return (
    <div className="flex flex-col h-full max-h-screen" data-testid="page-ai-chat">
      {/* Header */}
      <div className="shrink-0 px-6 py-5 border-b border-border/60 flex items-center gap-3">
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center"
          style={{ background: "rgba(34,211,238,0.12)", border: "1px solid rgba(34,211,238,0.20)" }}
        >
          <MessageSquare className="w-4 h-4 text-primary" />
        </div>
        <div>
          <h1 className="text-base font-bold text-foreground tracking-tight">AI Chat</h1>
          <p className="text-xs text-muted-foreground">Spørg jeres virksomheds AI eksperter</p>
        </div>
        {conversationId && (
          <Badge variant="outline" className="ml-auto text-xs text-muted-foreground">
            Aktiv samtale
          </Badge>
        )}
      </div>

      {/* Thread */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {isEmpty ? (
          <EmptyState />
        ) : (
          <>
            {messages.map((msg) => (
              <MessageBubble key={msg.id} msg={msg} />
            ))}
            {chatMutation.isPending && <TypingIndicator />}
          </>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      <div className="shrink-0 px-4 pb-4 pt-2 border-t border-border/40">
        <div className="flex items-end gap-2 bg-card border border-border/60 rounded-2xl p-2 focus-within:border-primary/40 transition-colors">
          <Textarea
            id="chat-input"
            placeholder="Stil et spørgsmål til jeres AI eksperter…"
            className="flex-1 min-h-[44px] max-h-[160px] resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 text-sm placeholder:text-muted-foreground/60 py-2 px-2"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={chatMutation.isPending}
            data-testid="input-chat-message"
          />
          <Button
            size="icon"
            className="shrink-0 h-9 w-9 rounded-xl"
            onClick={handleSend}
            disabled={!input.trim() || chatMutation.isPending}
            data-testid="button-chat-send"
          >
            <Send className="w-4 h-4" />
          </Button>
        </div>
        <p className="text-xs text-muted-foreground/50 text-center mt-2">
          Enter sender · Shift+Enter for ny linje
        </p>
      </div>
    </div>
  );
}
