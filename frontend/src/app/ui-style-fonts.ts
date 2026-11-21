import {
  Bodoni_Moda,
  Bricolage_Grotesque,
  IBM_Plex_Mono,
  IBM_Plex_Sans,
  Instrument_Sans,
} from 'next/font/google';

/**
 * The typefaces the Folio and Pebble UI styles (`src/app/ui-styles.css`)
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

/** Folio: high-contrast didone for headings and large figures. */
const folioDisplay = Bodoni_Moda({
  subsets: ['latin', 'latin-ext'],
  axes: ['opsz'],
  variable: '--font-ui-folio-display',
  display: 'swap',
  preload: false,
});

/** Folio: the ledger's body and table text. */
const folioBody = IBM_Plex_Sans({
  subsets: ['latin', 'latin-ext', 'cyrillic', 'greek', 'vietnamese'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-ui-folio-body',
  display: 'swap',
  preload: false,
});

/** Folio: reference marks (cleared / reconciled), keyboard hints. */
const folioMono = IBM_Plex_Mono({
  subsets: ['latin', 'latin-ext', 'cyrillic', 'vietnamese'],
  weight: ['400', '500'],
  variable: '--font-ui-folio-mono',
  display: 'swap',
  preload: false,
});

/** Pebble: the heavy grotesque for headings and headline numbers. */
const pebbleDisplay = Bricolage_Grotesque({
  subsets: ['latin', 'latin-ext', 'vietnamese'],
  axes: ['opsz'],
  variable: '--font-ui-pebble-display',
  display: 'swap',
  preload: false,
});

/** Pebble: body text. */
const pebbleBody = Instrument_Sans({
  subsets: ['latin', 'latin-ext'],
  variable: '--font-ui-pebble-body',
  display: 'swap',
  preload: false,
});

/** Every UI-style font variable, for the <html> element's className. */
export const UI_STYLE_FONT_VARIABLES = [
  folioDisplay.variable,
  folioBody.variable,
  folioMono.variable,
  pebbleDisplay.variable,
  pebbleBody.variable,
].join(' ');
