/**
 * Phase 8 — Audit Backward Compatibility & Integration Strategy
 * INV-AUD9: Security events and audit events must remain distinct domains.
 * INV-AUD10: Backward compatibility with current services and routes must remain intact.
 */

// ─── explainCurrentAuditCoverage ──────────────────────────────────────────────
// INV-AUD7: Read-only.

export function explainCurrentAuditCoverage(): {
  auditedDomains: Array<{ domain: string; coverage: string[] }>;
  partialDomains: Array<{ domain: string; gaps: string[] }>;
  notYetAudited: string[];
  strategy: string;
  note: string;
} {
  return {
    auditedDomains: [
      {
        domain: "identity",
        coverage: [
          "membership.created", "membership.suspended", "membership.removed",
          "invitation.created", "invitation.revoked",
          "role.assigned", "role.removed",
          "service_account.created", "service_account_key.created", "service_account_key.revoked",
          "api_key.created", "api_key.revoked",
          "provider.created", "provider.status_updated",
        ],
      },
      {
        domain: "security",
        coverage: [
          "mfa.enabled", "mfa.disabled",
          "session.revoked", "session.revoke_all",
          "ip_allowlist.added", "ip_allowlist.removed",
          "recovery_codes.generated",
        ],
      },
      {
        domain: "audit_platform",
        coverage: ["export.started", "export.completed", "export.failed"],
      },
    ],
    partialDomains: [
      {
        domain: "knowledge",
        gaps: ["chunk indexing audit", "retrieval operation audit", "feedback loop mutations"],
      },
      {
        domain: "billing",
        gaps: ["invoice mutation audit", "subscription change audit", "payment retry audit"],
      },
    ],
    notYetAudited: [
      "AI inference operations",
      "retrieval queries (read-heavy, deferred for performance)",
      "webhook delivery events",
      "job/scheduler executions",
    ],
    strategy: "Incremental: Phase 8 covers identity + security + audit platform. Billing + knowledge + AI runtime audit integration deferred to dedicated phases.",
    note: "INV-AUD10: Backward compatible — no existing routes modified. INV-AUD9: security_events domain untouched.",
  };
}

// ─── previewAuditIntegrationImpact ────────────────────────────────────────────
// INV-AUD7: Read-only — no writes.

export function previewAuditIntegrationImpact(serviceArea: string): {
  serviceArea: string;
  proposedHooks: string[];
  estimatedEventVolume: string;
  breakingChanges: string[];
  recommended: boolean;
  note: string;
} {
  const impacts: Record<string, ReturnType<typeof previewAuditIntegrationImpact>> = {
    knowledge: {
      serviceArea: "knowledge",
      proposedHooks: ["knowledge.asset.created", "knowledge.asset.updated", "knowledge.asset.deleted"],
      estimatedEventVolume: "Low (admin operations only)",
      breakingChanges: [],
      recommended: true,
      note: "INV-AUD7: Read-only preview.",
    },
    billing: {
      serviceArea: "billing",
      proposedHooks: ["billing.invoice.created", "billing.invoice.voided", "billing.subscription.updated"],
      estimatedEventVolume: "Medium (invoice cycle events)",
      breakingChanges: [],
      recommended: true,
      note: "INV-AUD7: Read-only preview.",
    },
    retrieval: {
      serviceArea: "retrieval",
      proposedHooks: ["retrieval.query.executed", "retrieval.feedback.submitted"],
      estimatedEventVolume: "High (per-query) — recommend sampling strategy",
      breakingChanges: ["High volume may require async write pattern"],
      recommended: false,
      note: "INV-AUD7: Read-only preview. Deferred pending async audit pipeline.",
    },
  };

  return impacts[serviceArea] ?? {
    serviceArea,
    proposedHooks: [],
    estimatedEventVolume: "Unknown",
    breakingChanges: [],
    recommended: false,
    note: `INV-AUD7: Read-only preview. No audit hooks defined for '${serviceArea}' yet.`,
  };
}

// ─── explainAuditVsSecurityEventBoundary ──────────────────────────────────────
// INV-AUD9: Explains the distinction.

export function explainAuditVsSecurityEventBoundary(): {
  securityEventsDomain: string;
  auditEventsDomain: string;
  keyDistinctions: Array<{ aspect: string; securityEvents: string; auditEvents: string }>;
  coexistencePolicy: string;
  note: string;
} {
  return {
    securityEventsDomain: "Phase 7 security_events table — domain signal for security detection, IP blocking, rate-limit incidents, login anomalies, MFA/session events",
    auditEventsDomain: "Phase 8 audit_events table — governance records: who did what to which resource when, for compliance, investigation, and change history",
    keyDistinctions: [
      { aspect: "Purpose", securityEvents: "Security detection and incident signaling", auditEvents: "Governance, compliance, and change evidence" },
      { aspect: "Immutability", securityEvents: "Best-effort operational log", auditEvents: "Append-only governance record (INV-AUD2)" },
      { aspect: "Actor attribution", securityEvents: "user_id (optional)", auditEvents: "actor_id + actor_type (always, INV-AUD3)" },
      { aspect: "Before/after state", securityEvents: "Not captured", auditEvents: "Structured, optional (INV-AUD11)" },
      { aspect: "Export support", securityEvents: "Not directly exportable", auditEvents: "JSON + CSV export with run tracking (INV-AUD6)" },
      { aspect: "Action taxonomy", securityEvents: "Free-form event_type", auditEvents: "Canonical dot-separated action codes (INV-AUD8)" },
      { aspect: "Tenant scope", securityEvents: "Optional tenant_id", auditEvents: "Mandatory tenant_id (INV-AUD1)" },
    ],
    coexistencePolicy: "Security events and audit events are separate tables in separate domains. Neither replaces the other. A single action (e.g. session revocation) may produce both a security_event and an audit_event — each serving its distinct purpose.",
    note: "INV-AUD9: The two domains must remain distinct and must not be collapsed. This boundary is a hard invariant.",
  };
}

// ─── explainUnauditedMutationGaps ─────────────────────────────────────────────
// INV-AUD7: Read-only.

export function explainUnauditedMutationGaps(): {
  gaps: Array<{ area: string; mutations: string[]; priority: string; deferralReason: string }>;
  totalGapCount: number;
  note: string;
} {
  const gaps = [
    {
      area: "billing",
      mutations: ["invoice_line_items updates", "billing_alerts trigger/resolve", "payment retry initiation"],
      priority: "high",
      deferralReason: "Billing module is large and will be covered in a dedicated Phase 8b billing audit integration",
    },
    {
      area: "retrieval",
      mutations: ["retrieval document index updates", "chunk reindex operations", "retrieval profile changes"],
      priority: "medium",
      deferralReason: "Retrieval operations are high-volume and require async audit write pattern not yet built",
    },
    {
      area: "ai_runtime",
      mutations: ["AI inference requests", "pipeline configuration changes", "model provider updates"],
      priority: "medium",
      deferralReason: "AI pipeline operations deferred — high volume, dedicated sampling strategy needed",
    },
    {
      area: "webhook",
      mutations: ["webhook delivery attempts", "webhook configuration changes"],
      priority: "low",
      deferralReason: "Webhook platform not yet implemented — Phase 9 scope",
    },
  ];

  return {
    gaps,
    totalGapCount: gaps.reduce((s, g) => s + g.mutations.length, 0),
    note: "INV-AUD10: Existing routes are not broken. Gaps are documented for incremental coverage. INV-AUD7: Read-only.",
  };
}
