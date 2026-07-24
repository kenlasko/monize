import { describe, it, expect } from 'vitest';
import { TOUR_ANCHORS } from './anchors';

// Read every source file at build time. Anchor drift (a data-tour-id detached
// by a refactor, or the same id attached twice) is the engine's biggest
// long-term failure mode, so assert each anchor is attached in exactly one
// place via a literal `tourAnchor(TOUR_ANCHORS.<key>)` call. Test files are
// excluded -- they may reference anchors without attaching them.
const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

function countUsages(key: string): number {
  const pattern = new RegExp(
    `tourAnchor\\(\\s*TOUR_ANCHORS\\.${key}(?![A-Za-z0-9])`,
    'g',
  );
  let total = 0;
  for (const [path, content] of Object.entries(sources)) {
    if (/\.test\.tsx?$/.test(path)) continue;
    total += (content.match(pattern) ?? []).length;
  }
  return total;
}

describe('tour anchor uniqueness', () => {
  it.each(Object.keys(TOUR_ANCHORS))(
    'attaches TOUR_ANCHORS.%s in exactly one place',
    (key) => {
      expect(countUsages(key)).toBe(1);
    },
  );
});
