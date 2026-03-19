# Runbook: Billing Desync

**Severity**: P1 (High) — P0 if revenue impact confirmed
**Owner**: Platform On-Call + Finance
**Last Updated**: 2026-03-16

---

## Overview

Billing desync occurs when the platform's internal subscription state diverges
from Stripe's state. This can cause tenants to have access they shouldn't,
or be charged incorrectly.

---

## Detection

| Signal | Tool |
|--------|------|
| `stripe_subscriptions.status` ≠ `tenant_subscriptions.status` | Stripe reconciliation |
| Invoices with multiple failed payments | `/api/admin/ops/billing` |
| Active subscriptions with expired `current_period_end` | Reconciliation report |
| Tenant complains about billing but platform shows active | Customer support |

---

## Immediate Response (0–5 min)

1. **Run reconciliation report** (read-only, safe):
   ```bash
   npx tsx -e "
   import('./server/lib/recovery/stripe-reconcile.js').then(async m => {
     const r = await m.runStripeReconciliation();
     console.log(JSON.stringify(r, null, 2));
   });
   "
   ```

2. **Check billing health** via API:
   ```bash
   curl -H 'x-admin-secret: admin' http://localhost:5000/api/admin/ops/billing
   ```

3. **Identify affected tenants** from `subscriptionDesyncs` and `missingPayments`.

---

## Diagnosis

### Missing payments (expired but still active)
```sql
SELECT ss.tenant_id, ss.stripe_subscription_id,
       ss.current_period_end, ss.status
FROM stripe_subscriptions ss
WHERE ss.status IN ('active','trialing')
  AND ss.current_period_end < NOW()
ORDER BY ss.current_period_end ASC;
```

### Subscription desync
```sql
SELECT ss.tenant_id, ss.stripe_subscription_id,
       ss.status AS stripe_status,
       ts.status AS internal_status
FROM stripe_subscriptions ss
JOIN tenant_subscriptions ts ON ts.tenant_id = ss.tenant_id
WHERE ss.status <> ts.status;
```

### Invoice failures
```sql
SELECT tenant_id, stripe_invoice_id, amount, currency,
       status, payment_attempts, last_payment_error
FROM stripe_invoices
WHERE status IN ('open','uncollectible')
  AND payment_attempts >= 2
ORDER BY payment_attempts DESC;
```

---

## Recovery

### Sync subscription status from Stripe
The platform should re-fetch the Stripe subscription via the Stripe API and
update the local record. Use Stripe's dashboard or API to verify the ground truth.

```bash
# Use Stripe CLI to verify (requires Stripe CLI installed)
stripe subscriptions retrieve STRIPE_SUB_ID
```

### Manual status correction (operator-only, use carefully)
```sql
-- ALWAYS verify in Stripe dashboard first
-- Only run after Finance approval
UPDATE stripe_subscriptions
SET status = 'canceled', canceled_at = NOW()
WHERE stripe_subscription_id = 'STRIPE_SUB_ID';

UPDATE tenant_subscriptions
SET status = 'cancelled'
WHERE tenant_id = 'TENANT_ID';
```

### Re-sync subscription health summary
```bash
npx tsx -e "
import('./server/lib/recovery/stripe-reconcile.js').then(async m => {
  const r = await m.getSubscriptionHealthSummary();
  console.log(JSON.stringify(r, null, 2));
});
"
```

---

## Prevention

- Run `runStripeReconciliation()` on a daily schedule
- Set up Stripe webhooks for `customer.subscription.updated` and `invoice.payment_failed`
- Alert when `desynced > 0` or `missingPayments > 0`

---

## Escalation

| Condition | Action |
|-----------|--------|
| > 5 tenants affected | Finance + CTO notification |
| Revenue discrepancy confirmed | Immediate finance review |
| Tenant data at risk | Legal + DPO involvement |
| Stripe API itself down | Follow region-outage runbook |

---

## Post-Incident

- Document which event caused desync (webhook failure, region outage, deploy issue)
- Verify all affected tenants were correctly notified
- Improve webhook reliability (replay failed deliveries runbook)
- Consider automatic reconciliation on subscription events
