# Runbook: Database Failure

**Severity**: P0 (Critical)
**Owner**: Platform On-Call
**Last Updated**: 2026-03-16

---

## Overview

This runbook covers full or partial database failure scenarios for the AI Builder Platform.
The platform uses Supabase-hosted PostgreSQL with Point-in-Time Recovery (PITR).

---

## Detection

| Signal | Tool | Threshold |
|--------|------|-----------|
| DB connection failures | App logs / `/api/admin/platform/health` | Any |
| `GET /api/admin/platform/deploy-health` returns 503 | Monitoring | Immediate |
| Migration guard reports schema drift | `validate-phase28.ts` | Any |
| All jobs stuck in `running` state | `/api/admin/ops/jobs` | >30 min |

---

## Immediate Response (0–5 min)

1. **Open an incident** in your incident management tool.
2. **Notify on-call** — page the database and platform teams.
3. **Check DB reachability**:
   ```bash
   npx tsx server/lib/migrations/migration-guard.ts --ci
   ```
4. **Enable maintenance mode** — set `MAINTENANCE_MODE=true` in environment.
5. **Check Supabase status** at [status.supabase.com](https://status.supabase.com).

---

## Diagnosis (5–15 min)

### Connection failure
```bash
# Check connection string
echo $SUPABASE_DB_POOL_URL | sed 's/:[^:]*@/:*****@/'

# Test direct connectivity
npx tsx -e "
import { Client } from 'pg';
const c = new Client({ connectionString: process.env.SUPABASE_DB_POOL_URL, ssl: { rejectUnauthorized: false } });
c.connect().then(() => console.log('Connected')).catch(e => console.error(e.message));
"
```

### Schema drift
```bash
npx tsx scripts/validate-schema.ts
```

### Table corruption
Check table health using the backup validator:
```bash
npx tsx -e "
import('./server/lib/backup/backup-validator.js').then(async m => {
  const r = await m.getBackupHealthReport();
  console.log(JSON.stringify(r, null, 2));
});
"
```

---

## Recovery Options

### Option A — Supabase PITR (preferred)
1. Go to **Supabase Dashboard → Project → Backups**.
2. Select **Point in Time Recovery**.
3. Choose target timestamp (before failure).
4. Follow the `full_database` restore plan:
   ```bash
   npx tsx -e "
   import('./server/lib/backup/restore-tools.js').then(async m => {
     const plan = await m.planFullDbRestore();
     console.log(JSON.stringify(plan, null, 2));
   });
   "
   ```
5. Execute the `requiredSteps` from the plan output.

### Option B — Single-table restore
```bash
npx tsx -e "
import('./server/lib/backup/restore-tools.js').then(async m => {
  const plan = await m.planTableRestore('TABLE_NAME');
  console.log(JSON.stringify(plan, null, 2));
});
"
```

---

## Post-Recovery Validation

```bash
# 1. Schema validation
npx tsx scripts/validate-schema.ts

# 2. Migration guard
npx tsx server/lib/migrations/migration-guard.ts --ci

# 3. Full platform validation
npx tsx validate-phase28.ts
```

---

## Escalation

| Severity | Escalation |
|----------|-----------|
| DB down > 10 min | Page Supabase Enterprise support |
| PITR restore needed | CTO + Legal (if legal holds involved) |
| Data loss confirmed | Activate data breach protocol |

---

## Post-Incident

- Write incident report within 24h
- Update retention policy if corruption was caused by retention job
- Review backup validator schedule
