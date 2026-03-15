/**
 * Phase 6 — Identity Provider Foundation Service
 * INV-ID12: Foundation only — no fake SSO/SAML/OIDC completion.
 */

import pg from "pg";

function getClient(): pg.Client {
  return new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

const VALID_PROVIDER_TYPES = ["oidc", "saml", "google_workspace", "azure_ad"] as const;
const VALID_STATUSES = ["draft", "active", "disabled"] as const;

type ProviderType = (typeof VALID_PROVIDER_TYPES)[number];
type ProviderStatus = (typeof VALID_STATUSES)[number];

export async function createIdentityProvider(params: {
  tenantId: string;
  providerType: ProviderType;
  displayName: string;
  issuer?: string;
  audience?: string;
  metadata?: Record<string, unknown>;
  createdBy?: string;
}): Promise<{ providerId: string; tenantId: string; providerType: string; providerStatus: string }> {
  const { tenantId, providerType, displayName, issuer, audience, metadata, createdBy } = params;
  if (!VALID_PROVIDER_TYPES.includes(providerType)) {
    throw new Error(`Invalid provider_type: ${providerType}`);
  }
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `INSERT INTO public.identity_providers
         (id, tenant_id, provider_type, provider_status, display_name, issuer, audience, metadata, created_by)
       VALUES (gen_random_uuid(), $1, $2, 'draft', $3, $4, $5, $6, $7)
       RETURNING id, provider_status`,
      [tenantId, providerType, displayName, issuer ?? null, audience ?? null, metadata ? JSON.stringify(metadata) : null, createdBy ?? null],
    );
    return { providerId: row.rows[0].id, tenantId, providerType, providerStatus: row.rows[0].provider_status };
  } finally {
    await client.end();
  }
}

export async function updateIdentityProviderStatus(params: {
  providerId: string;
  newStatus: ProviderStatus;
}): Promise<{ providerId: string; previousStatus: string; newStatus: string }> {
  const { providerId, newStatus } = params;
  if (!VALID_STATUSES.includes(newStatus)) {
    throw new Error(`Invalid status: ${newStatus}`);
  }
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT id, provider_status FROM public.identity_providers WHERE id = $1`,
      [providerId],
    );
    if (row.rows.length === 0) throw new Error("Identity provider not found");
    const previousStatus = row.rows[0].provider_status;
    await client.query(
      `UPDATE public.identity_providers SET provider_status = $1, updated_at = NOW() WHERE id = $2`,
      [newStatus, providerId],
    );
    return { providerId, previousStatus, newStatus };
  } finally {
    await client.end();
  }
}

export async function listTenantIdentityProviders(tenantId: string): Promise<Array<{
  id: string;
  providerType: string;
  providerStatus: string;
  displayName: string;
  createdAt: Date;
}>> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT id, provider_type, provider_status, display_name, created_at
       FROM public.identity_providers WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );
    return row.rows.map((r) => ({
      id: r.id,
      providerType: r.provider_type,
      providerStatus: r.provider_status,
      displayName: r.display_name,
      createdAt: r.created_at,
    }));
  } finally {
    await client.end();
  }
}

export async function getIdentityProviderById(providerId: string): Promise<{
  id: string;
  tenantId: string;
  providerType: string;
  providerStatus: string;
  displayName: string;
  issuer: string | null;
  audience: string | null;
  isActive: boolean;
} | null> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT id, tenant_id, provider_type, provider_status, display_name, issuer, audience
       FROM public.identity_providers WHERE id = $1`,
      [providerId],
    );
    if (row.rows.length === 0) return null;
    const r = row.rows[0];
    return {
      id: r.id,
      tenantId: r.tenant_id,
      providerType: r.provider_type,
      providerStatus: r.provider_status,
      displayName: r.display_name,
      issuer: r.issuer,
      audience: r.audience,
      isActive: r.provider_status === "active",
    };
  } finally {
    await client.end();
  }
}

export function explainIdentityProvider(provider: {
  id: string;
  providerType: string;
  providerStatus: string;
  displayName: string;
  isActive: boolean;
}): {
  providerId: string;
  providerType: string;
  providerStatus: string;
  isActive: boolean;
  capabilities: string[];
  note: string;
} {
  const caps: string[] = [];
  if (provider.providerStatus === "active") caps.push("accepts_sso_assertions");
  if (provider.providerType === "oidc") caps.push("oidc_foundation_ready");
  if (provider.providerType === "saml") caps.push("saml_foundation_ready");
  if (provider.providerType === "google_workspace") caps.push("google_workspace_foundation_ready");
  if (provider.providerType === "azure_ad") caps.push("azure_ad_foundation_ready");

  return {
    providerId: provider.id,
    providerType: provider.providerType,
    providerStatus: provider.providerStatus,
    isActive: provider.isActive,
    capabilities: caps,
    note: "INV-ID12: Foundation only. No fake SSO login flow completed.",
  };
}
