-- Migration: Add new account types to the account_type enum
-- Add values: HSA, FSA, DCFSA, 401K, 403B, TRADITIONAL_IRA, ROTH_IRA, 529_PLAN, HELOC, PROPERTY, VEHICLE, LIABILITY

-- PostgreSQL doesn't allow ALTER TYPE ... ADD VALUE to run inside a multi-statement transaction in some contexts,
-- but db-migrate executes each file. Let's add them.
ALTER TYPE account_type ADD VALUE IF NOT EXISTS 'HSA';
ALTER TYPE account_type ADD VALUE IF NOT EXISTS 'FSA';
ALTER TYPE account_type ADD VALUE IF NOT EXISTS 'DCFSA';
ALTER TYPE account_type ADD VALUE IF NOT EXISTS '401K';
ALTER TYPE account_type ADD VALUE IF NOT EXISTS '403B';
ALTER TYPE account_type ADD VALUE IF NOT EXISTS 'TRADITIONAL_IRA';
ALTER TYPE account_type ADD VALUE IF NOT EXISTS 'ROTH_IRA';
ALTER TYPE account_type ADD VALUE IF NOT EXISTS '529_PLAN';
ALTER TYPE account_type ADD VALUE IF NOT EXISTS 'HELOC';
ALTER TYPE account_type ADD VALUE IF NOT EXISTS 'PROPERTY';
ALTER TYPE account_type ADD VALUE IF NOT EXISTS 'VEHICLE';
ALTER TYPE account_type ADD VALUE IF NOT EXISTS 'LIABILITY';
