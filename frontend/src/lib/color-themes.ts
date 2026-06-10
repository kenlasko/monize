/**
 * Colour theme (palette) identifiers, separate from the light/dark/system
 * mode preference. Each palette has both light and dark variants; the mode
 * setting chooses between them. Palette CSS lives in `src/app/themes.css`
 * under `html[data-theme="..."]` selectors ('default' applies no attribute
 * and uses the stock palette). The backend validates the same list in
 * `backend/src/users/dto/update-preferences.dto.ts`.
 */
export const COLOR_THEMES = [
  'default',
  'latte',
  'msmoney',
  'nord',
  'forest',
  'solarized',
  'highcontrast',
] as const;

export type ColorTheme = (typeof COLOR_THEMES)[number];

export function isColorTheme(value: unknown): value is ColorTheme {
  return (
    typeof value === 'string' && (COLOR_THEMES as readonly string[]).includes(value)
  );
}
