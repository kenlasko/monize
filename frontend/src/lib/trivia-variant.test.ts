import { describe, it, expect } from 'vitest';
import { pickTriviaVariant } from './trivia-variant';

const KEYS = ['facts.x', 'variants.x.b', 'variants.x.c'];

const day = (n: number) => `2026-11-${String(n).padStart(2, '0')}`;

describe('pickTriviaVariant', () => {
  it('is stable for a fixed fact and day', () => {
    const first = pickTriviaVariant(KEYS, 'netWorthHighPoint', '2026-11-19');
    for (let i = 0; i < 5; i++) {
      expect(pickTriviaVariant(KEYS, 'netWorthHighPoint', '2026-11-19')).toBe(first);
    }
    expect(KEYS).toContain(pickTriviaVariant(KEYS, 'netWorthHighPoint', '2026-11-19'));
  });

  it('spreads over all three keys across 30 days', () => {
    const chosen = new Set(Array.from({ length: 30 }, (_, i) => pickTriviaVariant(KEYS, 'netWorthHighPoint', day(i + 1))));
    expect(chosen).toEqual(new Set(KEYS));
  });

  it('gives the one key it is given', () => {
    for (let i = 1; i <= 10; i++) {
      expect(pickTriviaVariant(['facts.x'], 'spendingLastDay', day(i))).toBe('facts.x');
    }
  });
});
