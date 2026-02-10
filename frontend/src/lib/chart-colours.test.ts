import { describe, it, expect } from 'vitest';
import { CHART_COLOURS, CHART_COLOURS_INCOME } from './chart-colours';

describe('CHART_COLOURS', () => {
  it('contains 20 colours', () => {
    expect(CHART_COLOURS).toHaveLength(20);
  });

  it('contains only valid hex colour strings', () => {
    for (const colour of CHART_COLOURS) {
      expect(colour).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('has no duplicate colours', () => {
    const unique = new Set(CHART_COLOURS);
    expect(unique.size).toBe(CHART_COLOURS.length);
  });
});

describe('CHART_COLOURS_INCOME', () => {
  it('contains 10 colours', () => {
    expect(CHART_COLOURS_INCOME).toHaveLength(10);
  });

  it('contains only valid hex colour strings', () => {
    for (const colour of CHART_COLOURS_INCOME) {
      expect(colour).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('has no duplicate colours', () => {
    const unique = new Set(CHART_COLOURS_INCOME);
    expect(unique.size).toBe(CHART_COLOURS_INCOME.length);
  });
});
