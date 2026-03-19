export type SecurityEventType =
  | "auth_failure"
  | "rate_limit_exceeded"
  | "csp_violation"
  | "rls_violation"
  | "suspicious_activity"
  | "password_reset"
  | "mfa_challenge"
  | "session_expired";

export interface SecurityEvent {
  id:          string;
  eventType:   SecurityEventType;
  tenantId:    string;
  userId?:     string;
  ipAddress?:  string;
  metadata?:   Record<string, unknown>;
  createdAt:   Date;
}

export async function listSecurityEventsByTenant(
  _tenantId: string,
  _limit = 50,
): Promise<SecurityEvent[]> {
  return [];
}

export async function listRecentSecurityEvents(
  _limit = 100,
): Promise<SecurityEvent[]> {
  return [];
}

export function explainSecurityEvent(event: SecurityEvent): string {
  return `[${event.eventType}] tenant=${event.tenantId} ip=${event.ipAddress ?? "unknown"} at ${event.createdAt.toISOString()}`;
}
