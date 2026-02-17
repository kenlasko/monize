-- Migration: Add AI provider configuration and usage tracking tables
-- Part 1 of AI Integration Plan

-- AI Provider Configs (per-user AI provider configuration with encrypted API keys)
CREATE TABLE ai_provider_configs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider VARCHAR(50) NOT NULL,        -- 'anthropic', 'openai', 'ollama', 'openai-compatible'
    display_name VARCHAR(100),            -- User-friendly label
    is_active BOOLEAN DEFAULT true,
    priority INTEGER DEFAULT 0,           -- For fallback ordering (lower = higher priority)
    model VARCHAR(100),                   -- e.g., 'claude-sonnet-4-20250514', 'gpt-4o', 'llama3'
    api_key_enc TEXT,                     -- Encrypted API key (null for Ollama)
    base_url VARCHAR(500),               -- Custom endpoint URL (required for Ollama/compatible)
    config JSONB DEFAULT '{}',           -- Provider-specific settings (temperature, maxTokens, etc.)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, provider, priority)
);

CREATE INDEX idx_ai_provider_configs_user ON ai_provider_configs(user_id);
CREATE INDEX idx_ai_provider_configs_user_active ON ai_provider_configs(user_id, is_active);

-- AI Usage Logs (token usage tracking per AI request)
CREATE TABLE ai_usage_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider VARCHAR(50) NOT NULL,
    model VARCHAR(100) NOT NULL,
    feature VARCHAR(50) NOT NULL,         -- 'categorize', 'insight', 'query', 'forecast', 'test'
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    error TEXT,                            -- Error message if request failed
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_ai_usage_logs_user ON ai_usage_logs(user_id);
CREATE INDEX idx_ai_usage_logs_user_created ON ai_usage_logs(user_id, created_at DESC);
CREATE INDEX idx_ai_usage_logs_user_feature ON ai_usage_logs(user_id, feature);

-- Trigger for updated_at on ai_provider_configs
CREATE TRIGGER update_ai_provider_configs_updated_at
    BEFORE UPDATE ON ai_provider_configs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
