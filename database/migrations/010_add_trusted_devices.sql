-- Migration: Add trusted_devices table for 2FA device trust
-- Stores hashed tokens for devices that are trusted to skip 2FA verification

CREATE TABLE trusted_devices (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL,
    device_name VARCHAR(255) NOT NULL,
    ip_address INET,
    last_used_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_trusted_devices_user ON trusted_devices(user_id);
CREATE INDEX idx_trusted_devices_token ON trusted_devices(token_hash);

CREATE TRIGGER update_trusted_devices_updated_at
    BEFORE UPDATE ON trusted_devices
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
