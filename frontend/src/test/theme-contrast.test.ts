import { describe, it, expect } from 'vitest';
import { COLOR_THEMES } from '@/lib/color-themes';
import { globals, resolveHex, themeBlocks, themeTokens } from './theme-css';

const srgbToLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) =>
    srgbToLinear(parseInt(hex.slice(i, i + 2), 16) / 255),
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const CHART_KEYS = [
  'primary',
  'income',
  'expense',
  'warning',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
] as const;

interface Check {
  id: string;
  ratio: number;
  min: number;
}

function checksFor(theme: string): Check[] {
  const checks: Check[] = [];
  for (const mode of ['light', 'dark'] as const) {
    const t = themeTokens(theme, mode);
    const resolve = (name: string) => resolveHex(t, name);
    const card = mode === 'light' ? resolve('--color-white') : resolve('--color-gray-800');
    const page = mode === 'light' ? resolve('--color-gray-50') : resolve('--color-gray-900');
    const push = (label: string, a: string, b: string, min: number) =>
      checks.push({ id: `${theme} ${mode} ${label}`, ratio: contrast(a, b), min });

    if (mode === 'light') {
      push('body-text-on-card', resolve('--color-gray-900'), card, 4.5);
      push('body-text-on-page', resolve('--color-gray-900'), page, 4.5);
      push('muted-on-card', resolve('--color-gray-500'), card, 4.5);
      push('button-text', resolve('--color-white'), resolve('--color-blue-600'), 4.5);
    } else {
      push('body-text-on-card', resolve('--color-gray-100'), card, 4.5);
      push('body-text-on-page', resolve('--color-gray-100'), page, 4.5);
      push('muted-on-card', resolve('--color-gray-400'), card, 4.5);
      push('link-on-card', resolve('--color-blue-400'), card, 4.5);
      push('button-text', resolve('--color-white'), resolve('--color-blue-500'), 4.0);
      push('card-vs-page', card, page, 1.15);
      push('border-vs-card', resolve('--color-gray-700'), card, 1.3);
    }
    for (const key of CHART_KEYS) {
      push(`chart-${key}-on-card`, resolve(`--chart-${key}`), card, 3.0);
    }
  }
  return checks;
}

/**
 * Deliberate design exceptions, not debt. Midnight is a pure-black AMOLED
 * theme: its page IS black and its card near-black on purpose, and the card
 * separates by its border (CARD_CLASS always draws one), not by luminance.
 */
const DELIBERATE = new Set<string>([
  'midnight dark card-vs-page',
  'midnight dark border-vs-card',
  // `highcontrast` used to be listed here for the same reason and no longer
  // is: separating its card from its page was the fix for it reading as a
  // second midnight, and that separation clears the floor on its own.

  // The Okabe-Ito palette optimises for how well the SERIES separate from
  // each other under colour-vision deficiency, and spends background
  // contrast to do it -- several members sit near 3:1 even on pure white, so
  // any tinted card puts them under. These are deliberate, not debt: the
  // values are canonical and must stay exact. Darkening chart-2/5/9 to clear
  // the floor was tried and measured, and it dropped the closest pair's
  // separation under deuteranopia from 0.0327 to 0.0251 in OKLab -- a 23%
  // loss of the one thing this theme promises, to gain contrast the palette
  // never claimed. Change the surface before you change these.
  'colorblind light chart-2-on-card',
  'colorblind light chart-5-on-card',
  'colorblind light chart-9-on-card',
]);

/**
 * Pre-existing shortfalls this branch did not create and does not fix.
 * Shrink-only: fix one and the second test below forces its removal.
 * Grouped by cause:
 *  - `light muted-on-card` / light charts: light palettes authored before
 *    this guard existed, several a shade too light on their own paper.
 *  - `dark button-text`: themes whose blue-500 was picked as text-on-white
 *    and is too light to carry white button text (nord's frost especially).
 *  - `dark card-vs-page` etc. for themes whose canonical upstream surfaces
 *    are simply this compressed (solarized base02/base03, rosepine surface/
 *    base, tokyonight storm/night, forest stone-800/900) -- retuning them
 *    away from canon was considered and rejected; the border and shadow
 *    carry the separation there.
 */
const KNOWN_CONTRAST_DEBT = new Set<string>([
  // -- light chart palettes, authored before this guard --
  'default light chart-income-on-card',
  'default light chart-warning-on-card',
  'default light chart-2-on-card',
  'default light chart-3-on-card',
  'default light chart-7-on-card',
  'default light chart-8-on-card',
  'default light chart-9-on-card',
  'latte light chart-warning-on-card',
  'latte light chart-3-on-card',
  'latte light chart-8-on-card',
  'latte light chart-9-on-card',
  'newspaper light chart-warning-on-card',
  'newspaper light chart-3-on-card',
  'newspaper light chart-8-on-card',
  'burgundy light chart-warning-on-card',
  'burgundy light chart-3-on-card',
  'nord light chart-primary-on-card',
  'nord light chart-income-on-card',
  'nord light chart-warning-on-card',
  'nord light chart-2-on-card',
  'nord light chart-3-on-card',
  'nord light chart-5-on-card',
  'nord light chart-6-on-card',
  'nord light chart-7-on-card',
  'nord light chart-8-on-card',
  'nord light chart-9-on-card',
  'forest light chart-warning-on-card',
  'forest light chart-3-on-card',
  'forest light chart-7-on-card',
  'solarized light chart-income-on-card',
  'solarized light chart-warning-on-card',
  'solarized light chart-2-on-card',
  'solarized light chart-3-on-card',
  'solarized light chart-6-on-card',
  'solarized light chart-9-on-card',
  'gruvbox light chart-income-on-card',
  'gruvbox light chart-warning-on-card',
  'gruvbox light chart-2-on-card',
  'gruvbox light chart-3-on-card',
  'gruvbox light chart-7-on-card',
  'gruvbox light chart-8-on-card',
  'gruvbox light chart-9-on-card',
  'dracula light chart-income-on-card',
  'dracula light chart-warning-on-card',
  'dracula light chart-2-on-card',
  'dracula light chart-3-on-card',
  'dracula light chart-5-on-card',
  'dracula light chart-6-on-card',
  'dracula light chart-7-on-card',
  'dracula light chart-8-on-card',
  'dracula light chart-9-on-card',
  'tokyonight light chart-income-on-card',
  'tokyonight light chart-expense-on-card',
  'tokyonight light chart-warning-on-card',
  'tokyonight light chart-2-on-card',
  'tokyonight light chart-3-on-card',
  'tokyonight light chart-4-on-card',
  'tokyonight light chart-5-on-card',
  'tokyonight light chart-6-on-card',
  'tokyonight light chart-7-on-card',
  'tokyonight light chart-8-on-card',
  'rosepine light chart-warning-on-card',
  'rosepine light chart-2-on-card',
  'rosepine light chart-3-on-card',
  'rosepine light chart-7-on-card',
  'rosepine light chart-8-on-card',
  'rosepine light chart-9-on-card',
  'midnight light chart-income-on-card',
  'midnight light chart-warning-on-card',
  'midnight light chart-2-on-card',
  'midnight light chart-3-on-card',
  'midnight light chart-7-on-card',
  'midnight light chart-8-on-card',
  'midnight light chart-9-on-card',
  'colorblind light chart-warning-on-card',
  'colorblind light chart-3-on-card',
  'colorblind light chart-6-on-card',
  'colorblind light chart-7-on-card',
  // -- accents picked as text-on-white, carrying white button text --
  'nord light button-text',
  'default dark button-text',
  'latte dark button-text',
  'nord dark button-text',
  'solarized dark button-text',
  'gruvbox dark button-text',
  'dracula dark button-text',
  'midnight dark button-text',
]);

describe('theme contrast invariants', () => {
  const allChecks = COLOR_THEMES.flatMap((theme) => checksFor(theme));

  it('every colour pairing clears its minimum contrast', () => {
    const failures = allChecks
      .filter((c) => !DELIBERATE.has(c.id) && !KNOWN_CONTRAST_DEBT.has(c.id))
      .filter((c) => c.ratio < c.min)
      .map((c) => `${c.id}: ${c.ratio.toFixed(2)} < ${c.min}`);
    expect(failures).toEqual([]);
  });

  it('KNOWN_CONTRAST_DEBT is shrink-only: an entry that now passes must be removed', () => {
    const byId = new Map(allChecks.map((c) => [c.id, c]));
    const stale = [...KNOWN_CONTRAST_DEBT].filter((id) => {
      const check = byId.get(id);
      return !check || check.ratio >= check.min;
    });
    expect(stale).toEqual([]);
  });

  it('DELIBERATE and KNOWN_CONTRAST_DEBT name real checks and do not overlap', () => {
    const ids = new Set(allChecks.map((c) => c.id));
    const unknown = [...DELIBERATE, ...KNOWN_CONTRAST_DEBT].filter((id) => !ids.has(id));
    expect(unknown).toEqual([]);
    const overlap = [...DELIBERATE].filter((id) => KNOWN_CONTRAST_DEBT.has(id));
    expect(overlap).toEqual([]);
  });
});

describe('theme CSS structure', () => {
  it('parses a light block for every theme except default', () => {
    const expected = COLOR_THEMES.filter((t) => t !== 'default').sort();
    expect([...themeBlocks.light.keys()].sort()).toEqual(expected);
  });

  it('the parser still finds a known token, so the checks cannot pass over an empty set', () => {
    // Assert the shape, not the value: pinning a literal here makes every
    // palette edit fail a test about the parser rather than about the colour.
    expect(themeBlocks.light.get('latte')?.['--color-white']).toMatch(/^#[0-9a-f]{6}$/);
    expect(globals.root['--chart-1']).toBeTruthy();
    expect(globals.dark['--chart-1']).toBeTruthy();
  });

  it('a theme that overrides chart tokens in its light block carries a full dark block', () => {
    // The light block's specificity beats the `.dark` defaults, so without a
    // per-theme dark block the light chart palette renders on the dark card.
    // "Full" means every chart token: a partial dark block would mix lifted
    // and light-tuned series colours in one chart.
    const chartTokens = CHART_KEYS.filter((k) => k !== 'primary').map((k) => `--chart-${k}`);
    const missing: string[] = [];
    for (const [theme, decls] of themeBlocks.light) {
      if (!Object.keys(decls).some((k) => k.startsWith('--chart-'))) continue;
      const darkBlock = themeBlocks.dark.get(theme);
      for (const token of chartTokens) {
        if (!darkBlock?.[token]) missing.push(`${theme}: ${token}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every theme tints its light-mode paper, apart from the deliberate exceptions', () => {
    // Cards dominate the screen, so a theme whose card is pure #ffffff is
    // distinguishable in light mode only by its accent -- which is exactly
    // the sameness this branch removed. `default` keeps the stock identity,
    // `midnight` is documented as neutral in light mode, and `highcontrast`
    // must not spend luminance budget on decoration. `colorblind` is tinted:
    // its guarantee covers the chart palette, not the chrome.
    const UNTINTED_BY_DESIGN = new Set(['default', 'midnight', 'highcontrast']);
    const missing = COLOR_THEMES.filter(
      (theme) =>
        !UNTINTED_BY_DESIGN.has(theme) && !themeBlocks.light.get(theme)?.['--color-white'],
    );
    expect(missing).toEqual([]);
  });

  it('every themes.css value is a literal 6-digit hex, for resolvePdfColor', () => {
    // resolvePdfColor (src/components/reports/resolve-pdf-color.ts) accepts
    // only #rrggbb and silently falls back to grey for anything else, so an
    // oklch()/rgb()/var() value here would export grey charts to PDF.
    const offenders: string[] = [];
    for (const [theme, decls] of [...themeBlocks.light, ...themeBlocks.dark]) {
      for (const [name, value] of Object.entries(decls)) {
        if (!/^#[0-9a-f]{6}$/i.test(value)) offenders.push(`${theme} ${name}: ${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
