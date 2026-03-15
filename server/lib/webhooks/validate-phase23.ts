/**
 * Phase 23 Validation — Webhook & Integration Platform
 * 60 scenarios, 140+ assertions
 *
 * Run: npx tsx server/lib/webhooks/validate-phase23.ts
 */

import pg from "pg";

const DB_URL = process.env.SUPABASE_DB_POOL_URL!;

// ── Test tenant IDs ───────────────────────────────────────────────────────────
const T_A = "wh-test-tenant-A";
const T_B = "wh-test-tenant-B";
const T_C = "wh-test-tenant-C";

// ── Test harness ──────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✔ ${message}`);
    passed++;
  } else {
    console.error(`  ✘ FAIL: ${message}`);
    failed++;
  }
}

function section(name: string) {
  console.log(`\n── ${name} ──`);
}

async function main() {
  console.log("Phase 23 Validation — Webhook & Integration Platform\n");

  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();

  // Pre-cleanup: remove any leftover data from previous runs
  await client.query(`DELETE FROM webhook_deliveries WHERE tenant_id IN ('${T_A}','${T_B}','${T_C}')`);
  await client.query(`DELETE FROM webhook_subscriptions WHERE tenant_id IN ('${T_A}','${T_B}','${T_C}')`);
  await client.query(`DELETE FROM webhook_endpoints WHERE tenant_id IN ('${T_A}','${T_B}','${T_C}')`);

  const {
    registerWebhookEndpoint, getWebhookEndpoint, listWebhookEndpoints,
    updateWebhookEndpoint, rotateWebhookSecret, deactivateWebhookEndpoint,
    deleteWebhookEndpoint, subscribeEndpoint, unsubscribeEndpoint,
    listEndpointSubscriptions, getSubscribedEndpoints, listTenantSubscriptions,
    PLATFORM_EVENT_TYPES, isValidEventType,
  } = await import("./webhook-registry");

  const {
    createDelivery, getDelivery, listDeliveries,
    markDelivered, markFailed, markRetrying, getDeliveryStats,
    getEndpointReliabilityStats,
  } = await import("./webhook-delivery");

  const {
    signPayload, verifySignature, buildWebhookHeaders,
    generateWebhookSecret, maskSecret, extractDigest,
    SIGNATURE_HEADER, SIGNATURE_VERSION, TIMESTAMP_HEADER,
    DELIVERY_HEADER, EVENT_TYPE_HEADER,
  } = await import("./webhook-signature");

  const {
    computeRetryDelay, computeNextRetryAt, shouldRetry,
    buildRetryDecision, getRetrySchedule, summarizeRetries,
    DEFAULT_RETRY_POLICY, AGGRESSIVE_RETRY_POLICY, GENTLE_RETRY_POLICY,
  } = await import("./webhook-retries");

  const {
    buildEventPayload, dispatchEvent, getDispatcherStats,
    emitTenantCreated, emitSubscriptionUpdated, emitInvoicePaid,
    emitAgentRunCompleted, emitEvaluationFinished, emitFeatureFlagUpdated,
  } = await import("./webhook-dispatcher");

  // ── SCENARIO 1: DB schema — 3 tables present ─────────────────────────────
  section("SCENARIO 1: DB schema — 3 tables present");
  const tables1 = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('webhook_endpoints','webhook_subscriptions','webhook_deliveries')
    ORDER BY table_name
  `);
  assert(tables1.rows.length === 3, "All 3 Phase 23 tables exist");
  assert(tables1.rows.some(r => r.table_name === "webhook_endpoints"), "webhook_endpoints exists");
  assert(tables1.rows.some(r => r.table_name === "webhook_subscriptions"), "webhook_subscriptions exists");
  assert(tables1.rows.some(r => r.table_name === "webhook_deliveries"), "webhook_deliveries exists");

  // ── SCENARIO 2: DB schema — indexes present ──────────────────────────────
  section("SCENARIO 2: DB schema — indexes present");
  const idx2 = await client.query(`
    SELECT COUNT(*) AS cnt FROM pg_indexes
    WHERE schemaname = 'public' AND indexname LIKE '%23%'
  `);
  assert(Number(idx2.rows[0].cnt) >= 8, `At least 8 indexes (found ${idx2.rows[0].cnt})`);

  // ── SCENARIO 3: DB schema — RLS enabled ─────────────────────────────────
  section("SCENARIO 3: DB schema — RLS enabled");
  const rls3 = await client.query(`
    SELECT COUNT(*) AS cnt FROM pg_class
    WHERE relname IN ('webhook_endpoints','webhook_subscriptions','webhook_deliveries')
      AND relrowsecurity = true
  `);
  assert(Number(rls3.rows[0].cnt) === 3, "RLS enabled on all 3 tables");

  // ── SCENARIO 4: PLATFORM_EVENT_TYPES — all required events present ───────
  section("SCENARIO 4: PLATFORM_EVENT_TYPES — all required events present");
  assert(Array.isArray(PLATFORM_EVENT_TYPES), "PLATFORM_EVENT_TYPES is array");
  assert(PLATFORM_EVENT_TYPES.length >= 6, `At least 6 event types (found ${PLATFORM_EVENT_TYPES.length})`);
  assert(PLATFORM_EVENT_TYPES.includes("tenant.created"), "tenant.created event");
  assert(PLATFORM_EVENT_TYPES.includes("subscription.updated"), "subscription.updated event");
  assert(PLATFORM_EVENT_TYPES.includes("invoice.paid"), "invoice.paid event");
  assert(PLATFORM_EVENT_TYPES.includes("agent.run.completed"), "agent.run.completed event");
  assert(PLATFORM_EVENT_TYPES.includes("evaluation.finished"), "evaluation.finished event");
  assert(PLATFORM_EVENT_TYPES.includes("feature.flag.updated"), "feature.flag.updated event");

  // ── SCENARIO 5: isValidEventType ─────────────────────────────────────────
  section("SCENARIO 5: isValidEventType — validates event types");
  assert(isValidEventType("tenant.created"), "tenant.created is valid");
  assert(isValidEventType("invoice.paid"), "invoice.paid is valid");
  assert(!isValidEventType("unknown.event"), "unknown.event is invalid");
  assert(!isValidEventType(""), "empty string is invalid");

  // ── SCENARIO 6: generateWebhookSecret — format ───────────────────────────
  section("SCENARIO 6: generateWebhookSecret — generates secure secret");
  const secret6 = generateWebhookSecret();
  assert(typeof secret6 === "string", "Secret is string");
  assert(secret6.length === 64, `Secret is 64 chars (found ${secret6.length})`);
  assert(/^[a-f0-9]+$/.test(secret6), "Secret is hex");
  const secret6b = generateWebhookSecret();
  assert(secret6 !== secret6b, "Each secret is unique");

  // ── SCENARIO 7: maskSecret ───────────────────────────────────────────────
  section("SCENARIO 7: maskSecret — masks signing secret");
  const masked7 = maskSecret("abcdef1234567890");
  assert(masked7.startsWith("****"), "Masked secret starts with ****");
  assert(masked7.endsWith("7890"), "Masked secret shows last 4 chars");
  assert(maskSecret("short") === "****", "Short secret masked fully");

  // ── SCENARIO 8: signPayload — HMAC-SHA256 ────────────────────────────────
  section("SCENARIO 8: signPayload — HMAC-SHA256 signature");
  const secret8 = "test-secret-key-phase23";
  const payload8 = JSON.stringify({ event: "test", data: {} });
  const ts8 = String(Date.now());
  const sig8 = signPayload(secret8, payload8, ts8);
  assert(sig8.startsWith("sha256="), "Signature has sha256= prefix");
  assert(sig8.length > 10, "Signature has content");
  assert(extractDigest(sig8) !== null, "extractDigest returns hex digest");
  assert(/^[a-f0-9]+$/.test(extractDigest(sig8)!), "Digest is valid hex");

  // ── SCENARIO 9: verifySignature — correct secret ─────────────────────────
  section("SCENARIO 9: verifySignature — validates correct signature");
  const verified9 = verifySignature({ secret: secret8, signature: sig8, payload: payload8, timestamp: ts8 });
  assert(verified9, "Valid signature verifies correctly");

  // ── SCENARIO 10: verifySignature — wrong secret rejected ─────────────────
  section("SCENARIO 10: verifySignature — rejects wrong secret");
  const bad10 = verifySignature({ secret: "wrong-secret", signature: sig8, payload: payload8, timestamp: ts8 });
  assert(!bad10, "Wrong secret rejected");

  // ── SCENARIO 11: verifySignature — tampered payload rejected ─────────────
  section("SCENARIO 11: verifySignature — rejects tampered payload");
  const tampered11 = verifySignature({
    secret: secret8, signature: sig8,
    payload: JSON.stringify({ event: "tampered" }), timestamp: ts8,
  });
  assert(!tampered11, "Tampered payload rejected");

  // ── SCENARIO 12: buildWebhookHeaders — correct headers ───────────────────
  section("SCENARIO 12: buildWebhookHeaders — builds all required headers");
  const headers12 = buildWebhookHeaders({
    secret: secret8, payload: payload8, eventType: "tenant.created", deliveryId: "test-del-id",
  });
  assert(typeof headers12 === "object", "Headers is object");
  assert(SIGNATURE_HEADER in headers12, "X-Webhook-Signature present");
  assert(TIMESTAMP_HEADER in headers12, "X-Webhook-Timestamp present");
  assert(DELIVERY_HEADER in headers12, "X-Webhook-Delivery present");
  assert(EVENT_TYPE_HEADER in headers12, "X-Webhook-Event present");
  assert(headers12["Content-Type"] === "application/json", "Content-Type correct");
  assert(headers12[DELIVERY_HEADER] === "test-del-id", "Delivery ID matches");
  assert(headers12[EVENT_TYPE_HEADER] === "tenant.created", "Event type matches");

  // ── SCENARIO 13: SIGNATURE_VERSION constant ───────────────────────────────
  section("SCENARIO 13: SIGNATURE_VERSION — sha256");
  assert(SIGNATURE_VERSION === "sha256", "SIGNATURE_VERSION is sha256");

  // ── SCENARIO 14: DEFAULT_RETRY_POLICY — values ───────────────────────────
  section("SCENARIO 14: DEFAULT_RETRY_POLICY — correct values");
  assert(DEFAULT_RETRY_POLICY.maxAttempts === 3, "Default maxAttempts = 3");
  assert(DEFAULT_RETRY_POLICY.baseDelayMs === 5000, "Default baseDelayMs = 5000ms");
  assert(DEFAULT_RETRY_POLICY.backoffMultiplier === 2, "Default backoffMultiplier = 2");
  assert(DEFAULT_RETRY_POLICY.maxDelayMs <= 300_000, "Default maxDelayMs <= 5 minutes");

  // ── SCENARIO 15: AGGRESSIVE_RETRY_POLICY ─────────────────────────────────
  section("SCENARIO 15: AGGRESSIVE_RETRY_POLICY — more retries");
  assert(AGGRESSIVE_RETRY_POLICY.maxAttempts >= 5, "Aggressive maxAttempts >= 5");
  assert(AGGRESSIVE_RETRY_POLICY.maxAttempts > DEFAULT_RETRY_POLICY.maxAttempts, "Aggressive > default attempts");

  // ── SCENARIO 16: GENTLE_RETRY_POLICY ─────────────────────────────────────
  section("SCENARIO 16: GENTLE_RETRY_POLICY — fewer retries");
  assert(GENTLE_RETRY_POLICY.maxAttempts <= 2, "Gentle maxAttempts <= 2");
  assert(GENTLE_RETRY_POLICY.maxAttempts < DEFAULT_RETRY_POLICY.maxAttempts, "Gentle < default attempts");

  // ── SCENARIO 17: computeRetryDelay — exponential backoff ─────────────────
  section("SCENARIO 17: computeRetryDelay — exponential backoff");
  const delay1 = computeRetryDelay(1, { ...DEFAULT_RETRY_POLICY, jitterMs: 0 });
  const delay2 = computeRetryDelay(2, { ...DEFAULT_RETRY_POLICY, jitterMs: 0 });
  const delay3 = computeRetryDelay(3, { ...DEFAULT_RETRY_POLICY, jitterMs: 0 });
  assert(delay1 === 5000, `Attempt 1 delay = 5000ms (got ${delay1})`);
  assert(delay2 === 10000, `Attempt 2 delay = 10000ms (got ${delay2})`);
  assert(delay3 === 20000, `Attempt 3 delay = 20000ms (got ${delay3})`);
  assert(delay2 > delay1, "Delay increases with attempt number");
  assert(delay3 > delay2, "Delay increases with attempt number (2→3)");

  // ── SCENARIO 18: computeRetryDelay — maxDelay cap ────────────────────────
  section("SCENARIO 18: computeRetryDelay — capped at maxDelayMs");
  const capped18 = computeRetryDelay(20, { ...DEFAULT_RETRY_POLICY, jitterMs: 0 });
  assert(capped18 <= DEFAULT_RETRY_POLICY.maxDelayMs, `Capped at maxDelayMs (got ${capped18})`);

  // ── SCENARIO 19: computeNextRetryAt — future date ────────────────────────
  section("SCENARIO 19: computeNextRetryAt — returns future date");
  const now19 = Date.now();
  const next19 = computeNextRetryAt(1, DEFAULT_RETRY_POLICY);
  assert(next19 instanceof Date, "Returns a Date");
  assert(next19.getTime() > now19, "Next retry is in the future");

  // ── SCENARIO 20: shouldRetry — boundary conditions ───────────────────────
  section("SCENARIO 20: shouldRetry — boundary conditions");
  assert(shouldRetry(0, 3), "0 attempts: should retry (< max)");
  assert(shouldRetry(2, 3), "2 attempts: should retry (< max)");
  assert(!shouldRetry(3, 3), "3 attempts: no retry (= max)");
  assert(!shouldRetry(5, 3), "5 attempts: no retry (> max)");

  // ── SCENARIO 21: buildRetryDecision — success path ───────────────────────
  section("SCENARIO 21: buildRetryDecision — schedules retry");
  const dec21 = buildRetryDecision({ attempts: 1, maxAttempts: 3 });
  assert(dec21.shouldRetry, "Should retry on first failure");
  assert(dec21.nextRetryAt instanceof Date, "nextRetryAt is a Date");
  assert(typeof dec21.reason === "string", "reason is a string");

  // ── SCENARIO 22: buildRetryDecision — max attempts reached ───────────────
  section("SCENARIO 22: buildRetryDecision — no retry at max attempts");
  const dec22 = buildRetryDecision({ attempts: 3, maxAttempts: 3 });
  assert(!dec22.shouldRetry, "No retry when max attempts reached");

  // ── SCENARIO 23: buildRetryDecision — 4xx non-retryable ──────────────────
  section("SCENARIO 23: buildRetryDecision — 4xx errors not retried");
  const dec23a = buildRetryDecision({ attempts: 0, maxAttempts: 3, statusCode: 404 });
  assert(!dec23a.shouldRetry, "404 not retried");
  const dec23b = buildRetryDecision({ attempts: 0, maxAttempts: 3, statusCode: 400 });
  assert(!dec23b.shouldRetry, "400 not retried");
  const dec23c = buildRetryDecision({ attempts: 0, maxAttempts: 3, statusCode: 429 });
  assert(dec23c.shouldRetry, "429 (rate limit) is retried");
  const dec23d = buildRetryDecision({ attempts: 0, maxAttempts: 3, statusCode: 500 });
  assert(dec23d.shouldRetry, "500 is retried");

  // ── SCENARIO 24: getRetrySchedule — returns schedule ─────────────────────
  section("SCENARIO 24: getRetrySchedule — returns schedule for all attempts");
  const schedule24 = getRetrySchedule(DEFAULT_RETRY_POLICY);
  assert(Array.isArray(schedule24), "Schedule is array");
  assert(schedule24.length === DEFAULT_RETRY_POLICY.maxAttempts, "Schedule has maxAttempts entries");
  assert(typeof schedule24[0].delayMs === "number", "Each entry has delayMs");
  assert(typeof schedule24[0].delayHuman === "string", "Each entry has human-readable delay");

  // ── SCENARIO 25: summarizeRetries ────────────────────────────────────────
  section("SCENARIO 25: summarizeRetries — summarizes retry stats");
  const sum25 = summarizeRetries([
    { attempts: 1, status: "delivered" },
    { attempts: 3, status: "delivered" },
    { attempts: 3, status: "failed" },
  ]);
  assert(typeof sum25.avgAttempts === "number", "avgAttempts is number");
  assert(sum25.maxAttempts === 3, "maxAttempts = 3");
  assert(sum25.retriedCount === 2, "retriedCount = 2 (attempts > 1)");
  assert(sum25.successAfterRetry === 1, "successAfterRetry = 1");
  const empty25 = summarizeRetries([]);
  assert(empty25.avgAttempts === 0, "Empty deliveries: avgAttempts = 0");

  // ── SCENARIO 26: registerWebhookEndpoint — creates endpoint ──────────────
  section("SCENARIO 26: registerWebhookEndpoint — creates endpoint");
  const ep26 = await registerWebhookEndpoint({
    tenantId: T_A, url: "https://example.com/webhook", description: "Test endpoint",
  });
  assert(typeof ep26.id === "string", "id returned");
  assert(typeof ep26.secret === "string", "secret returned");
  assert(ep26.secret.length === 64, "secret is 64-char hex");
  assert(ep26.tenantId === T_A, "tenantId matches");

  // ── SCENARIO 27: registerWebhookEndpoint — URL validation ────────────────
  section("SCENARIO 27: registerWebhookEndpoint — rejects invalid URL");
  let urlErr27 = "";
  try { await registerWebhookEndpoint({ tenantId: T_A, url: "not-a-url" }); }
  catch (e) { urlErr27 = (e as Error).message; }
  assert(urlErr27.includes("Invalid URL"), "Invalid URL rejected");

  // ── SCENARIO 28: getWebhookEndpoint — retrieves endpoint ─────────────────
  section("SCENARIO 28: getWebhookEndpoint — retrieves by ID");
  const got28 = await getWebhookEndpoint(ep26.id);
  assert(got28 !== null, "Endpoint found");
  assert((got28!.tenant_id as string) === T_A, "tenantId matches");
  assert((got28!.url as string) === "https://example.com/webhook", "URL matches");
  assert((got28!.active as boolean) === true, "Active by default");

  // ── SCENARIO 29: listWebhookEndpoints — lists by tenant ──────────────────
  section("SCENARIO 29: listWebhookEndpoints — lists by tenant");
  const list29 = await listWebhookEndpoints(T_A);
  assert(Array.isArray(list29), "Returns array");
  assert(list29.length >= 1, "At least 1 endpoint for T_A");
  assert(list29.some(e => e.id === ep26.id), "Created endpoint is in list");

  // ── SCENARIO 30: updateWebhookEndpoint — updates fields ──────────────────
  section("SCENARIO 30: updateWebhookEndpoint — updates description and maxRetries");
  const upd30 = await updateWebhookEndpoint(ep26.id, { description: "Updated description", maxRetries: 5 });
  assert(upd30.updated === true, "Updated returned true");
  const got30 = await getWebhookEndpoint(ep26.id);
  assert((got30!.description as string) === "Updated description", "Description updated");
  assert((got30!.max_retries as number) === 5, "max_retries updated to 5");

  // ── SCENARIO 31: rotateWebhookSecret — returns new secret ────────────────
  section("SCENARIO 31: rotateWebhookSecret — rotates signing secret");
  const rot31 = await rotateWebhookSecret(ep26.id);
  assert(typeof rot31.newSecret === "string", "New secret returned");
  assert(rot31.newSecret.length === 64, "New secret is 64 chars");
  assert(rot31.newSecret !== ep26.secret, "New secret differs from original");

  // ── SCENARIO 32: deactivateWebhookEndpoint ───────────────────────────────
  section("SCENARIO 32: deactivateWebhookEndpoint — sets active=false");
  const ep32 = await registerWebhookEndpoint({ tenantId: T_A, url: "https://example.com/deactivate-test" });
  await deactivateWebhookEndpoint(ep32.id);
  const got32 = await getWebhookEndpoint(ep32.id);
  assert((got32!.active as boolean) === false, "Endpoint deactivated");

  // ── SCENARIO 33: listWebhookEndpoints — filter by active ─────────────────
  section("SCENARIO 33: listWebhookEndpoints — filter by active=true");
  const active33 = await listWebhookEndpoints(T_A, { active: true });
  assert(active33.every(e => e.active === true), "All returned endpoints are active");

  // ── SCENARIO 34: subscribeEndpoint — idempotent ───────────────────────────
  section("SCENARIO 34: subscribeEndpoint — creates subscription");
  const sub34 = await subscribeEndpoint({ endpointId: ep26.id, tenantId: T_A, eventType: "tenant.created" });
  assert(typeof sub34.id === "string", "Subscription id returned");
  assert(sub34.eventType === "tenant.created", "eventType matches");
  // Idempotent
  const sub34b = await subscribeEndpoint({ endpointId: ep26.id, tenantId: T_A, eventType: "tenant.created" });
  assert(sub34b.id === sub34.id, "Second subscribe returns same ID (idempotent)");

  // ── SCENARIO 35: subscribeEndpoint — rejects unknown event type ──────────
  section("SCENARIO 35: subscribeEndpoint — rejects invalid event type");
  let evtErr35 = "";
  try { await subscribeEndpoint({ endpointId: ep26.id, tenantId: T_A, eventType: "bad.event" }); }
  catch (e) { evtErr35 = (e as Error).message; }
  assert(evtErr35.includes("Unknown event type"), "Unknown event type rejected");

  // ── SCENARIO 36: subscribeEndpoint — multiple event types ─────────────────
  section("SCENARIO 36: subscribeEndpoint — multiple event types per endpoint");
  await subscribeEndpoint({ endpointId: ep26.id, tenantId: T_A, eventType: "invoice.paid" });
  await subscribeEndpoint({ endpointId: ep26.id, tenantId: T_A, eventType: "subscription.updated" });
  const subs36 = await listEndpointSubscriptions(ep26.id);
  assert(subs36.length >= 3, `At least 3 subscriptions (found ${subs36.length})`);

  // ── SCENARIO 37: getSubscribedEndpoints — returns matching endpoints ──────
  section("SCENARIO 37: getSubscribedEndpoints — by event type");
  const subEps37 = await getSubscribedEndpoints(T_A, "tenant.created");
  assert(Array.isArray(subEps37), "Returns array");
  assert(subEps37.some(e => e.id === ep26.id), "ep26 is subscribed to tenant.created");

  // ── SCENARIO 38: unsubscribeEndpoint ─────────────────────────────────────
  section("SCENARIO 38: unsubscribeEndpoint — removes subscription");
  await unsubscribeEndpoint(ep26.id, "subscription.updated");
  const subs38 = await listEndpointSubscriptions(ep26.id);
  assert(!subs38.some(s => s.event_type === "subscription.updated"), "subscription.updated removed");

  // ── SCENARIO 39: listTenantSubscriptions ─────────────────────────────────
  section("SCENARIO 39: listTenantSubscriptions — lists all for tenant");
  const tenantSubs39 = await listTenantSubscriptions(T_A);
  assert(Array.isArray(tenantSubs39), "Returns array");
  assert(tenantSubs39.length >= 1, "At least 1 subscription for T_A");

  // ── SCENARIO 40: subscribeEndpoint — wrong tenant rejected ───────────────
  section("SCENARIO 40: subscribeEndpoint — rejects wrong tenant");
  let tenantErr40 = "";
  try { await subscribeEndpoint({ endpointId: ep26.id, tenantId: T_B, eventType: "invoice.paid" }); }
  catch (e) { tenantErr40 = (e as Error).message; }
  assert(tenantErr40.includes("does not belong"), "Wrong tenant rejected");

  // ── SCENARIO 41: createDelivery — creates pending record ─────────────────
  section("SCENARIO 41: createDelivery — creates pending delivery");
  const del41 = await createDelivery({
    endpointId: ep26.id, tenantId: T_A, eventType: "invoice.paid",
    payload: { amount: 9900, currency: "usd" }, maxAttempts: 3,
  });
  assert(typeof del41.id === "string", "Delivery id returned");
  const got41 = await getDelivery(del41.id);
  assert(got41 !== null, "Delivery found");
  assert((got41!.status as string) === "pending", "Initial status is pending");
  assert((got41!.attempts as number) === 0, "Initial attempts = 0");

  // ── SCENARIO 42: markDelivered — marks as delivered ──────────────────────
  section("SCENARIO 42: markDelivered — marks delivery as delivered");
  await markDelivered(del41.id, { statusCode: 200, latencyMs: 150, attempts: 1 });
  const got42 = await getDelivery(del41.id);
  assert((got42!.status as string) === "delivered", "Status is delivered");
  assert((got42!.http_status_code as number) === 200, "HTTP status code stored");
  assert((got42!.delivery_latency_ms as number) === 150, "Latency stored");
  assert((got42!.delivered_at as string) !== null, "delivered_at set");

  // ── SCENARIO 43: markRetrying — marks as retrying with next retry ─────────
  section("SCENARIO 43: markRetrying — marks delivery as retrying");
  const del43 = await createDelivery({
    endpointId: ep26.id, tenantId: T_A, eventType: "agent.run.completed",
    payload: { runId: "run-123" }, maxAttempts: 3,
  });
  const nextRetry43 = new Date(Date.now() + 5000);
  await markRetrying(del43.id, { error: "Connection refused", statusCode: 503, attempts: 1, nextRetryAt: nextRetry43 });
  const got43 = await getDelivery(del43.id);
  assert((got43!.status as string) === "retrying", "Status is retrying");
  assert((got43!.last_error as string) === "Connection refused", "Error message stored");
  assert((got43!.next_retry_at as string) !== null, "next_retry_at set");

  // ── SCENARIO 44: markFailed — marks as permanently failed ────────────────
  section("SCENARIO 44: markFailed — marks delivery as failed");
  const del44 = await createDelivery({
    endpointId: ep26.id, tenantId: T_A, eventType: "evaluation.finished",
    payload: { evaluationId: "eval-999" }, maxAttempts: 3,
  });
  await markFailed(del44.id, { error: "Max retries exceeded", statusCode: 500, attempts: 3 });
  const got44 = await getDelivery(del44.id);
  assert((got44!.status as string) === "failed", "Status is failed");
  assert((got44!.attempts as number) === 3, "Attempts = 3");
  assert((got44!.last_error as string) === "Max retries exceeded", "Error message stored");

  // ── SCENARIO 45: listDeliveries — filter by status ───────────────────────
  section("SCENARIO 45: listDeliveries — filter by status");
  const delivered45 = await listDeliveries(T_A, { status: "delivered" });
  assert(Array.isArray(delivered45), "Returns array");
  assert(delivered45.every(d => d.status === "delivered"), "All returned are delivered");

  // ── SCENARIO 46: listDeliveries — filter by eventType ────────────────────
  section("SCENARIO 46: listDeliveries — filter by eventType");
  const byType46 = await listDeliveries(T_A, { eventType: "invoice.paid" });
  assert(Array.isArray(byType46), "Returns array");
  assert(byType46.every(d => d.event_type === "invoice.paid"), "All returned match event type");

  // ── SCENARIO 47: getDeliveryStats — aggregate stats ──────────────────────
  section("SCENARIO 47: getDeliveryStats — aggregate delivery statistics");
  const stats47 = await getDeliveryStats(T_A);
  assert(typeof stats47.totalDeliveries === "number", "totalDeliveries is number");
  assert(typeof stats47.totalDelivered === "number", "totalDelivered is number");
  assert(typeof stats47.totalFailed === "number", "totalFailed is number");
  assert(typeof stats47.avgLatencyMs === "number", "avgLatencyMs is number");
  assert(typeof stats47.failureRate === "number", "failureRate is number");
  assert(stats47.failureRate >= 0 && stats47.failureRate <= 100, "failureRate in [0,100]");

  // ── SCENARIO 48: getEndpointReliabilityStats ──────────────────────────────
  section("SCENARIO 48: getEndpointReliabilityStats — per-endpoint stats");
  const rel48 = await getEndpointReliabilityStats(ep26.id);
  assert(typeof rel48.totalDeliveries === "number", "totalDeliveries is number");
  assert(typeof rel48.successRate === "number", "successRate is number");
  assert(rel48.successRate >= 0 && rel48.successRate <= 100, "successRate in [0,100]");
  assert(rel48.totalDeliveries >= 1, "At least 1 delivery for ep26");

  // ── SCENARIO 49: buildEventPayload — structure ────────────────────────────
  section("SCENARIO 49: buildEventPayload — correct structure");
  const payload49 = buildEventPayload({
    eventType: "tenant.created", tenantId: T_A, data: { planKey: "starter" },
  });
  assert(typeof payload49 === "object", "Payload is object");
  assert(payload49.eventType === "tenant.created", "eventType correct");
  assert(payload49.tenantId === T_A, "tenantId correct");
  assert(typeof payload49.timestamp === "string", "timestamp is string");
  assert(typeof payload49.data === "object", "data is object");
  assert((payload49.data as Record<string, unknown>).planKey === "starter", "data.planKey correct");

  // ── SCENARIO 50: dispatchEvent — no endpoints subscribed ─────────────────
  section("SCENARIO 50: dispatchEvent — no endpoints returns empty deliveryIds");
  const dispatch50 = await dispatchEvent({ eventType: "quota.exceeded", tenantId: T_B, data: { quota: "ai_tokens" } });
  assert(dispatch50.deliveryIds.length === 0, "No deliveries when no endpoints subscribed");
  assert(dispatch50.endpointCount === 0, "endpointCount = 0");

  // ── SCENARIO 51: dispatchEvent — with subscribed endpoint ────────────────
  section("SCENARIO 51: dispatchEvent — delivers to subscribed endpoint");
  const ep51 = await registerWebhookEndpoint({ tenantId: T_B, url: "https://httpbin.org/post" });
  await subscribeEndpoint({ endpointId: ep51.id, tenantId: T_B, eventType: "invoice.paid" });
  const dispatch51 = await dispatchEvent({ eventType: "invoice.paid", tenantId: T_B, data: { invoiceId: "inv-001" } });
  assert(dispatch51.endpointCount === 1, "1 endpoint dispatched to");
  assert(dispatch51.deliveryIds.length === 1, "1 delivery created");

  // ── SCENARIO 52: emitTenantCreated ───────────────────────────────────────
  section("SCENARIO 52: emitTenantCreated — dispatches event");
  const emit52 = await emitTenantCreated(T_A, { name: "Test Corp" });
  assert(Array.isArray(emit52.deliveryIds), "Returns deliveryIds array");

  // ── SCENARIO 53: emitSubscriptionUpdated ─────────────────────────────────
  section("SCENARIO 53: emitSubscriptionUpdated — dispatches event");
  const emit53 = await emitSubscriptionUpdated(T_A, { planKey: "pro" });
  assert(Array.isArray(emit53.deliveryIds), "Returns deliveryIds array");

  // ── SCENARIO 54: emitInvoicePaid ─────────────────────────────────────────
  section("SCENARIO 54: emitInvoicePaid — dispatches event");
  const emit54 = await emitInvoicePaid(T_A, { invoiceId: "inv-A1", amount: 9900 });
  assert(Array.isArray(emit54.deliveryIds), "Returns deliveryIds array");

  // ── SCENARIO 55: emitAgentRunCompleted ────────────────────────────────────
  section("SCENARIO 55: emitAgentRunCompleted — dispatches event");
  const emit55 = await emitAgentRunCompleted(T_A, { runId: "run-001", durationMs: 1200 });
  assert(Array.isArray(emit55.deliveryIds), "Returns deliveryIds array");

  // ── SCENARIO 56: emitEvaluationFinished ──────────────────────────────────
  section("SCENARIO 56: emitEvaluationFinished — dispatches event");
  const emit56 = await emitEvaluationFinished(T_A, { evalId: "eval-001", score: 0.92 });
  assert(Array.isArray(emit56.deliveryIds), "Returns deliveryIds array");

  // ── SCENARIO 57: emitFeatureFlagUpdated ──────────────────────────────────
  section("SCENARIO 57: emitFeatureFlagUpdated — dispatches event");
  const emit57 = await emitFeatureFlagUpdated(T_A, { flagKey: "ai_chat_v2", enabled: true });
  assert(Array.isArray(emit57.deliveryIds), "Returns deliveryIds array");

  // ── SCENARIO 58: getDispatcherStats ──────────────────────────────────────
  section("SCENARIO 58: getDispatcherStats — returns dispatcher metrics");
  const stats58 = await getDispatcherStats();
  assert(typeof stats58.pendingRetries === "number", "pendingRetries is number");
  assert(typeof stats58.totalEndpoints === "number", "totalEndpoints is number");
  assert(typeof stats58.totalSubscriptions === "number", "totalSubscriptions is number");
  assert(stats58.totalEndpoints >= 2, `At least 2 active endpoints (found ${stats58.totalEndpoints})`);

  // ── SCENARIO 59: Admin routes registered ─────────────────────────────────
  section("SCENARIO 59: Admin routes — all webhook routes registered");
  const routes59 = [
    ["GET",    "/api/admin/webhooks/endpoints?tenantId=x"],
    ["GET",    "/api/admin/webhooks/subscriptions?tenantId=x"],
    ["GET",    "/api/admin/webhooks/deliveries?tenantId=x"],
    ["GET",    "/api/admin/webhooks/metrics/deliveries"],
    ["GET",    "/api/admin/webhooks/metrics/dispatcher"],
  ];
  for (const [method, path] of routes59) {
    const res = await fetch(`http://localhost:5000${path}`, { method });
    assert(res.status !== 404, `${method} ${path} is not 404 (got ${res.status})`);
  }

  // ── SCENARIO 60: Cross-phase — Phase 22 Stripe tables intact ─────────────
  section("SCENARIO 60: Cross-phase — Phase 22 Stripe tables intact");
  const cross60 = await client.query(`
    SELECT COUNT(*) AS cnt FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('stripe_customers','stripe_subscriptions','stripe_invoices','stripe_webhook_events')
  `);
  assert(Number(cross60.rows[0].cnt) === 4, `Phase 22: 4 Stripe tables intact (found ${cross60.rows[0].cnt})`);
  const plans60 = await client.query(`
    SELECT COUNT(*) AS cnt FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'plans'
  `);
  assert(Number(plans60.rows[0].cnt) >= 1, "Phase 20: plans table still exists");

  // ── Cleanup test data ─────────────────────────────────────────────────────
  await client.query(`DELETE FROM webhook_deliveries WHERE tenant_id IN ('${T_A}','${T_B}','${T_C}')`);
  await client.query(`DELETE FROM webhook_subscriptions WHERE tenant_id IN ('${T_A}','${T_B}','${T_C}')`);
  await client.query(`DELETE FROM webhook_endpoints WHERE tenant_id IN ('${T_A}','${T_B}','${T_C}')`);

  await client.end();

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n────────────────────────────────────────────────────────────");
  console.log(`Phase 23 validation: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("✔ All assertions passed");
    process.exit(0);
  } else {
    console.error(`✘ ${failed} assertion(s) FAILED`);
    process.exit(1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
