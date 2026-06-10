-- Per-user colour theme preference, separate from the light/dark/system mode
-- setting (`theme`). The value is one of the palette names defined in
-- frontend/src/lib/color-themes.ts ('default', 'latte', 'msmoney', 'nord',
-- 'forest', 'solarized', 'highcontrast') and is validated against the same
-- list in backend/src/users/dto/update-preferences.dto.ts. Every palette has
-- both light and dark variants; `theme` continues to choose between them.

ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS color_theme VARCHAR(20) NOT NULL DEFAULT 'default';
