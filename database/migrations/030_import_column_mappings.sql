-- Import column mappings for CSV imports
-- Allows users to save and reuse CSV column mapping configurations

CREATE TABLE IF NOT EXISTS import_column_mappings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    column_mappings JSONB NOT NULL,
    transfer_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_import_column_mappings_user ON import_column_mappings(user_id);

-- Trigger for updated_at
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_import_column_mappings_updated_at') THEN
        CREATE TRIGGER update_import_column_mappings_updated_at
            BEFORE UPDATE ON import_column_mappings
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;
