-- Migration: Add two_factor_secret column to users table for TOTP 2FA

ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_secret VARCHAR(255);
