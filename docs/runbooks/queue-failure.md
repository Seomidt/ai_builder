# Runbook: Queue Failure

**Severity**: P1 (High)
**Owner**: Platform On-Call
**Last Updated**: 2026-03-16

---

## Overview

This runbook covers failures in the knowledge processing job queue.
Jobs are stored in `knowledge_processing_jobs` and processed by the platform workers.

---

## Detection

| Signal | Threshold |
|--------|-----------|
| Jobs stuck in `running` > 30 min | Stalled job detected |
| High failed job count | >10% failure rate |
| `/api/admin/ops/jobs` shows queued count growing | Unbounded growth |
| Workers not processing queued jobs | Queue depth stable > 5 min |

---

## Immediate Response (0–5 min)

1. **Check queue health**:
   ```bash
   curl -s http://localhost:5000/api/admin/ops/jobs
   ```

2. **Detect stalled jobs** using the recovery module:
   ```bash
   npx tsx -e "
   import('./server/lib/recovery/job-recovery.js').then(async m => {
     const snapshot = await m.getQueueHealthSnapshot();
     console.log(JSON.stringify(snapshot, null, 2));
   });
   "
   ```

3. **Check worker process** — confirm the application is running.

---

## Diagnosis

### Stalled jobs (running too long)
```bash
npx tsx -e "
import('./server/lib/recovery/job-recovery.js').then(async m => {
  const stalled = await m.detectStalledJobs(30); // 30 min threshold
  console.log('Stalled jobs:', stalled.length);
  console.log(JSON.stringify(stalled.slice(0, 5), null, 2));
});
"
```

### Failed jobs (exhausted retries)
```sql
SELECT id, tenant_id, job_type, attempt_count, max_attempts, failure_reason
FROM knowledge_processing_jobs
WHERE status = 'failed'
ORDER BY created_at DESC
LIMIT 20;
```

---

## Recovery

### Requeue stalled jobs (dry-run first)
```bash
# Dry run — see what would happen
npx tsx -e "
import('./server/lib/recovery/job-recovery.js').then(async m => {
  const result = await m.runJobRecovery(30, true); // dryRun=true
  console.log(JSON.stringify(result, null, 2));
});
"

# Execute recovery
npx tsx -e "
import('./server/lib/recovery/job-recovery.js').then(async m => {
  const result = await m.runJobRecovery(30, false);
  console.log(JSON.stringify(result, null, 2));
});
"
```

### Retry failed jobs for a specific tenant
```bash
npx tsx -e "
import('./server/lib/recovery/job-recovery.js').then(async m => {
  const results = await m.retryFailedJobs('TENANT_ID', 50, false);
  console.log(JSON.stringify(results, null, 2));
});
"
```

### Single job requeue
```bash
npx tsx -e "
import('./server/lib/recovery/job-recovery.js').then(async m => {
  const result = await m.requeueJob('JOB_ID', false);
  console.log(JSON.stringify(result, null, 2));
});
"
```

---

## Prevention

- Monitor queue depth via `/api/admin/ops/jobs`
- Set up alerts when `stalled > 5` or `failed > 20`
- Run `runJobRecovery()` on a schedule (every 15 min in production)

---

## Escalation

| Condition | Action |
|-----------|--------|
| All queues frozen > 15 min | Restart application |
| DB connection issues causing failures | Follow database-failure runbook |
| Specific tenant consistently failing | Isolate tenant, review payload |

---

## Post-Incident

- Review `failure_reason` for patterns
- Consider increasing `max_attempts` for idempotent jobs
- Document if external service (OpenAI, Supabase) caused the failures
