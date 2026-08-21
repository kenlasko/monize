import { describe, it, expect } from 'vitest';
import { COLOR_THEMES } from '@/lib/color-themes';
import { THEME_SWATCHES, type ThemeSwatch } from '@/lib/theme-swatches';
import { oklabDistance, resolveHex, themeTokens, type Mode } from '@/test/theme-css';

/**
 * `THEME_SWATCHES` claims to show what each palette looks like. A browser can
 * only compute the active theme's variables, so those values are copied into
 * TypeScript -- and a copy is a claim about a source that can move without it.
 *
 * This is that check: every swatch field names the token it stands for, and
 * the value must equal what the cascade resolves for that theme and mode. Edit
 * a palette without the swatch and the picker shows the previous colours,
 * which is worse than no preview -- it is a confident wrong one.
 */

/** Which token each swatch field shows, per mode. */
const TOKEN_FOR: Record<Mode, Record<keyof ThemeSwatch, string>> = {
  light: {
    page: '--color-gray-50',
    card: '--color-white',
    accent: '--color-blue-600',
    chart2: '--chart-2',
    chart4: '--chart-4',
  },
  dark: {
    page: '--color-gray-900',
    card: '--color-gray-800',
    accent: '--color-blue-400',
    chart2: '--chart-2',
    chart4: '--chart-4',
  },
};

describe('THEME_SWATCHES matches the stylesheets', () => {
  it('covers every colour theme, in both modes', () => {
    expect(Object.keys(THEME_SWATCHES).sort()).toEqual([...COLOR_THEMES].sort());
    for (const theme of COLOR_THEMES) {
      expect(THEME_SWATCHES[theme].light, `${theme} light`).toBeTruthy();
      expect(THEME_SWATCHES[theme].dark, `${theme} dark`).toBeTruthy();
    }
  });

  it('every swatch value equals the token it stands for', () => {
    const mismatches: string[] = [];
    for (const theme of COLOR_THEMES) {
      for (const mode of ['light', 'dark'] as const) {
        const tokens = themeTokens(theme, mode);
        const swatch = THEME_SWATCHES[theme][mode];
        for (const [field, token] of Object.entries(TOKEN_FOR[mode]) as [
          keyof ThemeSwatch,
          string,
        ][]) {
          const expected = resolveHex(tokens, token);
          if (swatch[field].toLowerCase() !== expected) {
            mismatches.push(
              `${theme} ${mode} ${field}: swatch ${swatch[field]} but ${token} is ${expected}`,
            );
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('a theme is distinguishable from every other by its swatch alone', () => {
    // The picker exists to make the palettes tellable apart. Two themes with
    // an identical swatch in a mode mean the preview cannot do that -- which
    // is the state light mode was in before the paper tints, when nine themes
    // shared a pure-white card.
    for (const mode of ['light', 'dark'] as const) {
      const seen = new Map<string, string>();
      const duplicates: string[] = [];
      for (const theme of COLOR_THEMES) {
        const key = Object.values(THEME_SWATCHES[theme][mode]).join('|');
        const previous = seen.get(key);
        if (previous) duplicates.push(`${mode}: ${previous} and ${theme}`);
        else seen.set(key, theme);
      }
      expect(duplicates).toEqual([]);
    }
  });

  it('no two tinted themes share a paper a reader cannot tell apart', () => {
    // Byte-equality is far too weak a test for "these look the same", and
    // this is the check that was missing: gruvbox and solarized differed in
    // every byte while rendering as one cream, and so did newspaper and
    // burgundy as one pink. Both passed the duplicate check above and both
    // were reported by a human looking at the running app.
    //
    // So compare the papers by perceptual distance in OKLab instead. The
    // floors are set below the current minimum with margin, and comfortably
    // above the collisions that were reported -- the worst of those measured
    // 0.0032 between two cards.
    const MIN_CARD_DISTANCE = 0.008;
    const MIN_PAGE_DISTANCE = 0.015;

    // The three themes that deliberately keep a neutral, untinted paper. They
    // all share a literally white card, so a paper-distance rule cannot apply
    // to them; the duplicate check above still holds them apart by accent and
    // chart colours, which is what actually distinguishes them.
    const UNTINTED_BY_DESIGN = new Set(['default', 'midnight', 'highcontrast']);
    const tinted = COLOR_THEMES.filter((theme) => !UNTINTED_BY_DESIGN.has(theme));

    const tooClose: string[] = [];
    for (let i = 0; i < tinted.length; i += 1) {
      for (let j = i + 1; j < tinted.length; j += 1) {
        const a = THEME_SWATCHES[tinted[i]].light;
        const b = THEME_SWATCHES[tinted[j]].light;
        const card = oklabDistance(a.card, b.card);
        const page = oklabDistance(a.page, b.page);
        if (card < MIN_CARD_DISTANCE || page < MIN_PAGE_DISTANCE) {
          tooClose.push(
            `${tinted[i]} / ${tinted[j]}: card ${card.toFixed(4)} (min ${MIN_CARD_DISTANCE}), ` +
              `page ${page.toFixed(4)} (min ${MIN_PAGE_DISTANCE})`,
          );
        }
      }
    }
    expect(tooClose).toEqual([]);
  });
});
