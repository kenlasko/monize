import { describe, it, expect, vi } from 'vitest';
import type { DuplicateGroup } from '@/types/built-in-reports';
import { duplicateGroupCardPropsEqual } from './DuplicateGroupCard';

const group = {
  key: 'g1',
  confidence: 'high',
  transactions: [{ id: 'a' }, { id: 'b' }],
} as unknown as DuplicateGroup;

const base = {
  group,
  selected: new Set<string>(),
  onToggle: vi.fn(),
  onOpen: vi.fn(),
  categoryColorMap: new Map<string, string | null>(),
  categoryIconMap: new Map<string, string | null>(),
};

describe('duplicateGroupCardPropsEqual', () => {
  it('skips a redraw when a tick falls in another group', () => {
    expect(
      duplicateGroupCardPropsEqual(base, { ...base, selected: new Set(['other-group-row']) }),
    ).toBe(true);
  });

  it('redraws when a row of its own group is ticked or unticked', () => {
    const ticked = { ...base, selected: new Set(['a']) };
    expect(duplicateGroupCardPropsEqual(base, ticked)).toBe(false);
    expect(duplicateGroupCardPropsEqual(ticked, base)).toBe(false);
  });

  it('redraws when any other prop changes', () => {
    expect(duplicateGroupCardPropsEqual(base, { ...base, onToggle: vi.fn() })).toBe(false);
    expect(duplicateGroupCardPropsEqual(base, { ...base, group: { ...group } })).toBe(false);
    expect(
      duplicateGroupCardPropsEqual(base, { ...base, categoryColorMap: new Map() }),
    ).toBe(false);
  });
});
