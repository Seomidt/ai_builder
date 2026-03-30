/**
 * R2 Storage Usage Metrics — Task 4
 * Lists objects page-by-page to compute usage summaries.
 *
 * NOTE: R2 has no native "get total bucket size" API — we paginate
 * ListObjectsV2 to accumulate counts and bytes. For production at scale,
 * cache results or use a scheduled job.
 */

import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { r2Client, R2_BUCKET } from "./r2-client.ts";
import { TENANT_ROOT, PLATFORM_ROOT } from "./key-builder.ts";

export interface PrefixUsage {
  prefix:       string;
  objectCount:  number;
  totalBytes:   number;
}

export interface BucketUsageSummary {
  totalObjects:  number;
  totalBytes:    number;
  tenantCount:   number;
  topPrefixes:   PrefixUsage[];
  computedAt:    string;
}

export interface TenantPrefixUsage {
  tenantId:     string;
  objectCount:  number;
  totalBytes:   number;
  byCategory:   PrefixUsage[];
  computedAt:   string;
}

// ── Paginated list helper ──────────────────────────────────────────────────────

async function paginateList(prefix: string, maxObjects = 10_000) {
  const results: { key: string; size: number }[] = [];
  let continuationToken: string | undefined;

  do {
    const resp = await r2Client.send(new ListObjectsV2Command({
      Bucket:            R2_BUCKET,
      Prefix:            prefix,
      MaxKeys:           1000,
      ContinuationToken: continuationToken,
    }));

    for (const obj of resp.Contents ?? []) {
      results.push({ key: obj.Key ?? "", size: obj.Size ?? 0 });
    }

    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    if (results.length >= maxObjects) break;
  } while (continuationToken);

  return results;
}

// ── Public functions ────────────────────────────────────────────────────────────

export async function getBucketUsageSummary(): Promise<BucketUsageSummary> {
  const all = await paginateList("");

  const prefixMap = new Map<string, PrefixUsage>();
  const tenantIds = new Set<string>();
  let totalBytes  = 0;

  for (const { key, size } of all) {
    totalBytes += size;
    const parts = key.split("/");
    // Top-level prefix = first two segments (e.g. tenants/xxx or platform/backups)
    const topPrefix = parts.slice(0, 2).join("/");

    if (parts[0] === TENANT_ROOT && parts[1]) tenantIds.add(parts[1]);

    const existing = prefixMap.get(topPrefix) ?? { prefix: topPrefix, objectCount: 0, totalBytes: 0 };
    existing.objectCount++;
    existing.totalBytes += size;
    prefixMap.set(topPrefix, existing);
  }

  const topPrefixes = Array.from(prefixMap.values())
    .sort((a, b) => b.totalBytes - a.totalBytes)
    .slice(0, 20);

  return {
    totalObjects: all.length,
    totalBytes,
    tenantCount:  tenantIds.size,
    topPrefixes,
    computedAt:   new Date().toISOString(),
  };
}

export async function getTenantPrefixUsage(tenantId: string): Promise<TenantPrefixUsage> {
  const prefix = `${TENANT_ROOT}/${tenantId}/`;
  const objects = await paginateList(prefix);

  const categoryMap = new Map<string, PrefixUsage>();
  let totalBytes = 0;

  for (const { key, size } of objects) {
    totalBytes += size;
    const parts    = key.split("/"); // tenants / tenantId / category / filename
    const category = parts[2] ?? "unknown";
    const catPrefix = `${prefix}${category}/`;

    const existing = categoryMap.get(catPrefix) ?? { prefix: catPrefix, objectCount: 0, totalBytes: 0 };
    existing.objectCount++;
    existing.totalBytes += size;
    categoryMap.set(catPrefix, existing);
  }

  return {
    tenantId,
    objectCount:  objects.length,
    totalBytes,
    byCategory:   Array.from(categoryMap.values()).sort((a, b) => b.totalBytes - a.totalBytes),
    computedAt:   new Date().toISOString(),
  };
}

export async function getPrefixUsage(prefix: string): Promise<PrefixUsage> {
  const objects = await paginateList(prefix);
  const totalBytes = objects.reduce((s, o) => s + o.size, 0);
  return { prefix, objectCount: objects.length, totalBytes };
}

export async function estimateObjectCount(prefix: string): Promise<number> {
  const objects = await paginateList(prefix, 1000);
  return objects.length;
}
