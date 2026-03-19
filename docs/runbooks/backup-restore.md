# Runbook: Backup Restore

**Severity**: P0 (Critical) when initiated for data recovery; P2 (Medium) for planned restores
**Owner**: Platform On-Call + Data Team
**Last Updated**: 2026-03-16

---

## Overview

This runbook covers the full backup restore process for the AI Builder Platform.
Backups are stored in Supabase PITR and Cloudflare R2.

---

## Restore Sources

| Source | Use Case | RTO | RPO |
|--------|----------|-----|-----|
| Supabase PITR | Database-level restore | 15–60 min | 5 min |
| Cloudflare R2 daily | Full DB restore from file | 30–120 min | 24h |
| Cloudflare R2 weekly | Long-range recovery | 60–180 min | 7 days |

---

## Pre-Restore Checklist

Before ANY restore:

1. Confirm incident scope — what is lost/corrupted?
2. Identify target recovery timestamp
3. Check legal holds:
   ```sql
   SELECT COUNT(*) FROM legal_holds WHERE active = TRUE;
   ```
4. Get approval from: On-call lead + CTO (for full DB restore)
5. Notify affected tenants (if applicable)
6. Enable maintenance mode

---

## Restore A: Single Tenant (most common)

### 1. Generate dry-run restore plan
```bash
curl -X POST http://localhost:5000/api/admin/recovery/restore-tenant \
  -H 'Content-Type: application/json' \
  -H 'x-admin-secret: admin' \
  -d '{"tenantId": "TENANT_ID"}'
```

### 2. Review plan output
```bash
npx tsx -e "
import('./server/lib/backup/restore-tools.js').then(async m => {
  const plan = await m.planTenantRestore('TENANT_ID', true);
  console.log(JSON.stringify(plan, null, 2));
});
"
```

Check:
- `status !== 'blocked'` — no legal holds
- `steps` — review the restore steps
- `estimatedRows` — sanity check

### 3. Execute via Supabase PITR
- Go to Supabase Dashboard → Backups → PITR
- Set target timestamp (before data loss event)
- For single-tenant restore, restore to staging first, then migrate specific rows

---

## Restore B: Single Table

### 1. Plan table restore
```bash
curl -X POST http://localhost:5000/api/admin/recovery/restore-table \
  -H 'Content-Type: application/json' \
  -H 'x-admin-secret: admin' \
  -d '{"tableName": "TABLE_NAME"}'
```

### 2. Check eligibility
```bash
npx tsx -e "
import('./server/lib/backup/restore-tools.js').then(async m => {
  const e = await m.checkTableRestoreEligibility('TABLE_NAME');
  console.log(JSON.stringify(e, null, 2));
});
"
```

### 3. Execute table restore
Follow the `steps` array from `planTableRestore()` output exactly.

---

## Restore C: Full Database

### 1. Generate full restore plan
```bash
npx tsx -e "
import('./server/lib/backup/restore-tools.js').then(async m => {
  const plan = await m.planFullDbRestore();
  console.log(JSON.stringify(plan, null, 2));
});
"
```

### 2. From Supabase PITR (preferred)
1. Open Supabase Dashboard → Project → Backups
2. Select Point-in-Time Recovery
3. Choose recovery timestamp
4. Confirm restore — this replaces the entire database

### 3. From R2 backup file
```bash
# 1. List available backups
npx tsx -e "
import('./server/lib/backup/r2-backup.js').then(async m => {
  const backups = await m.listBackups('daily');
  console.log(JSON.stringify(backups, null, 2));
});
"

# 2. Download backup (manual step — use R2 dashboard or aws CLI)
# aws s3 cp s3://ai-platform-backups/db/daily/YYYY-MM-DD.sql.gz ./restore.sql.gz

# 3. Decompress and restore
# gunzip restore.sql.gz
# psql $SUPABASE_DB_POOL_URL < restore.sql
```

### 4. Post-restore validation
```bash
npx tsx scripts/validate-schema.ts
npx tsx validate-phase29.ts
```

---

## Post-Restore

- Run all platform validations
- Verify tenant data integrity manually for critical tenants
- Run Stripe reconciliation:
  ```bash
  curl http://localhost:5000/api/admin/recovery/stripe-reconcile \
    -H 'x-admin-secret: admin'
  ```
- Run job recovery for any stalled jobs:
  ```bash
  curl -X POST http://localhost:5000/api/admin/recovery/job-recovery \
    -H 'Content-Type: application/json' \
    -H 'x-admin-secret: admin' \
    -d '{"dryRun": false}'
  ```
- Write incident report within 24h
- Review backup frequency and RPO requirements
