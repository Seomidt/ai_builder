/**
 * Phase 29 — Recovery Observability
 * Tracks backup events, restore attempts, replay attempts, pressure history,
 * and brownout transitions for diagnostics and audit.
 */

import type { PressureLevel, SystemPressureResult } from "./system-pressure.ts";
import type { BrownoutLevel, BrownoutTransition }   from "./brownout-mode.ts";
import { getBrownoutHistory as _getBrownoutHistory } from "./brownout-mode.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ObsEventType =
  | "backup_success"
  | "backup_failure"
  | "upload_success"
  | "upload_failure"
  | "restore_attempt"
  | "restore_success"
  | "restore_failure"
  | "replay_attempt"
  | "replay_success"
  | "replay_failure"
  | "stripe_desync_detected"
  | "job_recovery_run"
  | "pressure_level_change"
  | "brownout_transition";

export interface ObsEvent {
  id:        string;
  type:      ObsEventType;
  level:     "info" | "warn" | "error";
  tenantId?: string;
  message:   string;
  metadata:  Record<string, unknown>;
  timestamp: string;
}

export interface BackupMetrics {
  backupSuccessCount:  number;
  backupFailureCount:  number;
  uploadSuccessCount:  number;
  uploadFailureCount:  number;
  lastBackupAt:        string | null;
  lastUploadAt:        string | null;
  lastFailureAt:       string | null;
}

export interface RecoveryMetrics {
  restoreAttempts:    number;
  replayAttempts:     number;
  jobRecoveryRuns:    number;
  stripeDesyncCount:  number;
  lastRecoveryAt:     string | null;
}

export interface PressureHistoryEntry {
  level:     PressureLevel;
  score:     number;
  timestamp: string;
}

export interface ObservabilitySnapshot {
  backup:          BackupMetrics;
  recovery:        RecoveryMetrics;
  pressureHistory: PressureHistoryEntry[];
  brownoutHistory: BrownoutTransition[];
  recentEvents:    ObsEvent[];
  checkedAt:       string;
}

// ── In-memory store (bounded ring buffers) ────────────────────────────────────

const MAX_EVENTS   = 500;
const MAX_PRESSURE = 100;

const _store = {
  events:          [] as ObsEvent[],
  pressureHistory: [] as PressureHistoryEntry[],
  backup: {
    backupSuccessCount:  0,
    backupFailureCount:  0,
    uploadSuccessCount:  0,
    uploadFailureCount:  0,
    lastBackupAt:        null as string | null,
    lastUploadAt:        null as string | null,
    lastFailureAt:       null as string | null,
  } as BackupMetrics,
  recovery: {
    restoreAttempts:   0,
    replayAttempts:    0,
    jobRecoveryRuns:   0,
    stripeDesyncCount: 0,
    lastRecoveryAt:    null as string | null,
  } as RecoveryMetrics,
};

function nextId(): string {
  return `obs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function addEvent(event: Omit<ObsEvent, "id" | "timestamp">): void {
  _store.events.push({ ...event, id: nextId(), timestamp: new Date().toISOString() });
  if (_store.events.length > MAX_EVENTS) _store.events.shift();
}

// ── Backup tracking ───────────────────────────────────────────────────────────

export function recordBackupSuccess(metadata: Record<string, unknown> = {}): void {
  _store.backup.backupSuccessCount++;
  _store.backup.lastBackupAt = new Date().toISOString();
  addEvent({ type: "backup_success", level: "info", message: "Database backup completed", metadata });
}

export function recordBackupFailure(error: string, metadata: Record<string, unknown> = {}): void {
  _store.backup.backupFailureCount++;
  _store.backup.lastFailureAt = new Date().toISOString();
  addEvent({ type: "backup_failure", level: "error", message: `Backup failed: ${error}`, metadata: { error, ...metadata } });
}

export function recordUploadSuccess(key: string, metadata: Record<string, unknown> = {}): void {
  _store.backup.uploadSuccessCount++;
  _store.backup.lastUploadAt = new Date().toISOString();
  addEvent({ type: "upload_success", level: "info", message: `R2 upload succeeded: ${key}`, metadata: { key, ...metadata } });
}

export function recordUploadFailure(error: string, metadata: Record<string, unknown> = {}): void {
  _store.backup.uploadFailureCount++;
  _store.backup.lastFailureAt = new Date().toISOString();
  addEvent({ type: "upload_failure", level: "error", message: `R2 upload failed: ${error}`, metadata: { error, ...metadata } });
}

// ── Recovery tracking ─────────────────────────────────────────────────────────

export function recordRestoreAttempt(tenantId: string | undefined, scope: string, metadata: Record<string, unknown> = {}): void {
  _store.recovery.restoreAttempts++;
  _store.recovery.lastRecoveryAt = new Date().toISOString();
  addEvent({ type: "restore_attempt", level: "warn", tenantId, message: `Restore attempt: ${scope}`, metadata: { scope, ...metadata } });
}

export function recordReplayAttempt(tenantId: string | undefined, count: number, metadata: Record<string, unknown> = {}): void {
  _store.recovery.replayAttempts++;
  _store.recovery.lastRecoveryAt = new Date().toISOString();
  addEvent({ type: "replay_attempt", level: "info", tenantId, message: `Webhook replay: ${count} deliveries`, metadata: { count, ...metadata } });
}

export function recordJobRecoveryRun(stalledCount: number, requeuedCount: number, metadata: Record<string, unknown> = {}): void {
  _store.recovery.jobRecoveryRuns++;
  addEvent({ type: "job_recovery_run", level: "info", message: `Job recovery: ${stalledCount} stalled, ${requeuedCount} requeued`, metadata: { stalledCount, requeuedCount, ...metadata } });
}

export function recordStripeDesync(count: number, metadata: Record<string, unknown> = {}): void {
  _store.recovery.stripeDesyncCount += count;
  if (count > 0) {
    addEvent({ type: "stripe_desync_detected", level: "warn", message: `Stripe desync detected: ${count} records`, metadata: { count, ...metadata } });
  }
}

// ── Pressure tracking ─────────────────────────────────────────────────────────

export function recordPressureSnapshot(result: SystemPressureResult): void {
  const entry: PressureHistoryEntry = {
    level:     result.level,
    score:     result.score,
    timestamp: result.checkedAt,
  };

  const last = _store.pressureHistory.at(-1);
  if (!last || last.level !== entry.level) {
    addEvent({
      type:     "pressure_level_change",
      level:    result.level === "normal" ? "info" : result.level === "elevated" ? "warn" : "error",
      message:  `Pressure changed to ${result.level.toUpperCase()} (score: ${result.score})`,
      metadata: { level: result.level, score: result.score },
    });
  }

  _store.pressureHistory.push(entry);
  if (_store.pressureHistory.length > MAX_PRESSURE) _store.pressureHistory.shift();
}

export function recordBrownoutTransition(transition: BrownoutTransition): void {
  addEvent({
    type:     "brownout_transition",
    level:    transition.to === "normal" ? "info" : transition.to === "elevated" ? "warn" : "error",
    message:  `Brownout ${transition.from.toUpperCase()} → ${transition.to.toUpperCase()}: ${transition.reason}`,
    metadata: { from: transition.from, to: transition.to, reason: transition.reason, manual: transition.manual },
  });
}

// ── Read ──────────────────────────────────────────────────────────────────────

export function getObservabilitySnapshot(limit = 50): ObservabilitySnapshot {
  return {
    backup:          { ...(_store.backup) },
    recovery:        { ...(_store.recovery) },
    pressureHistory: [..._store.pressureHistory].slice(-50),
    brownoutHistory: _getBrownoutHistory().slice(-50),
    recentEvents:    [..._store.events].slice(-limit).reverse(),
    checkedAt:       new Date().toISOString(),
  };
}

export function getRecentEvents(type?: ObsEventType, limit = 50): ObsEvent[] {
  const events = type ? _store.events.filter(e => e.type === type) : _store.events;
  return [...events].slice(-limit).reverse();
}

export function getPressureHistory(limit = 50): PressureHistoryEntry[] {
  return [..._store.pressureHistory].slice(-limit);
}
