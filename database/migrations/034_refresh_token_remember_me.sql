-- Add remember_me column to refresh_tokens to preserve session preference during rotation
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS remember_me BOOLEAN NOT NULL DEFAULT false;
