/**
 * Phase 22 — Validation Script
 * Stripe Billing Integration
 *
 * Run: npx tsx server/lib/stripe/validate-phase22.ts
 * Target: 60 scenarios, 150+ assertions
 */

import pg from "pg";

const DB_URL = process.env.SUPABASE_DB_POOL_URL ?? process.env.DATABASE_URL;
if (!DB_URL) throw new Error("SUPABASE_DB_POOL_URL or DATABASE_URL required");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string) {
  if (condition) { console.log(`  ✔ ${label}`); passed++; }
  else { console.log(`  ✗ FAIL: ${label}`); failed++; failures.push(label); }
}
function section(title: string) { console.log(`\n── ${title} ──`); }

const T_A = "stripe-test-tenant-A";
const T_B = "stripe-test-tenant-B";
const T_C = "stripe-test-tenant-C";

async function main() {
  console.log("Phase 22 Validation — Stripe Billing Integration\n");

  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();

  // Pre-cleanup: remove any leftover data from previous runs
  await client.query(`DELETE FROM stripe_webhook_events WHERE tenant_id IN ('${T_A}','${T_B}','${T_C}','route-test-tenant','stripe-test-temp-delete')`);
  await client.query(`DELETE FROM stripe_invoices WHERE tenant_id IN ('${T_A}','${T_B}','${T_C}','route-test-tenant','stripe-test-temp-delete')`);
  await client.query(`DELETE FROM stripe_subscriptions WHERE tenant_id IN ('${T_A}','${T_B}','${T_C}','route-test-tenant','stripe-test-temp-delete')`);
  await client.query(`DELETE FROM stripe_customers WHERE tenant_id IN ('${T_A}','${T_B}','${T_C}','route-test-tenant','stripe-test-temp-delete')`);

  const { upsertStripeCustomer, getStripeCustomer, getStripeCustomerByStripeId,
    updateStripeCustomer, listStripeCustomers, deleteStripeCustomer, getTenantFromStripeCustomer } =
    await import("./customer-service");

  const { createStripeSubscription, getStripeSubscription, getStripeSubscriptionByStripeId,
    updateStripeSubscription, cancelStripeSubscription, listStripeSubscriptions,
    syncPlanFromSubscription, getSubscriptionChurnMetrics, getRevenueMetrics } =
    await import("./subscription-service");

  const { upsertStripeInvoice, getStripeInvoice, listStripeInvoices,
    markInvoicePaid, markInvoicePaymentFailed, voidInvoice,
    getPaymentFailureMetrics, getRevenueFromInvoices } =
    await import("./invoice-service");

  const { handleStripeWebhook, isEventAlreadyProcessed, getWebhookEventLog, getWebhookStats } =
    await import("./webhook-handler");

  const { generateStripeId, stripeIds, STRIPE_EVENT_TYPES,
    buildStripeEvent, buildStripeCustomerObject, buildStripeSubscriptionObject,
    buildStripeInvoiceObject, getPlanAmount, STRIPE_PLAN_PRICE_MAP } =
    await import("./stripe-client");

  // ── SCENARIO 1: DB schema — 4 Phase 22 tables present ────────────────────
  section("SCENARIO 1: DB schema — 4 tables present");
  const tableCheck = await client.query(`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
      AND table_name IN ('stripe_customers','stripe_subscriptions','stripe_invoices','stripe_webhook_events')
  `);
  assert(tableCheck.rows.length === 4, "All 4 Phase 22 tables exist");
  const tnames = tableCheck.rows.map((r: Record<string, unknown>) => r.table_name as string);
  assert(tnames.includes("stripe_customers"), "stripe_customers exists");
  assert(tnames.includes("stripe_subscriptions"), "stripe_subscriptions exists");
  assert(tnames.includes("stripe_invoices"), "stripe_invoices exists");
  assert(tnames.includes("stripe_webhook_events"), "stripe_webhook_events exists");

  // ── SCENARIO 2: DB schema — indexes ──────────────────────────────────────
  section("SCENARIO 2: DB schema — indexes present");
  const idxCheck = await client.query(`
    SELECT COUNT(*) AS cnt FROM pg_indexes WHERE schemaname = 'public'
      AND tablename IN ('stripe_customers','stripe_subscriptions','stripe_invoices','stripe_webhook_events')
  `);
  assert(Number(idxCheck.rows[0].cnt) >= 10, `At least 10 indexes (found ${idxCheck.rows[0].cnt})`);

  // ── SCENARIO 3: DB schema — RLS on all 4 tables ───────────────────────────
  section("SCENARIO 3: DB schema — RLS enabled");
  const rlsCheck = await client.query(`
    SELECT COUNT(*) AS cnt FROM pg_tables WHERE schemaname = 'public'
      AND tablename IN ('stripe_customers','stripe_subscriptions','stripe_invoices','stripe_webhook_events')
      AND rowsecurity = true
  `);
  assert(Number(rlsCheck.rows[0].cnt) === 4, "RLS enabled on all 4 tables");

  // ── SCENARIO 4: generateStripeId — correct prefix ─────────────────────────
  section("SCENARIO 4: generateStripeId — correct format");
  const custId4 = generateStripeId("cus");
  assert(custId4.startsWith("cus_"), "cus_ prefix");
  assert(custId4.length > 8, "ID has sufficient length");
  const subId4 = stripeIds.subscription();
  assert(subId4.startsWith("sub_"), "sub_ prefix");
  const invId4 = stripeIds.invoice();
  assert(invId4.startsWith("in_"), "in_ prefix");

  // ── SCENARIO 5: getPlanAmount — correct amounts ────────────────────────────
  section("SCENARIO 5: getPlanAmount — plan price mapping");
  assert(getPlanAmount("free") === 0, "free = 0 cents");
  assert(getPlanAmount("starter") === 2900, "starter = $29.00");
  assert(getPlanAmount("professional") === 9900, "professional = $99.00");
  assert(getPlanAmount("enterprise") === 49900, "enterprise = $499.00");

  // ── SCENARIO 6: buildStripeEvent — correct structure ─────────────────────
  section("SCENARIO 6: buildStripeEvent — correct structure");
  const evt6 = buildStripeEvent(STRIPE_EVENT_TYPES.CUSTOMER_CREATED, { id: "cus_test" });
  assert(typeof evt6.id === "string", "event has id");
  assert(evt6.id.startsWith("evt_"), "event id has evt_ prefix");
  assert(evt6.type === "customer.created", "event type correct");
  assert(typeof evt6.created === "number", "event.created is number");
  assert(evt6.data.object.id === "cus_test", "event object present");

  // ── SCENARIO 7: buildStripeCustomerObject ─────────────────────────────────
  section("SCENARIO 7: buildStripeCustomerObject — correct structure");
  const cobj7 = buildStripeCustomerObject({ customerId: "cus_abc", email: "test@test.com", tenantId: T_A });
  assert(cobj7.id === "cus_abc", "customer id present");
  assert(cobj7.object === "customer", "object type correct");
  assert((cobj7.metadata as Record<string, string>).tenant_id === T_A, "tenant_id in metadata");

  // ── SCENARIO 8: buildStripeSubscriptionObject ─────────────────────────────
  section("SCENARIO 8: buildStripeSubscriptionObject — correct structure");
  const sobj8 = buildStripeSubscriptionObject({ subscriptionId: "sub_abc", customerId: "cus_abc", planKey: "professional" });
  assert(sobj8.id === "sub_abc", "subscription id present");
  assert(sobj8.object === "subscription", "object type correct");
  assert(sobj8.status === "active", "default status active");
  assert((sobj8.plan as Record<string, unknown>).amount === 9900, "plan amount correct");

  // ── SCENARIO 9: upsertStripeCustomer — creates customer ──────────────────
  section("SCENARIO 9: upsertStripeCustomer — creates customer");
  const c9 = await upsertStripeCustomer({ tenantId: T_A, email: "a@example.com" });
  assert(typeof c9.id === "string", "id returned");
  assert(typeof c9.stripeCustomerId === "string", "stripeCustomerId returned");
  assert(c9.stripeCustomerId.startsWith("cus_"), "stripeCustomerId has cus_ prefix");
  assert(c9.tenantId === T_A, "tenantId matches");
  assert(c9.isNew === true, "isNew = true on first create");

  // ── SCENARIO 10: upsertStripeCustomer — idempotent (returns same) ─────────
  section("SCENARIO 10: upsertStripeCustomer — idempotent");
  const c10 = await upsertStripeCustomer({ tenantId: T_A, email: "different@example.com" });
  assert(c10.stripeCustomerId === c9.stripeCustomerId, "Same stripeCustomerId returned");
  assert(c10.isNew === false, "isNew = false on second call");

  // ── SCENARIO 11: getStripeCustomer — retrieves customer ───────────────────
  section("SCENARIO 11: getStripeCustomer — retrieves by tenantId");
  const c11 = await getStripeCustomer(T_A);
  assert(c11 !== null, "Customer found");
  assert(c11!.tenant_id === T_A, "tenantId matches");
  assert(c11!.email === "a@example.com", "email matches");

  // ── SCENARIO 12: getStripeCustomerByStripeId ──────────────────────────────
  section("SCENARIO 12: getStripeCustomerByStripeId — retrieves by stripe ID");
  const c12 = await getStripeCustomerByStripeId(c9.stripeCustomerId);
  assert(c12 !== null, "Customer found by stripe ID");
  assert(c12!.tenant_id === T_A, "tenantId matches");

  // ── SCENARIO 13: updateStripeCustomer — updates email ─────────────────────
  section("SCENARIO 13: updateStripeCustomer — updates email");
  await updateStripeCustomer(T_A, { email: "updated@example.com" });
  const c13 = await getStripeCustomer(T_A);
  assert(c13!.email === "updated@example.com", "Email updated");

  // ── SCENARIO 14: getTenantFromStripeCustomer ──────────────────────────────
  section("SCENARIO 14: getTenantFromStripeCustomer — resolves tenant");
  const tenant14 = await getTenantFromStripeCustomer(c9.stripeCustomerId);
  assert(tenant14 === T_A, "Tenant resolved from stripe customer ID");
  const missing14 = await getTenantFromStripeCustomer("cus_nonexistent");
  assert(missing14 === null, "Null returned for unknown stripe customer ID");

  // ── SCENARIO 15: createStripeSubscription — creates subscription ──────────
  section("SCENARIO 15: createStripeSubscription — creates subscription");
  const sub15 = await createStripeSubscription({ tenantId: T_A, planKey: "professional" });
  assert(typeof sub15.id === "string", "id returned");
  assert(sub15.stripeSubscriptionId.startsWith("sub_"), "stripeSubscriptionId has sub_ prefix");
  assert(sub15.tenantId === T_A, "tenantId matches");

  // ── SCENARIO 16: getStripeSubscription — retrieves subscription ───────────
  section("SCENARIO 16: getStripeSubscription — retrieves by tenantId");
  const sub16 = await getStripeSubscription(T_A);
  assert(sub16 !== null, "Subscription found");
  assert(sub16!.plan_key === "professional", "plan_key matches");
  assert(sub16!.status === "active", "status is active");

  // ── SCENARIO 17: getStripeSubscriptionByStripeId ─────────────────────────
  section("SCENARIO 17: getStripeSubscriptionByStripeId");
  const sub17 = await getStripeSubscriptionByStripeId(sub15.stripeSubscriptionId);
  assert(sub17 !== null, "Subscription found by stripe ID");
  assert(sub17!.tenant_id === T_A, "tenantId matches");

  // ── SCENARIO 18: updateStripeSubscription — updates status ───────────────
  section("SCENARIO 18: updateStripeSubscription — updates status and plan");
  const result18 = await updateStripeSubscription(sub15.stripeSubscriptionId, {
    status: "past_due",
    planKey: "starter",
  });
  assert(result18.updated === true, "Subscription updated");
  assert(result18.tenantId === T_A, "tenantId returned");
  const sub18 = await getStripeSubscription(T_A);
  assert(sub18!.status === "past_due", "Status updated to past_due");
  assert(sub18!.plan_key === "starter", "Plan updated to starter");

  // ── SCENARIO 19: cancelStripeSubscription ────────────────────────────────
  section("SCENARIO 19: cancelStripeSubscription");
  const canc19 = await cancelStripeSubscription(sub15.stripeSubscriptionId);
  assert(canc19.canceled === true, "Subscription canceled");
  assert(canc19.tenantId === T_A, "tenantId returned");
  const sub19 = await getStripeSubscription(T_A);
  assert(sub19!.status === "canceled", "Status is canceled");

  // ── SCENARIO 20: createStripeSubscription — creates for T_B ──────────────
  section("SCENARIO 20: createStripeSubscription — tenant B");
  const subB20 = await createStripeSubscription({ tenantId: T_B, planKey: "enterprise" });
  assert(subB20.tenantId === T_B, "Tenant B subscription created");
  const subB20get = await getStripeSubscription(T_B);
  assert(subB20get!.plan_key === "enterprise", "Tenant B plan is enterprise");

  // ── SCENARIO 21: listStripeSubscriptions ─────────────────────────────────
  section("SCENARIO 21: listStripeSubscriptions — list by tenant");
  const subs21 = await listStripeSubscriptions(T_A);
  assert(Array.isArray(subs21), "Returns array");
  assert(subs21.length >= 1, "At least 1 subscription for T_A");

  // ── SCENARIO 22: upsertStripeInvoice — creates invoice ───────────────────
  section("SCENARIO 22: upsertStripeInvoice — creates invoice");
  const inv22 = await upsertStripeInvoice({
    tenantId: T_A,
    stripeCustomerId: c9.stripeCustomerId,
    amount: 9900,
    currency: "usd",
    status: "open",
  });
  assert(typeof inv22.id === "string", "id returned");
  assert(inv22.stripeInvoiceId.startsWith("in_"), "stripeInvoiceId has in_ prefix");
  assert(inv22.isNew === true, "isNew = true");

  // ── SCENARIO 23: upsertStripeInvoice — idempotent ────────────────────────
  section("SCENARIO 23: upsertStripeInvoice — idempotent (same invoice ID)");
  const inv23 = await upsertStripeInvoice({
    stripeInvoiceId: inv22.stripeInvoiceId,
    tenantId: T_A,
    amount: 9900,
    currency: "usd",
  });
  assert(inv23.id === inv22.id, "Same internal ID returned");
  assert(inv23.isNew === false, "isNew = false on duplicate");

  // ── SCENARIO 24: getStripeInvoice — retrieves invoice ────────────────────
  section("SCENARIO 24: getStripeInvoice — retrieves by stripe invoice ID");
  const inv24 = await getStripeInvoice(inv22.stripeInvoiceId);
  assert(inv24 !== null, "Invoice found");
  assert(inv24!.amount === 9900, "Amount matches");
  assert(inv24!.currency === "usd", "Currency matches");

  // ── SCENARIO 25: markInvoicePaid ─────────────────────────────────────────
  section("SCENARIO 25: markInvoicePaid — marks invoice paid");
  const r25 = await markInvoicePaid(inv22.stripeInvoiceId);
  assert(r25.updated === true, "markInvoicePaid returned updated=true");
  const inv25 = await getStripeInvoice(inv22.stripeInvoiceId);
  assert(inv25!.status === "paid", "Invoice status is paid");
  assert(inv25!.paid_at !== null, "paid_at is set");

  // ── SCENARIO 26: markInvoicePaymentFailed ────────────────────────────────
  section("SCENARIO 26: markInvoicePaymentFailed — records failure");
  const inv26raw = await upsertStripeInvoice({ tenantId: T_A, amount: 2900, currency: "usd" });
  const r26 = await markInvoicePaymentFailed(inv26raw.stripeInvoiceId, "Card declined");
  assert(r26.updated === true, "markInvoicePaymentFailed returned updated=true");
  assert(r26.attempts >= 1, "attempts >= 1");
  const inv26 = await getStripeInvoice(inv26raw.stripeInvoiceId);
  assert(inv26!.last_payment_error === "Card declined", "Error message stored");
  assert(Number(inv26!.payment_attempts) >= 1, "payment_attempts incremented");

  // ── SCENARIO 27: voidInvoice ──────────────────────────────────────────────
  section("SCENARIO 27: voidInvoice — voids invoice");
  const inv27raw = await upsertStripeInvoice({ tenantId: T_A, amount: 9900, currency: "usd" });
  await voidInvoice(inv27raw.stripeInvoiceId);
  const inv27 = await getStripeInvoice(inv27raw.stripeInvoiceId);
  assert(inv27!.status === "void", "Invoice status is void");

  // ── SCENARIO 28: listStripeInvoices ──────────────────────────────────────
  section("SCENARIO 28: listStripeInvoices — list by tenant");
  const invs28 = await listStripeInvoices(T_A);
  assert(Array.isArray(invs28), "Returns array");
  assert(invs28.length >= 3, "At least 3 invoices for T_A");

  // ── SCENARIO 29: listStripeInvoices — filter by status ───────────────────
  section("SCENARIO 29: listStripeInvoices — filter by status");
  const paidInvs29 = await listStripeInvoices(T_A, { status: "paid" });
  assert(Array.isArray(paidInvs29), "Returns array");
  assert(paidInvs29.every((i) => i.status === "paid"), "All returned invoices are paid");

  // ── SCENARIO 30: webhook — customer.created ───────────────────────────────
  section("SCENARIO 30: Webhook — customer.created");
  const cobj30 = buildStripeCustomerObject({ customerId: stripeIds.customer(), email: "c@c.com", tenantId: T_C });
  const evt30 = buildStripeEvent(STRIPE_EVENT_TYPES.CUSTOMER_CREATED, cobj30);
  const r30 = await handleStripeWebhook(evt30);
  assert(r30.skipped === false, "Event not skipped");
  assert(r30.eventId === evt30.id, "Event ID matches");
  assert(r30.tenantId === T_C, "Tenant C extracted");
  assert(!r30.error, `No error: ${r30.error ?? ""}`);

  // ── SCENARIO 31: webhook — idempotent (same event ID) ────────────────────
  section("SCENARIO 31: Webhook — idempotency (duplicate event skipped)");
  const r31 = await handleStripeWebhook(evt30);
  assert(r31.skipped === true, "Duplicate event skipped");

  // ── SCENARIO 32: isEventAlreadyProcessed ─────────────────────────────────
  section("SCENARIO 32: isEventAlreadyProcessed — idempotency check");
  assert(await isEventAlreadyProcessed(evt30.id) === true, "Processed event detected");
  assert(await isEventAlreadyProcessed("evt_nonexistent_xyz") === false, "Unknown event returns false");

  // ── SCENARIO 33: webhook — invoice.payment_succeeded ─────────────────────
  section("SCENARIO 33: Webhook — invoice.payment_succeeded");
  const subForC = await createStripeSubscription({ tenantId: T_C, planKey: "starter" });
  const invObjForC = buildStripeInvoiceObject({
    invoiceId: stripeIds.invoice(),
    customerId: (await getStripeCustomer(T_C))!.stripe_customer_id as string,
    tenantId: T_C,
    planKey: "starter",
    status: "paid",
  });
  const evt33 = buildStripeEvent(STRIPE_EVENT_TYPES.INVOICE_PAYMENT_SUCCEEDED, invObjForC);
  const r33 = await handleStripeWebhook(evt33);
  assert(r33.skipped === false, "Event processed");
  assert(!r33.error, `No error: ${r33.error ?? ""}`);
  const inv33 = await getStripeInvoice(invObjForC.id as string);
  assert(inv33!.status === "paid", "Invoice marked paid");

  // ── SCENARIO 34: webhook — invoice.payment_failed ────────────────────────
  section("SCENARIO 34: Webhook — invoice.payment_failed");
  const invObj34 = buildStripeInvoiceObject({
    invoiceId: stripeIds.invoice(),
    customerId: (await getStripeCustomer(T_C))!.stripe_customer_id as string,
    tenantId: T_C,
    planKey: "starter",
    status: "open",
    paymentError: "Insufficient funds",
  });
  const evt34 = buildStripeEvent(STRIPE_EVENT_TYPES.INVOICE_PAYMENT_FAILED, invObj34);
  const r34 = await handleStripeWebhook(evt34);
  assert(r34.skipped === false, "Event processed");
  assert(!r34.error, `No error: ${r34.error ?? ""}`);
  const inv34 = await getStripeInvoice(invObj34.id as string);
  assert(inv34 !== null, "Invoice created for failed payment");

  // ── SCENARIO 35: webhook — subscription.updated ───────────────────────────
  section("SCENARIO 35: Webhook — customer.subscription.updated");
  const subObj35 = buildStripeSubscriptionObject({
    subscriptionId: subForC.stripeSubscriptionId,
    customerId: (await getStripeCustomer(T_C))!.stripe_customer_id as string,
    planKey: "professional",
    status: "active",
  });
  (subObj35.metadata as Record<string, string>).plan_key = "professional";
  const evt35 = buildStripeEvent(STRIPE_EVENT_TYPES.SUBSCRIPTION_UPDATED, subObj35);
  const r35 = await handleStripeWebhook(evt35);
  assert(r35.skipped === false, "Event processed");
  assert(!r35.error, `No error: ${r35.error ?? ""}`);

  // ── SCENARIO 36: webhook — subscription.deleted ───────────────────────────
  section("SCENARIO 36: Webhook — customer.subscription.deleted");
  const subObj36 = buildStripeSubscriptionObject({
    subscriptionId: subForC.stripeSubscriptionId,
    customerId: (await getStripeCustomer(T_C))!.stripe_customer_id as string,
    planKey: "professional",
    status: "canceled",
  });
  const evt36 = buildStripeEvent(STRIPE_EVENT_TYPES.SUBSCRIPTION_DELETED, subObj36);
  const r36 = await handleStripeWebhook(evt36);
  assert(r36.skipped === false, "Event processed");
  const sub36 = await getStripeSubscription(T_C);
  assert(sub36!.status === "canceled", "Subscription canceled by webhook");

  // ── SCENARIO 37: webhook — unhandled event type ───────────────────────────
  section("SCENARIO 37: Webhook — unhandled event type handled gracefully");
  const evt37 = buildStripeEvent("unknown.event.type", { id: "obj_xyz" });
  const r37 = await handleStripeWebhook(evt37);
  assert(r37.skipped === false, "Unhandled event processed (not skipped)");
  assert(r37.action.includes("unhandled"), "Action indicates unhandled");

  // ── SCENARIO 38: getWebhookEventLog ──────────────────────────────────────
  section("SCENARIO 38: getWebhookEventLog — returns log");
  const log38 = await getWebhookEventLog({ tenantId: T_C });
  assert(Array.isArray(log38), "Returns array");
  assert(log38.length >= 3, `At least 3 events for T_C (found ${log38.length})`);
  assert(log38.every((e) => typeof e.stripe_event_id === "string"), "All entries have stripe_event_id");

  // ── SCENARIO 39: getWebhookStats ─────────────────────────────────────────
  section("SCENARIO 39: getWebhookStats — returns stats");
  const stats39 = await getWebhookStats();
  assert(typeof stats39.totalProcessed === "number", "totalProcessed is number");
  assert(typeof stats39.totalFailed === "number", "totalFailed is number");
  assert(typeof stats39.totalSkipped === "number", "totalSkipped is number");
  assert(Array.isArray(stats39.byEventType), "byEventType is array");
  assert(stats39.totalProcessed >= 4, "At least 4 events processed");

  // ── SCENARIO 40: syncPlanFromSubscription ────────────────────────────────
  section("SCENARIO 40: syncPlanFromSubscription — syncs to tenant_plans");
  const r40 = await syncPlanFromSubscription({ tenantId: T_B, planKey: "starter", status: "active" });
  assert(typeof r40.synced === "boolean", "synced is boolean");

  // ── SCENARIO 41: getSubscriptionChurnMetrics ─────────────────────────────
  section("SCENARIO 41: getSubscriptionChurnMetrics — observability");
  const churn41 = await getSubscriptionChurnMetrics();
  assert(typeof churn41.totalActive === "number", "totalActive is number");
  assert(typeof churn41.totalCanceled === "number", "totalCanceled is number");
  assert(typeof churn41.totalPastDue === "number", "totalPastDue is number");
  assert(typeof churn41.churnRate === "number", "churnRate is number");
  assert(churn41.churnRate >= 0 && churn41.churnRate <= 100, "churnRate in 0-100 range");

  // ── SCENARIO 42: getRevenueMetrics ────────────────────────────────────────
  section("SCENARIO 42: getRevenueMetrics — MRR observability");
  const rev42 = await getRevenueMetrics();
  assert(typeof rev42.totalMrr === "number", "totalMrr is number");
  assert(Array.isArray(rev42.planBreakdown), "planBreakdown is array");
  assert(rev42.planBreakdown.every((p) => typeof p.planKey === "string"), "planKey present");
  assert(rev42.planBreakdown.every((p) => typeof p.mrr === "number"), "mrr is number");

  // ── SCENARIO 43: getPaymentFailureMetrics ────────────────────────────────
  section("SCENARIO 43: getPaymentFailureMetrics — failure observability");
  const fail43 = await getPaymentFailureMetrics();
  assert(typeof fail43.totalInvoices === "number", "totalInvoices is number");
  assert(typeof fail43.totalPaid === "number", "totalPaid is number");
  assert(typeof fail43.totalFailed === "number", "totalFailed is number");
  assert(typeof fail43.failureRate === "number", "failureRate is number");
  assert(Array.isArray(fail43.recentFailures), "recentFailures is array");
  assert(fail43.failureRate >= 0, "failureRate is non-negative");

  // ── SCENARIO 44: getRevenueFromInvoices ──────────────────────────────────
  section("SCENARIO 44: getRevenueFromInvoices — revenue summary");
  const r44 = await getRevenueFromInvoices({ currency: "usd" });
  assert(typeof r44.totalRevenue === "number", "totalRevenue is number");
  assert(r44.currency === "usd", "currency matches");
  assert(typeof r44.invoiceCount === "number", "invoiceCount is number");
  assert(r44.totalRevenue >= 9900, "Revenue reflects at least one paid invoice (9900 cents)");

  // ── SCENARIO 45: listStripeCustomers ─────────────────────────────────────
  section("SCENARIO 45: listStripeCustomers — list all");
  const custs45 = await listStripeCustomers({ limit: 100 });
  assert(Array.isArray(custs45), "Returns array");
  assert(custs45.length >= 3, `At least 3 customers (T_A, T_B, T_C) found (got ${custs45.length})`);

  // ── SCENARIO 46: deleteStripeCustomer ────────────────────────────────────
  section("SCENARIO 46: deleteStripeCustomer — removes mapping");
  await upsertStripeCustomer({ tenantId: "stripe-test-temp-delete" });
  await deleteStripeCustomer("stripe-test-temp-delete");
  const deleted46 = await getStripeCustomer("stripe-test-temp-delete");
  assert(deleted46 === null, "Customer deleted");

  // ── SCENARIO 47: createStripeSubscription — missing tenantId rejected ─────
  section("SCENARIO 47: createStripeSubscription — missing tenantId rejected");
  let err47 = false;
  try { await createStripeSubscription({ tenantId: "", planKey: "starter" }); } catch { err47 = true; }
  assert(err47, "Empty tenantId rejected");

  // ── SCENARIO 48: upsertStripeCustomer — missing tenantId rejected ─────────
  section("SCENARIO 48: upsertStripeCustomer — missing tenantId rejected");
  let err48 = false;
  try { await upsertStripeCustomer({ tenantId: "" }); } catch { err48 = true; }
  assert(err48, "Empty tenantId rejected");

  // ── SCENARIO 49: STRIPE_EVENT_TYPES — all keys present ───────────────────
  section("SCENARIO 49: STRIPE_EVENT_TYPES — all required events defined");
  assert(STRIPE_EVENT_TYPES.CUSTOMER_CREATED === "customer.created", "customer.created defined");
  assert(STRIPE_EVENT_TYPES.INVOICE_PAYMENT_SUCCEEDED === "invoice.payment_succeeded", "invoice.payment_succeeded defined");
  assert(STRIPE_EVENT_TYPES.INVOICE_PAYMENT_FAILED === "invoice.payment_failed", "invoice.payment_failed defined");
  assert(STRIPE_EVENT_TYPES.SUBSCRIPTION_UPDATED === "customer.subscription.updated", "subscription.updated defined");
  assert(STRIPE_EVENT_TYPES.SUBSCRIPTION_DELETED === "customer.subscription.deleted", "subscription.deleted defined");

  // ── SCENARIO 50: STRIPE_PLAN_PRICE_MAP — 4 plans ─────────────────────────
  section("SCENARIO 50: STRIPE_PLAN_PRICE_MAP — 4 built-in plans");
  assert(Object.keys(STRIPE_PLAN_PRICE_MAP).length >= 4, "At least 4 plans in price map");
  assert("free" in STRIPE_PLAN_PRICE_MAP, "free plan in map");
  assert("enterprise" in STRIPE_PLAN_PRICE_MAP, "enterprise plan in map");
  assert(STRIPE_PLAN_PRICE_MAP.enterprise.yearly === 499000, "Enterprise yearly = $4990");

  // ── SCENARIO 51: Admin route GET /api/admin/stripe/customers ─────────────
  section("SCENARIO 51: Admin route GET /api/admin/stripe/customers");
  const res51 = await fetch("http://localhost:5000/api/admin/stripe/customers");
  assert(res51.status !== 404, "GET /api/admin/stripe/customers is not 404");
  assert([200, 401, 403].includes(res51.status), `Valid status ${res51.status}`);

  // ── SCENARIO 52: Admin route POST /api/admin/stripe/customers ────────────
  section("SCENARIO 52: Admin route POST /api/admin/stripe/customers");
  const res52 = await fetch("http://localhost:5000/api/admin/stripe/customers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId: "route-test-tenant" }),
  });
  assert([200, 201, 400, 401].includes(res52.status), `POST status ${res52.status} acceptable`);

  // ── SCENARIO 53: Admin route GET /api/admin/stripe/subscriptions ──────────
  section("SCENARIO 53: Admin route GET /api/admin/stripe/subscriptions");
  const res53 = await fetch(`http://localhost:5000/api/admin/stripe/subscriptions?tenantId=${T_A}`);
  assert(res53.status !== 404, "GET /api/admin/stripe/subscriptions is not 404");

  // ── SCENARIO 54: Admin route POST /api/admin/stripe/subscriptions ─────────
  section("SCENARIO 54: Admin route POST /api/admin/stripe/subscriptions");
  const res54 = await fetch("http://localhost:5000/api/admin/stripe/subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId: T_A, planKey: "starter" }),
  });
  assert([200, 201, 400, 401].includes(res54.status), `POST status ${res54.status} acceptable`);

  // ── SCENARIO 55: Admin route GET /api/admin/stripe/invoices ──────────────
  section("SCENARIO 55: Admin route GET /api/admin/stripe/invoices");
  const res55 = await fetch(`http://localhost:5000/api/admin/stripe/invoices?tenantId=${T_A}`);
  assert(res55.status !== 404, "GET /api/admin/stripe/invoices is not 404");

  // ── SCENARIO 56: Admin route GET /api/admin/stripe/metrics/churn ─────────
  section("SCENARIO 56: Admin route GET /api/admin/stripe/metrics/churn");
  const res56 = await fetch("http://localhost:5000/api/admin/stripe/metrics/churn");
  assert(res56.status !== 404, "GET /api/admin/stripe/metrics/churn is not 404");

  // ── SCENARIO 57: Admin route GET /api/admin/stripe/metrics/revenue ────────
  section("SCENARIO 57: Admin route GET /api/admin/stripe/metrics/revenue");
  const res57 = await fetch("http://localhost:5000/api/admin/stripe/metrics/revenue");
  assert(res57.status !== 404, "GET /api/admin/stripe/metrics/revenue is not 404");

  // ── SCENARIO 58: Cross-phase — Phase 20 billing tables still exist ────────
  section("SCENARIO 58: Cross-phase — Phase 20 plans table intact");
  const plans58 = await client.query(`
    SELECT COUNT(*) AS cnt FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'plans'
  `);
  assert(Number(plans58.rows[0].cnt) >= 1, "Phase 20 plans table exists");
  const builtins58 = await client.query(`
    SELECT COUNT(*) AS cnt FROM plans WHERE plan_key IN ('free','starter','professional','enterprise')
  `);
  assert(Number(builtins58.rows[0].cnt) >= 4, `Phase 20: 4 built-in plans seeded (found ${builtins58.rows[0].cnt})`);

  // ── SCENARIO 59: Cross-phase — Phase 16 governance tables exist ───────────
  section("SCENARIO 59: Cross-phase — Phase 16 ai governance tables intact");
  const gov59 = await client.query(`
    SELECT COUNT(*) AS cnt FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN ('tenant_ai_budgets','ai_usage_alerts')
  `);
  assert(Number(gov59.rows[0].cnt) >= 2, `Phase 16 governance tables intact (found ${gov59.rows[0].cnt})`);

  // ── SCENARIO 60: Tenant isolation — stripe data is per-tenant ─────────────
  section("SCENARIO 60: Tenant isolation — Stripe data per-tenant");
  const cA = await getStripeCustomer(T_A);
  const cB = await getStripeCustomer(T_B);
  const cC = await getStripeCustomer(T_C);
  assert(cA !== null && cB !== null && cC !== null, "All 3 test tenants have customers");
  assert(cA!.stripe_customer_id !== cB!.stripe_customer_id, "T_A and T_B have different Stripe customer IDs");
  assert(cB!.stripe_customer_id !== cC!.stripe_customer_id, "T_B and T_C have different Stripe customer IDs");
  const subA = await getStripeSubscription(T_A);
  const subB = await getStripeSubscription(T_B);
  assert(subA !== null && subB !== null, "Both tenants have subscriptions");
  assert(subA!.stripe_subscription_id !== subB!.stripe_subscription_id, "Different subscription IDs per tenant");

  // ── Cleanup ───────────────────────────────────────────────────────────────
  await client.query(`DELETE FROM stripe_webhook_events WHERE tenant_id IN ('${T_A}','${T_B}','${T_C}','route-test-tenant')`);
  await client.query(`DELETE FROM stripe_invoices WHERE tenant_id IN ('${T_A}','${T_B}','${T_C}','route-test-tenant')`);
  await client.query(`DELETE FROM stripe_subscriptions WHERE tenant_id IN ('${T_A}','${T_B}','${T_C}','route-test-tenant')`);
  await client.query(`DELETE FROM stripe_customers WHERE tenant_id IN ('${T_A}','${T_B}','${T_C}','route-test-tenant')`);

  await client.end();
  console.log(`\n${"─".repeat(60)}`);
  console.log(`Phase 22 validation: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("✗ FAILED assertions:");
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  } else {
    console.log("✔ All assertions passed");
  }
}

main().catch((err) => {
  console.error("Validation crashed:", err.message);
  process.exit(1);
});
