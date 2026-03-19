# Runbook: Brownout Recovery

**Severity**: Matches active brownout level
**Owner**: Platform On-Call
**Last Updated**: 2026-03-16

---

## Overview

This runbook covers recovery from brownout mode back to normal operation.
Brownout recovery must be deliberate — do NOT exit brownout prematurely.

**Recovery checklist before exiting brownout:**
1. Pressure score < 8 (normal threshold)
2. No stalled jobs outstanding
3. Webhook failure rate < 10%
4. Core flows verified healthy

---

## Step-by-Step Recovery

### Phase 1: Verify pressure is reducing

```bash
curl http://localhost:5000/api/admin/recovery/pressure
```

Expected:
```json
{
  "level": "normal",
  "score": 0
}
```

If score still elevated — do NOT exit brownout yet.

### Phase 2: Clear stalled jobs

```bash
curl -X POST http://localhost:5000/api/admin/recovery/job-recovery \
  -H 'Content-Type: application/json' \
  -d '{"dryRun": false, "stallThresholdMinutes": 15}'
```

Verify queue health:
```bash
npx tsx -e "
import('./server/lib/recovery/job-recovery.js').then(async m => {
  const snap = await m.getQueueHealthSnapshot();
  console.log('stalled:', snap.stalled, 'running:', snap.running, 'queued:', snap.queued);
});
"
```

### Phase 3: Clear failed webhooks (if brownout was webhook-triggered)

```bash
curl -X POST http://localhost:5000/api/admin/recovery/webhook-replay \
  -H 'Content-Type: application/json' \
  -d '{"dryRun": false, "limit": 100}'
```

### Phase 4: Verify Stripe reconciliation

```bash
curl http://localhost:5000/api/admin/recovery/stripe-reconcile
```

Expected: `report.criticalIssues === 0`

### Phase 5: Exit brownout mode

**Automated exit** (auto-triggers when pressure returns to normal):

The `applyBrownoutPolicy()` function is called on every pressure check. If pressure
returns to normal, brownout exits automatically (unless manual override is set).

**Manual exit** (if manual override was used):

```bash
npx tsx -e "
import('./server/lib/recovery/brownout-mode.js').then(m => {
  const r = m.exitBrownoutMode('Pressure normalized — manual recovery complete', true);
  console.log(JSON.stringify(r, null, 2));
});
"
```

### Phase 6: Verify core flows

```bash
# Deploy health check
curl http://localhost:5000/api/admin/platform/deploy-health

# Backup status
curl http://localhost:5000/api/admin/recovery/backup-status

# Pressure confirmation
curl http://localhost:5000/api/admin/recovery/pressure
```

Expected:
```json
{
  "level": "normal",
  "score": 0,
  "signals": [/* all low severity */]
}
```

### Phase 7: Review brownout history

```bash
curl http://localhost:5000/api/admin/recovery/brownout-history
```

Document:
- Total transition count
- Duration at each level
- Root cause (stalled jobs, webhook storm, etc.)

---

## Validation Commands

```bash
# Full Phase 29 validation (confirms all recovery tooling)
npx tsx validate-phase29.ts

# Schema validation
npx tsx scripts/validate-schema.ts
```

---

## Stepdown Protocol (Critical → Degraded → Elevated → Normal)

For a controlled stepdown from critical, reduce by one level at a time:

```bash
# Critical → Degraded
npx tsx -e "
import('./server/lib/recovery/brownout-mode.js').then(m => {
  m.enterBrownoutMode('degraded', 'Stepdown: critical resolved', true);
});
"
# Wait 5 min, verify metrics
# Degraded → Elevated
npx tsx -e "
import('./server/lib/recovery/brownout-mode.js').then(m => {
  m.enterBrownoutMode('elevated', 'Stepdown: degraded resolved', true);
});
"
# Wait 5 min, verify metrics
# Elevated → Normal
npx tsx -e "
import('./server/lib/recovery/brownout-mode.js').then(m => {
  m.exitBrownoutMode('Stepdown complete: returning to normal', true);
});
"
```

---

## Post-Recovery

- Write incident summary in Slack ops channel
- Review pressure signal thresholds (were they too sensitive?)
- Consider adding more observability to the root cause signal
- Update this runbook with any new patterns discovered
