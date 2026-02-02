-- Migration: Add custom_reports table
-- Description: Creates the custom_reports table for user-defined reports
--
-- view_type: TABLE, LINE_CHART, BAR_CHART, PIE_CHART
-- timeframe_type: LAST_7_DAYS, LAST_30_DAYS, LAST_MONTH, LAST_3_MONTHS, LAST_6_MONTHS, LAST_12_MONTHS, LAST_YEAR, YEAR_TO_DATE, CUSTOM
-- group_by: NONE, CATEGORY, PAYEE, MONTH, WEEK, DAY
-- filters: { accountIds?: string[], categoryIds?: string[], payeeIds?: string[], searchText?: string }
-- config: {
--   metric: NONE | TOTAL_AMOUNT | COUNT | AVERAGE,
--   includeTransfers: boolean,
--   direction: INCOME_ONLY | EXPENSES_ONLY | BOTH,
--   customStartDate?: string,
--   customEndDate?: string,
--   tableColumns?: (LABEL | VALUE | COUNT | PERCENTAGE | DATE | PAYEE | DESCRIPTION | MEMO | CATEGORY | ACCOUNT)[],
--   sortBy?: LABEL | VALUE | COUNT | PERCENTAGE | DATE | PAYEE | DESCRIPTION | MEMO | CATEGORY | ACCOUNT,
--   sortDirection?: ASC | DESC
-- }

-- Create custom_reports table
CREATE TABLE IF NOT EXISTS custom_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  icon VARCHAR(50),
  background_color VARCHAR(7),
  view_type VARCHAR(20) NOT NULL DEFAULT 'BAR_CHART',
  timeframe_type VARCHAR(30) NOT NULL DEFAULT 'LAST_3_MONTHS',
  group_by VARCHAR(20) NOT NULL DEFAULT 'CATEGORY',
  filters JSONB NOT NULL DEFAULT '{}',
  config JSONB NOT NULL DEFAULT '{"metric": "TOTAL_AMOUNT", "includeTransfers": false, "direction": "EXPENSES_ONLY"}',
  is_favourite BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_custom_reports_user_id ON custom_reports(user_id);
CREATE INDEX IF NOT EXISTS idx_custom_reports_user_favourite ON custom_reports(user_id, is_favourite);
CREATE INDEX IF NOT EXISTS idx_custom_reports_user_sort ON custom_reports(user_id, sort_order);

-- Add comment to table
COMMENT ON TABLE custom_reports IS 'Stores user-defined custom report configurations';
COMMENT ON COLUMN custom_reports.view_type IS 'TABLE, LINE_CHART, BAR_CHART, PIE_CHART';
COMMENT ON COLUMN custom_reports.timeframe_type IS 'LAST_7_DAYS, LAST_30_DAYS, LAST_MONTH, LAST_3_MONTHS, LAST_6_MONTHS, LAST_12_MONTHS, LAST_YEAR, YEAR_TO_DATE, CUSTOM';
COMMENT ON COLUMN custom_reports.group_by IS 'NONE, CATEGORY, PAYEE, MONTH, WEEK, DAY';
COMMENT ON COLUMN custom_reports.filters IS 'JSON: { accountIds?: string[], categoryIds?: string[], payeeIds?: string[], searchText?: string }';
COMMENT ON COLUMN custom_reports.config IS 'JSON: { metric, includeTransfers, direction, customStartDate?, customEndDate?, tableColumns?, sortBy?, sortDirection? }';
