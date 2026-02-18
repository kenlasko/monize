-- Add AI Insights table for spending insights and anomaly detection
CREATE TABLE IF NOT EXISTS ai_insights (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL,           -- 'anomaly', 'trend', 'subscription', 'budget_pace', 'seasonal', 'new_recurring'
    title VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    severity VARCHAR(20) NOT NULL,       -- 'info', 'warning', 'alert'
    data JSONB DEFAULT '{}',             -- Supporting data (amounts, categories, dates)
    is_dismissed BOOLEAN DEFAULT false,
    generated_at TIMESTAMP NOT NULL,
    expires_at TIMESTAMP NOT NULL,       -- Auto-cleanup old insights
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE ai_insights OWNER TO monize;

CREATE INDEX idx_ai_insights_user ON ai_insights(user_id);
CREATE INDEX idx_ai_insights_user_dismissed ON ai_insights(user_id, is_dismissed);
CREATE INDEX idx_ai_insights_expires ON ai_insights(expires_at);
CREATE INDEX idx_ai_insights_user_type ON ai_insights(user_id, type);
