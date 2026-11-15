import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Dark mode is the `dark` class on `<html>`, not the OS media query, so the
 * browser cannot tell from the media query alone which native chrome to draw.
 * Without `color-scheme: dark` on `html.dark`, Chromium on Windows (the
 * Electron shell and desktop Chrome, which draw classic scrollbars) paints a
 * light page scrollbar, light select popups and a dark date-picker icon beside
 * a dark page. This pins both halves in `globals.css`.
 */
describe('native color-scheme follows the theme class (globals.css)', () => {
  const css = readFileSync(join(__dirname, '..', 'app', 'globals.css'), 'utf8');

  // Strip comments so the prose describing the rule cannot satisfy the scan.
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');

  it('declares a light color-scheme on html', () => {
    expect(code).toMatch(/(^|\n)html\s*\{[^}]*color-scheme:\s*light/);
  });

  it('switches to a dark color-scheme on html.dark', () => {
    expect(code).toMatch(/(^|\n)html\.dark\s*\{[^}]*color-scheme:\s*dark/);
  });
});
