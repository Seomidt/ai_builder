# Disaster Recovery Plan

**Platform**: blissops.com — AI Builder Platform (multi-tenant SaaS)  
**Phase**: 47 — Disaster Recovery Validation  
**Last updated**: 2026-03-19  
**Status**: ACTIVE — validated

---

## 1. Recovery Objectives

| Metric | Target | Basis |
|---|---|---|
| **RTO** (Recovery Time Objective) | ≤ 4 hours | Supabase PITR restore + DNS propagation |
| **RPO** (Recovery Point Objective) | ≤ 5 minutes | Supabase continuous WAL streaming |

### Rationale
- Supabase Pro/Enterprise PITR: WAL shipping every ~5 minutes, retention ≥ 7 days
- Restore to a new project: ~30–90 min (depending on DB size, currently 36 MB → fast)
- DNS failover: ~15–30 min (Cloudflare zone update)
- Post-restore validation: ~30 min (automated scripts)
- R2 storage: objects are immutable after write; no restore needed unless bucket is deleted

---

## 2. Failure Scenarios Covered

| Scenario | Priority | Strategy |
|---|---|---|
| Full DB corruption/loss | P0 | Supabase PITR restore to point before incident |
| Logical data corruption | P0 | PITR to last-known-good timestamp |
| Accidental table truncation | P0 | PITR — restore from WAL |
| Single tenant data loss | P1 | PITR + per-tenant data extraction |
| R2 bucket object deletion | P1 | R2 versioning / Cloudflare support restore |
| R2 bucket metadata drift | P2 | Re-sync from `tenant_files` table |
| Supabase project deletion | P0 | Restore from PITR backup to new project |
| Supabase auth corruption | P1 | PITR restore of `auth` schema separately |
| RLS misconfiguration deployed | P0 | PITR to pre-deployment point |
| Encryption key loss | P0 | Requires Supabase support + key escrow |

---

## 3. Backup Infrastructure

### 3.1 Supabase Database Backups
- **Type**: Point-in-Time Recovery (PITR) via WAL streaming
- **Retention**: 7 days (Pro) / 28 days (Enterprise)
- **RPO**: ~5 minutes (WAL shipping interval)
- **Location**: Managed by Supabase (AWS S3 in same region)
- **Access**: Supabase Dashboard → Project Settings → Backups

### 3.2 Cloudflare R2 Storage
- **Type**: Object storage (immutable after write)
- **Bucket**: `CF_R2_BUCKET_NAME` (set via env secret)
- **Versioning**: Enabled (objects not permanently deleted on first delete)
- **Consistency**: DB metadata in `tenant_files` table must match R2 objects
- **Access**: CF R2 API with `CF_R2_ACCESS_KEY_ID` / `CF_R2_SECRET_ACCESS_KEY`

### 3.3 Supabase Auth
- Auth schema (`auth.*`) is backed up alongside the public schema in PITR
- Restore restores all schemas: public, auth, storage, realtime

---

## 4. Restore Procedure

### 4.1 Decision: Restore or Not?

Before restoring, confirm:
1. Is the incident fully understood? (What failed, at what timestamp?)
2. Is the target restore point identified? (`YYYY-MM-DDTHH:MM:SSZ`)
3. Is the restore in-place or to a new project? (Default: **new project first**)

### 4.2 Step-by-Step Restore

#### Step 1 — Identify restore point
```
Supabase Dashboard → Project → Settings → Backups → Point in Time
Select timestamp: [incident_time - 10 minutes]
Note the exact restore timestamp for audit log.
```

#### Step 2 — Initiate PITR restore
```
Option A (Supabase Dashboard):
  Dashboard → Backups → Restore to new project
  → Name: "blissops-dr-[date]"
  → Region: same as production
  → Click "Restore"

Option B (Supabase CLI):
  supabase db remote commit --db-url [backup_db_url]

Option C (Emergency — contact Supabase support):
  Email: support@supabase.com
  Provide: project ref, restore timestamp, reason
```

#### Step 3 — Verify restore environment
```bash
# Run restore validation script against the new DB
SUPABASE_DB_POOL_URL="postgres://[restored_db_url]" \
  npx tsx scripts/validate-disaster-recovery.ts
```

Expected output: `RESTORE VALIDATION: PASSED ✅`

#### Step 4 — Verify tenant isolation
```sql
-- Run on restored DB
-- Tenant A must not see Tenant B's data
SELECT COUNT(*) FROM security_events WHERE tenant_id != '[known_tenant_id]';
-- Expected: 0 (RLS blocks all cross-tenant access)
```

#### Step 5 — Verify RLS
```sql
SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname='public' AND NOT rowsecurity;
-- Expected: 0 rows
```

#### Step 6 — Verify schema integrity
```sql
-- All 214 tables must be present
SELECT COUNT(*) FROM pg_tables WHERE schemaname='public';
-- Expected: 214
```

#### Step 7 — Verify indexes
```sql
SELECT COUNT(*) FROM pg_indexes WHERE schemaname='public';
-- Expected: >= 900 (baseline: 945)
```

#### Step 8 — Storage consistency check
```bash
npx tsx scripts/validate-disaster-recovery.ts --storage-only
```
Verifies `tenant_files` DB metadata matches R2 objects.

#### Step 9 — DNS failover (if replacing production)
```
Cloudflare Dashboard → DNS:
  Update SUPABASE_URL env var to point to restored project connection string
  Update DATABASE_URL to restored project's connection string
  Redeploy application (or update environment secrets via Replit/hosting platform)
```

#### Step 10 — Post-restore smoke test
```bash
# Run full Phase 47 validation
npx tsx scripts/validate-phase47.ts
```
Expected: `DISASTER RECOVERY: VERIFIED ✅`

---

## 5. Rollback Plan

If the restore makes things worse:
1. Stop using the restored project immediately
2. Keep the original (corrupted) project alive — do NOT delete it
3. Contact Supabase support with both project refs
4. Initiate restore to a third project from an earlier backup point
5. Escalation contact: Supabase Enterprise Support (if applicable)

---

## 6. Tenant Isolation Verification

After any restore, run the following checks:

```sql
-- 1. Verify RLS is enabled on all tables
SELECT COUNT(*) FROM pg_tables WHERE schemaname='public' AND NOT rowsecurity;
-- Must be 0

-- 2. Verify no PUBLIC USING(true) policies exist
SELECT COUNT(*) FROM pg_policies
WHERE schemaname='public' AND 'public'=ANY(roles) AND (qual='true' OR with_check='true');
-- Must be 0

-- 3. Spot-check tenant isolation on critical tables
SELECT DISTINCT tenant_id FROM security_events;
-- Each tenant_id must be different (no cross-tenant bleed)

-- 4. Verify FK constraints still enforced
SELECT COUNT(*) FROM information_schema.table_constraints
WHERE constraint_type='FOREIGN KEY' AND constraint_schema='public';
-- Must be >= 50
```

---

## 7. Storage Consistency Verification

```
DB tenant_files count = R2 object count (filtered by org/{org_id}/*)
Missing in R2 = files in DB metadata but not in R2 bucket
Missing in DB = files in R2 bucket but no metadata row
```

Acceptable drift: 0% for files uploaded more than 1 hour ago.
Files in-flight (< 1 min old) may have a brief consistency window.

---

## 8. RTO/RPO Detail

### RTO Breakdown

| Step | Estimated Time |
|---|---|
| Incident detection + decision | 15 min |
| Supabase PITR restore (36 MB DB) | 20–45 min |
| Validation scripts | 10 min |
| DNS update + propagation | 15–30 min |
| Post-restore smoke test | 10 min |
| **Total RTO** | **70–110 min (target ≤ 4 hours)** |

### RPO Detail

| Component | Data Loss Window |
|---|---|
| Supabase WAL streaming | ~5 minutes |
| R2 object storage | 0 (objects written atomically) |
| In-flight requests | < 30 seconds |
| **Effective RPO** | **~5 minutes** |

---

## 9. Escalation Path

| Severity | Contact | SLA |
|---|---|---|
| P0 (full outage) | Supabase support + Cloudflare support | Immediate |
| P1 (partial data loss) | Supabase support | < 1 hour |
| P2 (drift/consistency) | Internal engineering | < 4 hours |

---

## 10. Recovery Runbook Checklist

```
□ Incident declared and timestamp noted
□ Restore point identified (timestamp - buffer)
□ Supabase PITR restore initiated
□ Restore environment provisioned
□ validate-disaster-recovery.ts run on restored DB → PASSED
□ Tenant isolation verified
□ RLS verified (0 tables without RLS, 0 PUBLIC USING(true))
□ Schema integrity verified (214 tables, ≥ 900 indexes)
□ Storage consistency check run
□ DNS/connection string updated
□ Full validation (validate-phase47.ts) run → VERIFIED
□ Incident post-mortem scheduled
```

---

*blissops.com AI Builder Platform — Disaster Recovery Plan*  
*Classification: INTERNAL — Engineering Team Only*
