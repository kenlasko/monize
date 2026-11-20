import { THEME_SWATCHES } from './theme-swatches';
import { isColorTheme, type ColorTheme } from './color-themes';

// The PWA boot surfaces -- the OS splash screen (web app manifest), the
// server-rendered boot splash in the root layout, the theme-color meta, and
// the service worker's offline fallback -- all paint before ThemeContext has
// mounted, so they cannot read the localStorage theme. ThemeContext mirrors
// its resolved mode and active colour palette into these cookies, and the
// server-side consumers read them back.
//
// The mode cookie carries the *resolved* theme (light|dark), never 'system':
// the consumers cannot evaluate a media query at manifest-generation time,
// and the resolved value is what actually painted last.
export const RESOLVED_THEME_COOKIE = 'monize-resolved-theme';
export const COLOR_THEME_COOKIE = 'monize-color-theme';
export const UI_STYLE_COOKIE = 'monize-ui-style';

export type ResolvedTheme = 'light' | 'dark';

export function isResolvedTheme(value: unknown): value is ResolvedTheme {
  return value === 'light' || value === 'dark';
}

// The page background of the active palette, per mode -- what the OS splash,
// the status bar and the boot splash should show so the boot-to-app
// transition is seamless. THEME_SWATCHES is the sanctioned copy of the
// stylesheet (theme-swatches.test.ts fails when it drifts from themes.css);
// `page` is --color-gray-50 in light mode and --color-gray-900 in dark, the
// same tokens globals.css paints the page with.
export function bootPageColor(
  colorTheme: ColorTheme | null,
  mode: ResolvedTheme | null,
): string {
  const palette = colorTheme && isColorTheme(colorTheme) ? colorTheme : 'default';
  return THEME_SWATCHES[palette][mode ?? 'light'].page;
}

// Static fallbacks for surfaces that may render without the app stylesheet
// (the boot splash's var() defaults, the service worker's offline page).
// Backgrounds are the default palette's page colours; foregrounds are the
// stock gray-900 / gray-100 body text colours from globals.css.
export const BOOT_BACKGROUND: Record<ResolvedTheme, string> = {
  light: THEME_SWATCHES.default.light.page,
  dark: THEME_SWATCHES.default.dark.page,
};

export const BOOT_FOREGROUND: Record<ResolvedTheme, string> = {
  light: '#101828',
  dark: '#f3f4f6',
};
