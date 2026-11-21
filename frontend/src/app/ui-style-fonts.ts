import {
  Bodoni_Moda,
  Bricolage_Grotesque,
  IBM_Plex_Mono,
  IBM_Plex_Sans,
  Instrument_Sans,
} from 'next/font/google';

/**
 * The typefaces the Classic and Modern UI styles (`src/app/ui-styles.css`)
 * swap in. Each is exposed only as a CSS variable on <html>; nothing reads
 * one until `html[data-ui-style]` points `--font-sans` / `--ui-font-display`
 * at it, and `preload: false` keeps the Standard style from downloading any
 * of them -- a browser fetches a webfont only when text is set in it.
 *
 * Self-hosted by next/font at build time, so the CSP's `font-src 'self'`
 * covers them exactly as it covers Inter. Scripts these faces lack (CJK,
 * Devanagari) fall through to the system stack named after each variable in
 * ui-styles.css.
 */

/** Classic: high-contrast didone for headings and large figures. */
const classicDisplay = Bodoni_Moda({
  subsets: ['latin', 'latin-ext'],
  axes: ['opsz'],
  variable: '--font-ui-classic-display',
  display: 'swap',
  preload: false,
});

/** Classic: the ledger's body and table text. */
const classicBody = IBM_Plex_Sans({
  subsets: ['latin', 'latin-ext', 'cyrillic', 'greek', 'vietnamese'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-ui-classic-body',
  display: 'swap',
  preload: false,
});

/** Classic: reference marks (cleared / reconciled), keyboard hints. */
const classicMono = IBM_Plex_Mono({
  subsets: ['latin', 'latin-ext', 'cyrillic', 'vietnamese'],
  weight: ['400', '500'],
  variable: '--font-ui-classic-mono',
  display: 'swap',
  preload: false,
});

/** Modern: the heavy grotesque for headings and headline numbers. */
const modernDisplay = Bricolage_Grotesque({
  subsets: ['latin', 'latin-ext', 'vietnamese'],
  axes: ['opsz'],
  variable: '--font-ui-modern-display',
  display: 'swap',
  preload: false,
});

/** Modern: body text. */
const modernBody = Instrument_Sans({
  subsets: ['latin', 'latin-ext'],
  variable: '--font-ui-modern-body',
  display: 'swap',
  preload: false,
});

/** Every UI-style font variable, for the <html> element's className. */
export const UI_STYLE_FONT_VARIABLES = [
  classicDisplay.variable,
  classicBody.variable,
  classicMono.variable,
  modernDisplay.variable,
  modernBody.variable,
].join(' ');
