-- Per-widget dashboard configuration (timeframe, account selection, chart type,
-- etc.), keyed by widget id. Stored as JSONB so each widget type can persist its
-- own settings shape. Cross-device by virtue of living on user_preferences.
-- Empty object = every widget uses its built-in defaults.
ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS dashboard_widget_config JSONB NOT NULL DEFAULT '{}';
