/**
 * Phase 39 — Brute-Force / Account Lock Protection
 * Tracks failed auth attempts and enforces escalating cooldowns.
 *
 * Tracks per: email/account, IP, and email+IP combo.
 * Escalating policy:
 *   5  failures → 60s cooldown
 *   10 failures → 300s cooldown
 *   15 failures → 900s cooldown
 *   20 failures → 3600s cooldown (account-level temp lock)
 */

// ── Escalation thresholds ─────────────────────────────────────────────────────

export interface EscalationThreshold {
  attempts:        number;
  cooldownSeconds: number;
  description:     string;
}

export const ESCALATION_THRESHOLDS: EscalationThreshold[] = [
  { attempts: 5,  cooldownSeconds: 60,   description: "Short cooldown" },
  { attempts: 10, cooldownSeconds: 300,  description: "Extended cooldown" },
  { attempts: 15, cooldownSeconds: 900,  description: "Long cooldown" },
  { attempts: 20, cooldownSeconds: 3600, description: "Account-level temporary lock" },
];

export const MAX_WINDOW_MS = 2 * 60 * 60 * 1000; // 2-hour rolling window

// ── State ─────────────────────────────────────────────────────────────────────

export interface BruteForceEntry {
  key:              string;
  failures:         number;
  firstFailureAt:   number;
  lastFailureAt:    number;
  cooldownUntil:    number | null;
  currentThreshold: EscalationThreshold | null;
}

const store = new Map<string, BruteForceEntry>();

function makeKey(type: "account" | "ip" | "combo", identifier: string): string {
  return `bf:${type}:${identifier.toLowerCase().trim().slice(0, 128)}`;
}

function cleanup(): void {
  const now = Date.now();
  for (const [k, e] of store) {
    if (now - e.lastFailureAt > MAX_WINDOW_MS && (!e.cooldownUntil || now > e.cooldownUntil)) {
      store.delete(k);
    }
  }
}

function getEntry(key: string): BruteForceEntry {
  let entry = store.get(key);
  const now = Date.now();
  if (!entry) {
    entry = { key, failures: 0, firstFailureAt: now, lastFailureAt: now, cooldownUntil: null, currentThreshold: null };
    store.set(key, entry);
  }
  // Reset window if inactive for too long and no active cooldown
  if (now - entry.lastFailureAt > MAX_WINDOW_MS && (!entry.cooldownUntil || now > entry.cooldownUntil)) {
    entry.failures = 0;
    entry.firstFailureAt = now;
    entry.cooldownUntil = null;
    entry.currentThreshold = null;
  }
  return entry;
}

function applyEscalation(entry: BruteForceEntry): void {
  const threshold = [...ESCALATION_THRESHOLDS]
    .reverse()
    .find(t => entry.failures >= t.attempts);
  if (threshold) {
    entry.currentThreshold = threshold;
    entry.cooldownUntil = Date.now() + threshold.cooldownSeconds * 1000;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface BruteForceState {
  blocked:              boolean;
  cooldownRemainingMs:  number;
  failures:             number;
  threshold:            EscalationThreshold | null;
  keys: {
    account: BruteForceEntry;
    ip:      BruteForceEntry;
    combo:   BruteForceEntry;
  };
}

export function recordAuthFailure(emailOrUserId: string, ip: string): void {
  if (Math.random() < 0.05) cleanup();
  const now = Date.now();

  for (const [type, id] of [
    ["account", emailOrUserId],
    ["ip",      ip],
    ["combo",   `${emailOrUserId}|${ip}`],
  ] as const) {
    const key   = makeKey(type, id);
    const entry = getEntry(key);
    entry.failures++;
    entry.lastFailureAt = now;
    applyEscalation(entry);
    store.set(key, entry);
  }
}

export function recordAuthSuccess(emailOrUserId: string, ip: string): void {
  // Clear only the account key on success — do NOT clear IP (could be shared)
  const accountKey = makeKey("account", emailOrUserId);
  const comboKey   = makeKey("combo", `${emailOrUserId}|${ip}`);
  store.delete(accountKey);
  store.delete(comboKey);
}

export function clearAuthFailureWindow(emailOrUserId: string, ip: string): void {
  store.delete(makeKey("account", emailOrUserId));
  store.delete(makeKey("ip",      ip));
  store.delete(makeKey("combo",   `${emailOrUserId}|${ip}`));
}

export function getBruteForceState(emailOrUserId: string, ip: string): BruteForceState {
  const now         = Date.now();
  const accountKey  = makeKey("account", emailOrUserId);
  const ipKey       = makeKey("ip",      ip);
  const comboKey    = makeKey("combo",   `${emailOrUserId}|${ip}`);

  const account = getEntry(accountKey);
  const ipEntry = getEntry(ipKey);
  const combo   = getEntry(comboKey);

  const maxCooldown = Math.max(
    account.cooldownUntil ?? 0,
    ipEntry.cooldownUntil ?? 0,
    combo.cooldownUntil   ?? 0,
  );
  const blocked              = now < maxCooldown;
  const cooldownRemainingMs  = blocked ? maxCooldown - now : 0;

  const worstThreshold = [account, ipEntry, combo]
    .filter(e => e.currentThreshold !== null)
    .sort((a, b) => (b.currentThreshold!.attempts - a.currentThreshold!.attempts))[0]
    ?.currentThreshold ?? null;

  return {
    blocked,
    cooldownRemainingMs,
    failures: Math.max(account.failures, ipEntry.failures, combo.failures),
    threshold: worstThreshold,
    keys: { account, ip: ipEntry, combo },
  };
}

export function getCooldownRemainingSeconds(emailOrUserId: string, ip: string): number {
  const state = getBruteForceState(emailOrUserId, ip);
  return Math.ceil(state.cooldownRemainingMs / 1000);
}

export interface AuthAttemptAllowedError extends Error {
  cooldownSeconds: number;
  failures: number;
}

/**
 * Throws if the auth attempt should be blocked.
 */
export function assertAuthAttemptAllowed(emailOrUserId: string, ip: string): void {
  const state = getBruteForceState(emailOrUserId, ip);
  if (state.blocked) {
    const err = new Error(
      `Too many failed attempts. Please wait ${Math.ceil(state.cooldownRemainingMs / 1000)} seconds.`,
    ) as AuthAttemptAllowedError;
    err.name             = "BruteForceBlockedError";
    err.cooldownSeconds  = Math.ceil(state.cooldownRemainingMs / 1000);
    err.failures         = state.failures;
    throw err;
  }
}

// ── Stats for admin dashboard ─────────────────────────────────────────────────

export interface BruteForceStats {
  activeEntries:  number;
  blockedEntries: number;
  topOffenders:   Array<{ key: string; failures: number; blockedUntil: string | null }>;
}

export function getBruteForceStats(): BruteForceStats {
  const now = Date.now();
  const entries = Array.from(store.values());
  const blocked = entries.filter(e => e.cooldownUntil && now < e.cooldownUntil);
  const top = entries
    .filter(e => e.failures > 0)
    .sort((a, b) => b.failures - a.failures)
    .slice(0, 20)
    .map(e => ({
      key:          e.key,
      failures:     e.failures,
      blockedUntil: e.cooldownUntil ? new Date(e.cooldownUntil).toISOString() : null,
    }));

  return { activeEntries: entries.length, blockedEntries: blocked.length, topOffenders: top };
}

export function resetBruteForceStore(): void {
  store.clear();
}
