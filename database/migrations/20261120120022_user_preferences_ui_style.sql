-- Per-user UI style preference, a second axis beside the colour theme
-- (`color_theme`) and the light/dark mode (`theme`). The value is one of the
-- styles defined in frontend/src/lib/ui-styles.ts and validated against the
-- same list in backend/src/users/dto/update-preferences.dto.ts. `standard` is
-- the familiar look; the other styles compose with every palette.

ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS ui_style VARCHAR(20) NOT NULL DEFAULT 'standard';
