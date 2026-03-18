# AI Platform Roadmap

## Phase 3 — AI Runtime Infrastructure (Completed)

Centralized AI execution layer.

Features:

- centralized runtime
- request routing
- model overrides
- idempotent request handling
- request state lifecycle
- response caching
- retry safety
- anomaly detection
- step budgets
- token accounting

Execution pipeline:

request
→ route resolution
→ safety checks
→ idempotency guard
→ provider call
→ ai_usage

---

# Phase 4 — Monetization Platform

## Phase 4A — Billing Engine

Tables:

ai_usage
ai_customer_pricing_configs
ai_billing_usage

Features:

deterministic pricing
provider cost tracking
customer price calculation
margin tracking
immutable billing records

---

## Phase 4B — Wallet Ledger

Tables:

tenant_credit_accounts
tenant_credit_ledger

Features:

append-only ledger
credit grants
wallet debit
expiration-aware balances

---

## Phase 4C — Billing Replay + Safety

wallet replay worker
wallet_status lifecycle
failure repair flow
wallet hard limit enforcement

---

## Phase 4D — Billing Period Locking

Tables:

billing_periods
billing_period_tenant_snapshots

Features:

billing period lifecycle
immutable tenant snapshots
period close locking

---

## Phase 4D.1 — Period Hardening

snapshot immutability trigger
non-overlapping periods
concurrency-safe close flow

---

## Phase 4E — Billing Audit System

Tables:

billing_audit_runs
billing_audit_findings

Audits:

usage ↔ billing
billing ↔ wallet
snapshot ↔ ledger

---

## Phase 4E.1 — Supabase Security Hardening

RLS enabled on all public tables
client vs internal table separation
function search_path hardening

---

## Phase 4E.2 — Runtime Concurrency Hardening (Completed)

Fix:

retry ownership race
atomic step budget increment

Goal:

one request = one provider call
no duplicate billing

---

## Phase 4F — Billing Event Log

Table:

billing_events

Events:

usage_recorded
billing_row_created
wallet_debit_attempted
wallet_debit_success
wallet_debit_failed
wallet_replay_attempt
snapshot_generated
audit_detected

Purpose:

full financial timeline
replay safety
debugging

---

## Phase 4G — Provider Usage Ledger

Table:

provider_usage

Purpose:

provider invoice reconciliation
token mismatch detection
cost drift detection

---

## Phase 4H — Invoice Engine

Tables:

invoices
invoice_line_items
invoice_status

Purpose:

invoice generation
billing lifecycle

---

# Phase 6 — Billing Ecosystem

## Phase 6A — Stripe Integration

subscription plans
metered billing
credit topups

Stripe remains downstream.

---

## Phase 6B — Admin Observability

Dashboards:

AI usage
provider cost
customer revenue
margin
wallet balances
failed debits
anomaly alerts

---

# Phase 7 — Knowledge Infrastructure

## Phase 5A — Knowledge Base Registry

knowledge_bases
knowledge_base_documents
knowledge_base_chunks
knowledge_base_embeddings

---

## Phase 5B — Document Ingestion

upload
→ parse
→ chunk
→ embed
→ store vectors

---

## Phase 5C — Retrieval Layer

query
→ embed
→ vector search
→ rerank
→ LLM

---

# Phase 8 — AI Applications

document assistants
knowledge copilots
AI agents
enterprise AI tools
