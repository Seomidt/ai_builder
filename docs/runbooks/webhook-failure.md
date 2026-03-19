# Runbook: Webhook Failure

**Severity**: P1 (High)
**Owner**: Platform On-Call
**Last Updated**: 2026-03-16

---

## Overview

Webhook deliveries fail when the platform cannot deliver events to registered endpoints.
Failures accumulate in `webhook_deliveries` with `status='failed'`.

---

## Detection

| Signal | Threshold |
|--------|-----------|
| `webhook_deliveries.status='failed'` count growing | >10 in 5 min |
| `attempts >= max_attempts` with no `delivered_at` | Exhausted retries |
| `/api/admin/recovery/webhook-replay` health shows `totalFailed > 0` | Immediate |
| Endpoint returning 5xx consistently | Pattern in `http_status_code` |

---

## Immediate Response (0–5 min)

1. **Check webhook replay health**:
   ```bash
   curl -H 'x-admin-secret: admin' http://localhost:5000/api/admin/recovery/webhook-replay \
     -X POST -H 'Content-Type: application/json' -d '{"dryRun":true}'
   ```

2. **Query failed deliveries**:
   ```sql
   SELECT endpoint_id, event_type, attempts, max_attempts, http_status_code, last_error
   FROM webhook_deliveries
   WHERE status IN ('failed','retrying')
   ORDER BY created_at DESC
   LIMIT 20;
   ```

3. **Identify error pattern** — is it one endpoint or all?

---

## Diagnosis

### All endpoints failing (platform-side issue)
Check if the delivery worker is running and can reach the internet:
```bash
curl -s http://localhost:5000/api/admin/platform/deploy-health | jq .
```

### Single endpoint failing (endpoint-side issue)
```sql
SELECT endpoint_id, http_status_code, last_error, COUNT(*)
FROM webhook_deliveries
WHERE status = 'failed'
GROUP BY endpoint_id, http_status_code, last_error
ORDER BY COUNT(*) DESC;
```

### Check endpoint configuration:
```sql
SELECT id, url, is_active, failure_count
FROM webhook_endpoints
WHERE id = 'ENDPOINT_ID';
```

---

## Recovery

### Replay failed deliveries (dry-run first)
```bash
# Dry run
npx tsx -e "
import('./server/lib/recovery/webhook-replay.js').then(async m => {
  const result = await m.replayFailedDeliveries(undefined, 50, true);
  console.log(JSON.stringify(result, null, 2));
});
"

# Execute replay
npx tsx -e "
import('./server/lib/recovery/webhook-replay.js').then(async m => {
  const result = await m.replayFailedDeliveries(undefined, 50, false);
  console.log('Replayed:', result.replayed, '/', result.totalFailed);
});
"
```

### Replay for specific tenant
```bash
npx tsx -e "
import('./server/lib/recovery/webhook-replay.js').then(async m => {
  const result = await m.replayFailedDeliveries('TENANT_ID', 100, false);
  console.log(JSON.stringify(result, null, 2));
});
"
```

### Replay single delivery
```bash
npx tsx -e "
import('./server/lib/recovery/webhook-replay.js').then(async m => {
  const result = await m.replayDelivery('DELIVERY_ID', false);
  console.log(JSON.stringify(result, null, 2));
});
"
```

### Disable a broken endpoint
```sql
UPDATE webhook_endpoints
SET is_active = FALSE
WHERE id = 'ENDPOINT_ID';
```

---

## Prevention

- Run `getWebhookReplayHealth()` on a schedule (every 10 min)
- Alert when `totalFailed > 20` or `exhausted > 5`
- Set up automatic retry with exponential backoff
- Consider dead-letter queue for exhausted deliveries

---

## Escalation

| Condition | Action |
|-----------|--------|
| > 100 failed deliveries | Notify affected tenants |
| Core events not delivered (billing, auth) | P0 escalation |
| Systematic endpoint failure (all tenants) | Platform team + networking review |

---

## Post-Incident

- Review `last_error` and `http_status_code` patterns
- Increase `max_attempts` if endpoint was transiently down
- Consider circuit breaker for endpoints with >5 consecutive failures
- Document if the failure was caused by a deploy or configuration change
