/**
 * Phase 29 — System Pressure Detection
 * INV-REC8: Pressure detection must be deterministic.
 * Classifies platform load into: normal | elevated | degraded | critical
 */

import { Client } from "pg";

// ── Types ─────────────────────────────────────────────────────────────────────

export type PressureLevel = "normal" | "elevated" | "degraded" | "critical";

export interface PressureSignal {
  name:         string;
  value:        number;
  threshold:    number;
  unit:         string;
  breached:     boolean;
  severity:     "low" | "medium" | "high" | "critical";
}

export interface SystemPressureResult {
  level:        PressureLevel;
  score:        number;          // 0–100 deterministic composite score
  signals:      PressureSignal[];
  criticalCount: number;
  highCount:    number;
  explanation:  string;
  checkedAt:    string;
}

export interface PressureThresholds {
  queueDepth:         { elevated: number; degraded: number; critical: number };
  stalledJobs:        { elevated: number; degraded: number; critical: number };
  webhookFailureRate: { elevated: number; degraded: number; critical: number };
  rateLimitTriggers:  { elevated: number; degraded: number; critical: number };
  jobRetrySpike:      { elevated: number; degraded: number; critical: number };
  failedDeliveryPct:  { elevated: number; degraded: number; critical: number };
}

// ── Default thresholds ────────────────────────────────────────────────────────

export const DEFAULT_THRESHOLDS: PressureThresholds = {
  queueDepth:         { elevated: 50,  degraded: 200,  critical: 500  },
  stalledJobs:        { elevated: 5,   degraded: 20,   critical: 50   },
  webhookFailureRate: { elevated: 10,  degraded: 30,   critical: 60   },
  rateLimitTriggers:  { elevated: 20,  degraded: 50,   critical: 100  },
  jobRetrySpike:      { elevated: 10,  degraded: 25,   critical: 50   },
  failedDeliveryPct:  { elevated: 10,  degraded: 25,   critical: 50   },
};

// ── DB helper ─────────────────────────────────────────────────────────────────

function getClient(): Client {
  return new Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

function num(v: string | null | undefined): number {
  return parseInt(v ?? "0", 10) || 0;
}

// ── Signal collection ─────────────────────────────────────────────────────────

export async function collectPressureSignals(
  thresholds: PressureThresholds = DEFAULT_THRESHOLDS,
  windowMinutes = 60,
): Promise<PressureSignal[]> {
  const client = getClient();
  await client.connect();
  const cutoff = new Date(Date.now() - windowMinutes * 60_000).toISOString();

  try {
    // 1. Queue depth (all queued jobs)
    const queueRes = await client.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM knowledge_processing_jobs WHERE status='queued'`,
    );
    const queueDepth = num(queueRes.rows[0]?.cnt);

    // 2. Stalled jobs (running > 30 min)
    const stalledCutoff = new Date(Date.now() - 30 * 60_000).toISOString();
    const stalledRes = await client.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM knowledge_processing_jobs
       WHERE status='running' AND started_at IS NOT NULL AND started_at < '${stalledCutoff}'`,
    );
    const stalledJobs = num(stalledRes.rows[0]?.cnt);

    // 3. Webhook failure count in window
    const webhookRes = await client.query<{ total: string; failed: string }>(
      `SELECT
         COUNT(*)                                     AS total,
         COUNT(*) FILTER (WHERE status='failed')      AS failed
       FROM webhook_deliveries
       WHERE created_at >= '${cutoff}'`,
    );
    const wTotal  = num(webhookRes.rows[0]?.total);
    const wFailed = num(webhookRes.rows[0]?.failed);
    const webhookFailureRate = wTotal > 0 ? Math.round((wFailed / wTotal) * 100) : 0;

    // 4. Rate-limit triggers in window
    const rateLimitRes = await client.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM request_safety_events
       WHERE event_type ILIKE '%rate_limit%' AND created_at >= '${cutoff}'`,
    );
    const rateLimitTriggers = num(rateLimitRes.rows[0]?.cnt);

    // 5. Job retry spike (jobs with attempt_count > 1 created in window)
    // Proxy: count failed jobs created in window
    const retryRes = await client.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM knowledge_processing_jobs
       WHERE attempt_count > 1 AND status = 'failed'
         AND completed_at >= '${cutoff}'`,
    );
    const jobRetrySpike = num(retryRes.rows[0]?.cnt);

    // 6. Failed delivery percentage for active deliveries
    const deliveryRes = await client.query<{ total: string; failed: string }>(
      `SELECT
         COUNT(*)                                                 AS total,
         COUNT(*) FILTER (WHERE status IN ('failed','retrying')) AS failed
       FROM webhook_deliveries
       WHERE last_attempt_at >= '${cutoff}'`,
    );
    const dTotal  = num(deliveryRes.rows[0]?.total);
    const dFailed = num(deliveryRes.rows[0]?.failed);
    const failedDeliveryPct = dTotal > 0 ? Math.round((dFailed / dTotal) * 100) : 0;

    const classify = (
      name: string, value: number, unit: string,
      tiers: { elevated: number; degraded: number; critical: number },
    ): PressureSignal => {
      const severity: PressureSignal["severity"] =
        value >= tiers.critical ? "critical" :
        value >= tiers.degraded ? "high"     :
        value >= tiers.elevated ? "medium"   : "low";
      return {
        name, value, threshold: tiers.elevated, unit,
        breached: value >= tiers.elevated,
        severity,
      };
    };

    return [
      classify("queue_depth",          queueDepth,        "jobs",    thresholds.queueDepth),
      classify("stalled_jobs",         stalledJobs,       "jobs",    thresholds.stalledJobs),
      classify("webhook_failure_rate", webhookFailureRate,"%",       thresholds.webhookFailureRate),
      classify("rate_limit_triggers",  rateLimitTriggers, "events",  thresholds.rateLimitTriggers),
      classify("job_retry_spike",      jobRetrySpike,     "jobs",    thresholds.jobRetrySpike),
      classify("failed_delivery_pct",  failedDeliveryPct, "%",       thresholds.failedDeliveryPct),
    ];
  } finally {
    await client.end();
  }
}

// ── Pressure classification (deterministic) ───────────────────────────────────

export function classifyPressureLevel(signals: PressureSignal[]): {
  level: PressureLevel;
  score: number;
} {
  const criticalCount = signals.filter(s => s.severity === "critical").length;
  const highCount     = signals.filter(s => s.severity === "high").length;
  const mediumCount   = signals.filter(s => s.severity === "medium").length;

  // Deterministic score: weighted sum
  const score = Math.min(100, criticalCount * 40 + highCount * 20 + mediumCount * 8);

  const level: PressureLevel =
    criticalCount >= 2 ? "critical" :
    criticalCount >= 1 ? "degraded" :
    highCount >= 2     ? "degraded" :
    highCount >= 1     ? "elevated" :
    mediumCount >= 2   ? "elevated" : "normal";

  return { level, score };
}

// ── Explain ───────────────────────────────────────────────────────────────────

export function explainSystemPressure(result: SystemPressureResult): string {
  if (result.level === "normal") {
    return `System pressure is NORMAL (score: ${result.score}/100). All ${result.signals.length} signals within bounds.`;
  }

  const breached = result.signals.filter(s => s.breached);
  const lines = breached.map(s => `  • ${s.name}: ${s.value}${s.unit} [severity: ${s.severity}]`);
  return [
    `System pressure is ${result.level.toUpperCase()} (score: ${result.score}/100).`,
    `${breached.length} signal(s) breached threshold:`,
    ...lines,
  ].join("\n");
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function getSystemPressure(
  thresholds: PressureThresholds = DEFAULT_THRESHOLDS,
  windowMinutes = 60,
): Promise<SystemPressureResult> {
  const signals              = await collectPressureSignals(thresholds, windowMinutes);
  const { level, score }     = classifyPressureLevel(signals);
  const criticalCount        = signals.filter(s => s.severity === "critical").length;
  const highCount            = signals.filter(s => s.severity === "high").length;

  const result: SystemPressureResult = {
    level, score, signals, criticalCount, highCount,
    explanation: "",
    checkedAt:   new Date().toISOString(),
  };
  result.explanation = explainSystemPressure(result);
  return result;
}

export function summarizePressureSignals(signals: PressureSignal[]): string {
  const breached = signals.filter(s => s.breached).map(s => s.name);
  return breached.length === 0
    ? "All pressure signals nominal."
    : `Breached signals: ${breached.join(", ")}`;
}
