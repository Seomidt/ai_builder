/**
 * LiveAIDemo — Insurance claims workflow simulation
 * Mobile-first, GPU-friendly, no animation libraries, no blur filters.
 * Pure CSS transitions + React state machine.
 */

import { useEffect, useRef, useState, useMemo } from "react";
import {
  Upload, Settings2, Cpu, ShieldAlert, CheckCircle2, Clock, FileText,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface StepLine {
  text: string;
  accent?: "cyan" | "amber" | "emerald" | "red" | "slate";
  completed?: boolean;
}

interface Step {
  id: number;
  icon: React.ReactNode;
  label: string;
  accentColor: "cyan" | "amber" | "emerald" | "violet" | "blue";
  lines: StepLine[];
  duration: number; // ms this step stays active
}

// ─── Step definitions ─────────────────────────────────────────────────────────

const STEPS: Step[] = [
  {
    id: 0,
    icon: <Upload className="w-4 h-4" />,
    label: "Upload",
    accentColor: "cyan",
    duration: 2200,
    lines: [
      { text: "insurance_policy.pdf", accent: "cyan" },
      { text: "claim_documents.zip", accent: "cyan" },
    ],
  },
  {
    id: 1,
    icon: <Settings2 className="w-4 h-4" />,
    label: "Rules",
    accentColor: "amber",
    duration: 2400,
    lines: [
      { text: "Coverage: water damage", accent: "slate" },
      { text: "Max payout: 50,000 DKK", accent: "slate" },
      { text: "Requires documentation", accent: "slate" },
      { text: "Validate claim consistency", accent: "amber" },
    ],
  },
  {
    id: 2,
    icon: <Cpu className="w-4 h-4" />,
    label: "AI Analysis",
    accentColor: "blue",
    duration: 2200,
    lines: [
      { text: "Claim eligible under policy", accent: "emerald" },
      { text: "Documents verified", accent: "emerald" },
      { text: "Risk signals detected: low", accent: "amber" },
    ],
  },
  {
    id: 3,
    icon: <ShieldAlert className="w-4 h-4" />,
    label: "Fraud Check",
    accentColor: "amber",
    duration: 2000,
    lines: [
      { text: "AI-generated text detection: no", accent: "emerald" },
      { text: "Duplicate claim check: passed", accent: "emerald" },
      { text: "Document consistency: valid", accent: "emerald" },
    ],
  },
  {
    id: 4,
    icon: <CheckCircle2 className="w-4 h-4" />,
    label: "Decision",
    accentColor: "cyan",
    duration: 2800,
    lines: [
      { text: "Approved — estimated payout: 32,500 DKK", accent: "cyan" },
      { text: "Confidence: High", accent: "slate" },
      { text: "Source: policy.pdf → section 3.2", accent: "slate" },
    ],
  },
];

// ─── Color maps ───────────────────────────────────────────────────────────────

const STEP_COLORS: Record<string, {
  border: string; bg: string; icon: string; badge: string; badgeBg: string;
}> = {
  cyan:   { border: "border-cyan-500/50",   bg: "bg-cyan-500/5",   icon: "text-cyan-400",   badge: "text-cyan-400",   badgeBg: "bg-cyan-500/10 border border-cyan-500/20" },
  amber:  { border: "border-amber-500/50",  bg: "bg-amber-500/5",  icon: "text-amber-400",  badge: "text-amber-400",  badgeBg: "bg-amber-500/10 border border-amber-500/20" },
  emerald:{ border: "border-emerald-500/50",bg: "bg-emerald-500/5",icon: "text-emerald-400",badge: "text-emerald-400",badgeBg: "bg-emerald-500/10 border border-emerald-500/20" },
  blue:   { border: "border-blue-500/50",   bg: "bg-blue-500/5",   icon: "text-blue-400",   badge: "text-blue-400",   badgeBg: "bg-blue-500/10 border border-blue-500/20" },
  violet: { border: "border-violet-500/50", bg: "bg-violet-500/5", icon: "text-violet-400", badge: "text-violet-400", badgeBg: "bg-violet-500/10 border border-violet-500/20" },
};

const LINE_ACCENT: Record<string, string> = {
  cyan:    "text-cyan-300",
  amber:   "text-amber-400",
  emerald: "text-emerald-400",
  red:     "text-red-400",
  slate:   "text-slate-400",
};

// ─── Component ────────────────────────────────────────────────────────────────

export function LiveAIDemo() {
  const [currentStep, setCurrentStep] = useState(0);
  const [visibleLines, setVisibleLines] = useState(0);
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(new Set());
  const [fading, setFading] = useState(false);
  const [isFinalVisible, setIsFinalVisible] = useState(false);

  const stepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lineTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const LINE_DELAY = 340; // ms between each line appearing

  function clearTimers() {
    if (stepTimerRef.current) clearTimeout(stepTimerRef.current);
    if (lineTimerRef.current) clearTimeout(lineTimerRef.current);
  }

  function revealLines(step: Step, index: number = 0) {
    if (index > step.lines.length) return;
    setVisibleLines(index);
    if (index < step.lines.length) {
      lineTimerRef.current = setTimeout(() => revealLines(step, index + 1), LINE_DELAY);
    }
  }

  function advanceStep(step: number) {
    const current = STEPS[step];
    setFading(false);
    setVisibleLines(0);
    setCurrentStep(step);

    // Reveal lines one by one
    revealLines(current, 0);

    // After duration, mark completed and move to next
    stepTimerRef.current = setTimeout(() => {
      setCompletedSteps((prev) => { const next = new Set(prev); next.add(step); return next; });
      const next = (step + 1) % STEPS.length;

      if (next === 0) {
        // Loop restart: show final result briefly, then restart
        setIsFinalVisible(true);
        stepTimerRef.current = setTimeout(() => {
          setFading(true);
          stepTimerRef.current = setTimeout(() => {
            setIsFinalVisible(false);
            setCompletedSteps(new Set());
            setFading(false);
            advanceStep(0);
          }, 400);
        }, 1200);
      } else {
        advanceStep(next);
      }
    }, current.duration);
  }

  useEffect(() => {
    advanceStep(0);
    return () => clearTimers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentStepData = STEPS[currentStep];
  const colors = STEP_COLORS[currentStepData.accentColor];
  const isFinal = currentStep === STEPS.length - 1;

  const stepIndicators = useMemo(() => STEPS.map((s) => ({
    ...s,
    isComplete: completedSteps.has(s.id) || (isFinalVisible && s.id < STEPS.length),
    isActive: s.id === currentStep,
  })), [completedSteps, currentStep, isFinalVisible]);

  return (
    <div className="w-full max-w-[420px] mx-auto select-none">
      {/* Card */}
      <div className="bg-[#0F1629] border border-white/8 rounded-2xl overflow-hidden shadow-[0_20px_60px_rgba(0,0,0,0.5)]">

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/5 bg-[#0B1020]">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-60" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-500" />
            </span>
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest">Live workflow simulation</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Clock className="w-3 h-3 text-slate-600" />
            <span className="text-[10px] text-slate-600 font-mono">Insurance · Claims</span>
          </div>
        </div>

        {/* Step indicators */}
        <div className="flex items-center gap-0 px-4 pt-4 pb-2">
          {stepIndicators.map((s, i) => {
            const c = STEP_COLORS[s.accentColor];
            return (
              <div key={s.id} className="flex items-center gap-0 flex-1">
                <div className={`
                  flex items-center justify-center w-6 h-6 rounded-full text-[10px] font-bold transition-all duration-300
                  ${s.isComplete ? `bg-emerald-500/15 border border-emerald-500/30 text-emerald-400` : ""}
                  ${s.isActive && !s.isComplete ? `${c.badgeBg} ${c.icon}` : ""}
                  ${!s.isActive && !s.isComplete ? "bg-white/3 border border-white/8 text-slate-600" : ""}
                `}>
                  {s.isComplete ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                  ) : (
                    <span className={s.isActive ? c.icon : "text-slate-600"}>{s.icon}</span>
                  )}
                </div>
                {i < STEPS.length - 1 && (
                  <div className={`flex-1 h-px mx-1 transition-all duration-500 ${s.isComplete ? "bg-emerald-500/30" : "bg-white/6"}`} />
                )}
              </div>
            );
          })}
        </div>

        {/* Active step card */}
        <div
          className={`mx-4 mb-4 mt-2 rounded-xl border transition-all duration-300 overflow-hidden
            ${fading ? "opacity-0 translate-y-1" : "opacity-100 translate-y-0"}
            ${colors.border} ${colors.bg}
          `}
          style={{ minHeight: 120 }}
        >
          {/* Step header */}
          <div className="flex items-center gap-2.5 px-4 pt-3.5 pb-2.5 border-b border-white/5">
            <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${STEP_COLORS[currentStepData.accentColor].badgeBg} ${colors.icon}`}>
              {currentStepData.icon}
            </div>
            <div>
              <div className={`text-[10px] font-bold uppercase tracking-widest ${colors.icon} opacity-70`}>
                Step {currentStep + 1} of {STEPS.length}
              </div>
              <div className="text-white font-semibold text-sm">{currentStepData.label}</div>
            </div>

            {/* Animated progress dots */}
            <div className="ml-auto flex items-center gap-1">
              {[0, 1, 2].map((dot) => (
                <span
                  key={dot}
                  className={`w-1 h-1 rounded-full ${colors.icon} bg-current opacity-40`}
                  style={{
                    animation: `pulse 1.2s ease-in-out ${dot * 0.2}s infinite`,
                  }}
                />
              ))}
            </div>
          </div>

          {/* Lines */}
          <div className="px-4 py-3 space-y-2.5">
            {currentStepData.lines.map((line, i) => (
              <div
                key={i}
                className="flex items-start gap-2.5 transition-all duration-300"
                style={{
                  opacity: i < visibleLines ? 1 : 0,
                  transform: i < visibleLines ? "translateY(0)" : "translateY(4px)",
                  transitionDelay: "0ms",
                }}
              >
                <div className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${
                  line.accent === "emerald" ? "bg-emerald-400" :
                  line.accent === "cyan"    ? "bg-cyan-400" :
                  line.accent === "amber"   ? "bg-amber-400" :
                  line.accent === "red"     ? "bg-red-400" : "bg-slate-600"
                }`} />
                <span className={`text-[13px] font-mono leading-relaxed ${line.accent ? LINE_ACCENT[line.accent] : "text-slate-400"}`}>
                  {line.text}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Final decision bar */}
        <div className={`mx-4 mb-4 transition-all duration-500 ${isFinal && !fading ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2 pointer-events-none"}`}>
          <div className="rounded-xl bg-gradient-to-r from-cyan-600/80 to-blue-600/80 border border-cyan-500/30 px-4 py-3.5 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <CheckCircle2 className="w-5 h-5 text-white shrink-0" />
              <div>
                <div className="text-white font-bold text-sm leading-tight">Approved</div>
                <div className="text-cyan-200/80 text-[11px] font-medium">Estimated payout: 32,500 DKK</div>
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] text-cyan-300/70 font-medium uppercase tracking-wide">Confidence</div>
              <div className="text-white font-bold text-sm">High</div>
            </div>
          </div>
        </div>

        {/* Document source footer */}
        <div className="px-4 pb-4">
          <div className="flex items-center gap-2 bg-white/3 border border-white/5 rounded-lg px-3 py-2">
            <FileText className="w-3.5 h-3.5 text-slate-600 shrink-0" />
            <span className="text-[11px] text-slate-600 font-mono">policy.pdf → section 3.2</span>
            <div className="ml-auto flex items-center gap-1">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-500/60" />
              <span className="text-[10px] text-slate-600">verified</span>
            </div>
          </div>
        </div>
      </div>

      {/* Caption */}
      <p className="text-center text-slate-600 text-xs mt-4 px-4 leading-relaxed">
        From uploaded policies to verified decisions — all in one orchestration layer.
      </p>
    </div>
  );
}
