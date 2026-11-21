-- The two UI styles added by 20261120120022_user_preferences_ui_style.sql are
-- renamed: `classic` becomes `folio` and `modern` becomes `pebble` (the list is
-- frontend/src/lib/ui-styles.ts, validated against the same values in
-- backend/src/users/dto/update-preferences.dto.ts). A saved preference follows
-- its style to the new name, so nobody is dropped back to `standard`.
--
-- Data only: the column, its type and its default are unchanged, so
-- schema.sql needs no edit. Each statement matches no row on re-apply.

UPDATE user_preferences SET ui_style = 'folio' WHERE ui_style = 'classic';

UPDATE user_preferences SET ui_style = 'pebble' WHERE ui_style = 'modern';
