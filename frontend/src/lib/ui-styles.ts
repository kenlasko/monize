/**
 * UI style identifiers: a second appearance axis beside the colour theme
 * (palette) and the light/dark mode. A style changes typography, shapes and
 * table styling, never colours. 'standard' applies no attribute and uses the
 * stock look; 'classic' and 'modern' are applied as `data-ui-style` on
 * `<html>`, with their CSS in `src/app/ui-styles.css`. Styles are independent
 * of, and composable with, every colour theme. The backend validates the same
 * list in `backend/src/users/dto/update-preferences.dto.ts`.
 */
export const UI_STYLES = ['standard', 'classic', 'modern'] as const;

export type UiStyle = (typeof UI_STYLES)[number];

export function isUiStyle(value: unknown): value is UiStyle {
  return typeof value === 'string' && (UI_STYLES as readonly string[]).includes(value);
}
