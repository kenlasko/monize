import { describe, it, expect } from 'vitest';

/**
 * Guard test for the shared chart chrome in `@/lib/chart-style` and
 * `@/components/ui/ChartActiveDot`.
 *
 * Before these existed every chart wrote its own grid, tooltip shell and
 * hover dot. Most agreed by copy-paste, and the ones that did not were the
 * defects: nine grids drew Recharts' untinted default stroke at 30% opacity
 * instead of the themed grid colour, and every `activeDot={{ r: 6 }}` took
 * Recharts' white ring, which on a dark card is an outline rather than a gap.
 * A new chart starts from the constants, and this test fails on the hand-rolled
 * versions coming back.
 *
 * Modelled on `src/test/ui-conventions.test.ts`.
 */
const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

function productionSources(): [string, string][] {
  return Object.entries(sources).filter(([path]) => !/\.test\.tsx?$/.test(path));
}

/** A grid that spreads one of the two shared prop sets and nothing else. */
const SHARED_GRID = /^<CartesianGrid \{\.\.\.(CHART_GRID_PROPS|CHART_GRID_PROPS_HORIZONTAL_BARS)\} \/>$/;

/** The tooltip shell every chart used to inline, before CHART_TOOLTIP_CLASS. */
const INLINE_TOOLTIP_SHELL =
  'bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3';

describe('charts share their chrome through @/lib/chart-style', () => {
  it('builds every CartesianGrid from CHART_GRID_PROPS', () => {
    const offenders: string[] = [];
    for (const [path, content] of productionSources()) {
      // The owner documents the usage in a comment, which is not a grid.
      if (path === '/src/lib/chart-style.ts') continue;
      for (const match of content.matchAll(/<CartesianGrid\b[\s\S]*?\/>/g)) {
        if (!SHARED_GRID.test(match[0])) offenders.push(`${path}: ${match[0].replace(/\s+/g, ' ')}`);
      }
    }
    // Spread CHART_GRID_PROPS (or CHART_GRID_PROPS_HORIZONTAL_BARS in a
    // layout="vertical" bar chart) rather than writing the dash and colour.
    expect(offenders).toEqual([]);
  });

  it('draws no chart tooltip shell by hand', () => {
    const offenders = productionSources()
      .filter(([, content]) => content.includes(INLINE_TOOLTIP_SHELL))
      .map(([path]) => path);
    // Use className={CHART_TOOLTIP_CLASS}.
    expect(offenders).toEqual([]);
  });

  it('gives no line or area series an inline activeDot object', () => {
    const offenders = productionSources()
      .filter(([, content]) => /activeDot=\{\{/.test(content))
      .map(([path]) => path);
    // Use activeDot={ChartActiveDot}; it takes the series colour from Recharts
    // and rings the dot in the card colour, not white.
    expect(offenders).toEqual([]);
  });

  it('still finds the shared module and grids that use it, so the rule cannot pass by accident', () => {
    const owner = sources['/src/lib/chart-style.ts'];
    expect(owner, '/src/lib/chart-style.ts not found -- update this test').toBeTruthy();
    expect(owner).toContain('export const CHART_GRID_PROPS ');
    expect(owner).toContain('export const CHART_TOOLTIP_CLASS');
    const grids = productionSources().filter(([, content]) =>
      content.includes('<CartesianGrid {...CHART_GRID_PROPS} />'),
    );
    expect(grids.length).toBeGreaterThan(20);
  });
});
