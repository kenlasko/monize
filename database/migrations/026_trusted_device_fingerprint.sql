-- Add user-agent fingerprint to trusted devices for context binding.
-- When validating a device token, the current user-agent hash must match
-- the one recorded at creation time to prevent stolen token reuse.
ALTER TABLE trusted_devices
  ADD COLUMN IF NOT EXISTS user_agent_hash VARCHAR(64);
