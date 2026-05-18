-- Phase 3 / 3A: per-delegation READ grants for whole app sections. These gate
-- tab visibility and the section read endpoints (Bills & Deposits,
-- Investments, Budgets, Reports, AI). Account-scoped data still also requires
-- the existing per-account grants. Idempotent: safe to run multiple times.

ALTER TABLE account_delegates
    ADD COLUMN IF NOT EXISTS bills_can_read       BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS investments_can_read BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS budgets_can_read     BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS reports_can_read     BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS ai_can_read          BOOLEAN NOT NULL DEFAULT false;
