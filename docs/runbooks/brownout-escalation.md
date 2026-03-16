# Runbook: Brownout Escalation

**Severity**: P1 (High) → P0 (Critical) at critical level
**Owner**: Platform On-Call
**Last Updated**: 2026-03-16

---

## Overview

Brownout mode is a controlled degradation system that protects core platform flows
(auth, billing, quota, retrieval, Stripe webhooks, recovery endpoints) under system pressure.

### Brownout Levels

| Level | Trigger | Impact |
|-------|---------|--------|
| normal | score < 8 | No degradation |
| elevated | score 8–27 | Defer non-critical exports and cleanup |
| degraded | score 28–39 | + Throttle webhooks, agent concurrency, evaluations |
| critical | score ≥ 40 | Only core flows preserved |

---

## Detection

| Signal | Source |
|--------|--------|
| `GET /api/admin/recovery/pressure` returns level ≠ normal | Monitoring |
| `GET /api/admin/recovery/brownout` shows `active: true` | Monitoring |
| Error rate spike in non-core services | App logs |
| Queue depth growing faster than processing | Job health |

---

## Escalation from Normal → Elevated

### Trigger conditions (any 2 signals breached)
- Queue depth > 50 jobs
- Webhook failure rate > 10%
- Rate limit triggers > 20 in last hour

### Response
1. **Observe** — confirm pressure via API:
   ```bash
   curl http://localhost:5000/api/admin/recovery/pressure
   ```

2. **Review pressure signals**:
   ```bash
   npx tsx -e "
   import('./server/lib/recovery/system-pressure.js').then(async m => {
     const p = await m.getSystemPressure();
     console.log(JSON.stringify(p, null, 2));
   });
   "
   ```

3. **Manually enter elevated mode** (if auto not triggered):
   ```bash
   npx tsx -e "
   import('./server/lib/recovery/brownout-mode.js').then(m => {
     const r = m.enterBrownoutMode('elevated', 'Manual: queue pressure observed', true);
     console.log(JSON.stringify(r, null, 2));
   });
   "
   ```

4. **Verify deferred flows** — non-critical exports and cleanup should be paused.

---

## Escalation from Elevated → Degraded

### Trigger conditions (score ≥ 28 or any 1 critical signal)
- Stalled jobs > 20
- Webhook failure rate > 30%

### Response
1. **Enter degraded mode**:
   ```bash
   curl -X GET http://localhost:5000/api/admin/recovery/brownout
   ```
   Auto-applies if pressure > elevated. To force:
   ```bash
   npx tsx -e "
   import('./server/lib/recovery/brownout-mode.js').then(m => {
     m.enterBrownoutMode('degraded', 'Manual escalation: webhook failure spike', true);
     console.log(m.getBrownoutState());
   });
   "
   ```

2. **Verify throttled flows** — webhook retries, agent concurrency, evaluation throughput reduced.

3. **Run job recovery** to clear stalled jobs:
   ```bash
   curl -X POST http://localhost:5000/api/admin/recovery/job-recovery \
     -H 'Content-Type: application/json' \
     -d '{"dryRun": false}'
   ```

---

## Escalation from Degraded → Critical

### Trigger conditions (score ≥ 40 or 2+ critical signals)
- Queue depth > 500 jobs
- Stalled jobs > 50

### Response — IMMEDIATE ACTION

1. **Enter critical mode**:
   ```bash
   npx tsx -e "
   import('./server/lib/recovery/brownout-mode.js').then(m => {
     m.enterBrownoutMode('critical', 'P0: queue critical, immediate escalation', true);
     console.log(m.summarizeBrownoutState());
   });
   "
   ```

2. **Verify core flows still responding**:
   ```bash
   curl http://localhost:5000/api/admin/platform/deploy-health
   ```

3. **Page CTO and all on-call engineers**.

4. **Stop non-essential background work** immediately.

5. **Check for root cause**:
   - Database slow? → Follow `database-failure.md`
   - Webhook storm? → Follow `webhook-failure.md`
   - Region issue? → Follow `region-outage.md`

---

## Monitoring During Brownout

```bash
# Watch pressure every 30 seconds
while true; do
  curl -s http://localhost:5000/api/admin/recovery/pressure | jq '.level,.score'
  sleep 30
done
```

---

## Escalation Path

| Brownout level | Notify |
|----------------|--------|
| elevated | Slack ops channel |
| degraded | On-call engineer page |
| critical | Full incident — CTO + all on-call |
