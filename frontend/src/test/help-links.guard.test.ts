import { describe, it, expect } from 'vitest';
import { blankComments } from './blank-comments';

/**
 * A screen's help is `PageHeader`'s `help` prop, a key of `DOCS_LINKS`, and a
 * plain click on it opens the in-app help panel (`docs/frontend/ui-conventions.md`).
 * Two ways back to the old behaviour are mechanical, so they are checked here:
 *
 * - the retired `helpUrl` prop, which made every `?` a link to a new browser
 *   tab (a screen that wants one passes `help` instead), and
 * - a documentation URL spelled out in a page, which `docs-links.test.ts` cannot
 *   check against the generated site and which the panel cannot open.
 */
const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

const productionSources = Object.entries(sources).filter(
  ([path]) => !/\.test\.tsx?$/.test(path) && !path.endsWith('.guard.test.ts'),
);

function offenders(pattern: RegExp, scope: (path: string) => boolean): string[] {
  return productionSources
    .filter(([path]) => scope(path))
    .flatMap(([path, source]) =>
      blankComments(source)
        .split('\n')
        .map((line, i) => (pattern.test(line) ? `${path.replace(/^\//, '')}:${i + 1}` : null))
        .filter((hit): hit is string => hit !== null),
    );
}

describe('help links', () => {
  it('has found the sources', () => {
    expect(productionSources.length).toBeGreaterThan(100);
    expect(productionSources.some(([path]) => path.startsWith('/src/app/'))).toBe(true);
  });

  it('no PageHeader takes the retired helpUrl prop', () => {
    expect(
      offenders(/\bhelpUrl\s*=/, () => true),
      'pass `help="<DOCS_LINKS key>"` to PageHeader instead of helpUrl',
    ).toEqual([]);
  });

  it('no page under src/app spells out a documentation URL', () => {
    expect(
      offenders(/monize\.net\/docs|DOCS_BASE_URL/, (path) => path.startsWith('/src/app/')),
      'name a destination in lib/docs-links.ts and pass its key (`help`, or docsUrl(key) for an inline link)',
    ).toEqual([]);
  });
});
