-- Migration: Add getting_started_dismissed to user_preferences
-- Date: 2026-02

ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS getting_started_dismissed BOOLEAN DEFAULT false;
