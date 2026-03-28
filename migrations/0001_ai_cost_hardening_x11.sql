-- PHASE X+1.1: AI Cost Control Hardening
-- Apply this migration to Supabase before deploying the new code.
-- Safe to run multiple times (IF NOT EXISTS / DEFAULT values).

-- Part 2: Actual cost column on ai_usage
ALTER TABLE ai_usage
  ADD COLUMN IF NOT EXISTS actual_cost_usd numeric(12,8);

-- Part 3: Budget reservation column on tenant_ai_usage_periods
-- Used by the atomic reserveBudget() function to prevent concurrent
-- requests from jointly exceeding the monthly budget.
ALTER TABLE tenant_ai_usage_periods
  ADD COLUMN IF NOT EXISTS reserved_cost_usd numeric(14,8) NOT NULL DEFAULT 0;
