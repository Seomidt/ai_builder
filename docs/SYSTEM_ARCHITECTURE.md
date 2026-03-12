# AI Platform Architecture

## Core Runtime Pipeline

request
→ centralized runtime
→ idempotency guard
→ provider call
→ ai_usage
→ ai_billing_usage
→ wallet debit
→ billing period snapshot
→ billing audit

## Core Data Ledgers

ai_usage
ai_billing_usage
tenant_credit_ledger
billing_period_tenant_snapshots

## Security Layer

Supabase RLS
tenant isolation
internal vs public tables

## Financial Integrity Layer

billing audits
wallet reconciliation
period locking
