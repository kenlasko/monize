import { describe, it, expect } from 'vitest';
import {
  periodBaselineDate,
  periodResultUnknownReason,
  withheldPeriodCause,
} from './portfolio-period-result';

/**
 * One glyph, five server reasons: the mapping decides which repair the reader
 * is sent to, and sending them to the wrong screen is the defect `displayFx`
 * exists to avoid.
 */
describe('periodResultUnknownReason', () => {
  it('sends an unpriced holding to the security, not to the rates', () => {
    expect(periodResultUnknownReason(['incompletePrices'])).toBe('noPrice');
  });

  it('sends a cash gap to neither a price nor a rate', () => {
    expect(periodResultUnknownReason(['incompleteCash'])).toBe('noCashBalance');
  });

  it('sends an unconvertible amount to the rates', () => {
    expect(periodResultUnknownReason(['missingRatePairs'])).toBe('displayFx');
  });

  it.each(['zeroStart', 'noValueSeries'] as const)(
    'treats %s as a boundary with nothing to repair',
    (reason) => {
      expect(periodResultUnknownReason([reason])).toBe('noBaseline');
    },
  );

  it('names the price when a day is short of more than one component', () => {
    // A price is the repair the reader can make first, and repairing it may
    // resolve the rest of the day; the banner still carries every cause.
    expect(
      periodResultUnknownReason(['missingRatePairs', 'incompletePrices']),
    ).toBe('noPrice');
  });

  it('says nothing about a reason list it was never given', () => {
    expect(periodResultUnknownReason([])).toBe('noBaseline');
  });

  it.each(['externallySettledTrade', 'mixedSplit'] as const)(
    'sends %s nowhere, because no missing datum caused it',
    (reason) => {
      expect(periodResultUnknownReason([reason])).toBe('noBaseline');
    },
  );
});

describe('withheldPeriodCause', () => {
  it('prints nothing for boundaries, which are not defects', () => {
    expect(withheldPeriodCause([['noValueSeries'], ['zeroStart']])).toBeNull();
    expect(withheldPeriodCause([])).toBeNull();
  });

  it('ranks a price over a balance over a rate, across periods', () => {
    expect(
      withheldPeriodCause([['missingRatePairs'], ['incompleteCash']]),
    ).toBe('incompleteCash');
    expect(
      withheldPeriodCause([['missingRatePairs'], ['incompletePrices']]),
    ).toBe('incompletePrices');
    expect(withheldPeriodCause([['missingRatePairs']])).toBe('missingRatePairs');
  });

  // #1516: these withhold only the account result, which no card shows.
  it('prints nothing for an uncountable movement', () => {
    expect(withheldPeriodCause([['externallySettledTrade']])).toBeNull();
    expect(withheldPeriodCause([['mixedSplit', 'noValueSeries']])).toBeNull();
    expect(
      withheldPeriodCause([['mixedSplit'], ['missingRatePairs']]),
    ).toBe('missingRatePairs');
  });
});

describe('periodBaselineDate', () => {
  it('sends the prior close only where it precedes the period', () => {
    expect(periodBaselineDate('2026-08-31', '2026-09-01')).toBe('2026-08-31');
    expect(periodBaselineDate('2026-09-01', '2026-09-01')).toBeUndefined();
    expect(periodBaselineDate('', '2026-09-01')).toBeUndefined();
    expect(periodBaselineDate('2026-08-31', '')).toBeUndefined();
  });
});
