import { COLOR_THEMES, type ColorTheme } from './color-themes';

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

/**
 * The palette each style was designed in: Classic on the green-bar `ledger`,
 * Modern on `studio`. Picking the style switches to it when the palette in
 * use is not one of the style's own.
 */
export const UI_STYLE_COMPANION_PALETTE: Readonly<Record<UiStyle, ColorTheme | null>> = {
  standard: null,
  classic: 'ledger',
  modern: 'studio',
};

/**
 * Palettes every style offers, whatever its character: their promise is
 * accessibility (luminance contrast, a colour-blind-safe chart palette), and
 * a style must never be the reason a reader loses one.
 */
const ACCESSIBILITY_PALETTES: readonly ColorTheme[] = ['highcontrast', 'colorblind'];

/**
 * The palettes the colour theme picker offers under each style, companion
 * first. Standard offers every palette. Classic keeps the paper and print
 * palettes its ledger look was drawn for; Modern the clean and dark-first
 * ones. A palette absent here still renders correctly under the style (a
 * style names no colour); the list is about which pairs were meant.
 */
export const UI_STYLE_PALETTES: Readonly<Record<UiStyle, readonly ColorTheme[]>> = {
  standard: COLOR_THEMES,
  classic: [
    'ledger',
    'msmoney',
    'newspaper',
    'latte',
    'burgundy',
    'forest',
    'solarized',
    'gruvbox',
    ...ACCESSIBILITY_PALETTES,
  ],
  modern: [
    'studio',
    'default',
    'nord',
    'dracula',
    'tokyonight',
    'rosepine',
    'midnight',
    ...ACCESSIBILITY_PALETTES,
  ],
};

export function isPaletteForStyle(style: UiStyle, palette: ColorTheme): boolean {
  return UI_STYLE_PALETTES[style].includes(palette);
}

/**
 * The palette to use after switching to `style`: the current one when the
 * style offers it, otherwise the style's companion (or its first palette).
 */
export function paletteAfterStyleChange(style: UiStyle, current: ColorTheme): ColorTheme {
  if (isPaletteForStyle(style, current)) return current;
  return UI_STYLE_COMPANION_PALETTE[style] ?? UI_STYLE_PALETTES[style][0];
}
