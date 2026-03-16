# Runbook: Region Outage

**Severity**: P0 (Critical)
**Owner**: Platform On-Call + Leadership
**Last Updated**: 2026-03-16

---

## Overview

A region outage affects all platform services hosted in that region.
The AI Builder Platform is hosted on Supabase (managed) and Replit (compute).

---

## Detection

| Signal | Source |
|--------|--------|
| All API endpoints returning 5xx | Load balancer / monitoring |
| Supabase status page shows degraded | [status.supabase.com](https://status.supabase.com) |
| Replit deployment unreachable | [replit.com status](https://replit.com) |
| OpenAI API outage (partial) | [status.openai.com](https://status.openai.com) |

---

## Immediate Response (0–10 min)

1. **Declare incident** — open war room immediately.
2. **Check status pages**:
   - [status.supabase.com](https://status.supabase.com)
   - [status.openai.com](https://status.openai.com)
   - [replit.com](https://replit.com)

3. **Notify stakeholders** — CTO, customer success, affected enterprise tenants.

4. **Enable maintenance page** — communicate expected downtime.

5. **Preserve state** — do NOT restart services until region is confirmed stable.

---

## Degraded Mode Options

### Disable AI features (keep platform operational)
```bash
# Set env var to disable AI inference
OPENAI_AI_DISABLED=true
```

### Queue isolation
Stall new job intake to prevent queue corruption:
```sql
-- Pause ingestion (manual operator step)
UPDATE knowledge_processing_jobs
SET status = 'queued'
WHERE status = 'running' AND started_at < NOW() - INTERVAL '5 minutes';
```

---

## Recovery

### When region recovers

1. **Verify DB connectivity**:
   ```bash
   npx tsx server/lib/migrations/migration-guard.ts --ci
   ```

2. **Validate schema**:
   ```bash
   npx tsx scripts/validate-schema.ts
   ```

3. **Run job recovery** — stalled jobs from outage window:
   ```bash
   npx tsx -e "
   import('./server/lib/recovery/job-recovery.js').then(async m => {
     const r = await m.runJobRecovery(120, false); // 2h threshold
     console.log(JSON.stringify(r, null, 2));
   });
   "
   ```

4. **Replay failed webhooks** from outage window:
   ```bash
   npx tsx -e "
   import('./server/lib/recovery/webhook-replay.js').then(async m => {
     const r = await m.replayFailedDeliveries(undefined, 200, false);
     console.log(JSON.stringify(r, null, 2));
   });
   "
   ```

5. **Stripe reconciliation** — detect billing desync:
   ```bash
   npx tsx -e "
   import('./server/lib/recovery/stripe-reconcile.js').then(async m => {
     const r = await m.runStripeReconciliation();
     console.log(JSON.stringify(r, null, 2));
   });
   "
   ```

6. **Full platform validation**:
   ```bash
   npx tsx validate-phase28.ts
   ```

7. **Disable maintenance mode** and monitor error rates for 15 min.

---

## Communication Templates

### Internal (immediate)
> INCIDENT ACTIVE: Region outage detected. All services are down.
> ETA unknown. War room open: [link].

### Customer-facing (15 min)
> We are currently experiencing a service disruption.
> Our team is actively investigating. We will provide updates every 30 minutes.

### Resolution
> Service has been restored as of [TIME].
> A full incident report will be published within 48 hours.

---

## Post-Incident

- Publish RCA within 48h
- Review multi-region strategy
- Improve status page communication speed
- Update SLAs if breach occurred
