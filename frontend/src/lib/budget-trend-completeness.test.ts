import { describe, it, expect } from 'vitest';
import { trendPartialPairs } from './budget-trend-completeness';

describe('trendPartialPairs', () => {
  it('reads an absent flag as no information, never as partial', () => {
    expect(trendPartialPairs([{}, { valuationComplete: true }])).toBeNull();
  });

  it('collects the pairs of the partial points, sorted and unique', () => {
    expect(
      trendPartialPairs([
        { valuationComplete: false, missingRatePairs: ['USD->CAD', 'JPY->CAD'] },
        { valuationComplete: false, missingRatePairs: ['JPY->CAD'] },
        // A whole point's pairs are not the reader's to add.
        { valuationComplete: true, missingRatePairs: ['EUR->CAD'] },
      ]),
    ).toEqual(['JPY->CAD', 'USD->CAD']);
  });

  it('answers an empty list for a partial point that named no pair', () => {
    expect(trendPartialPairs([{ valuationComplete: false }])).toEqual([]);
  });
});
