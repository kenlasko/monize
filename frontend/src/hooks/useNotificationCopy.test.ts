import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, renderHook } from '@/test/render';
import { usePreferencesStore } from '@/store/preferencesStore';
import { useNotificationCopy } from './useNotificationCopy';

type Row = { type: string; title: string; message: string; data: Record<string, unknown> };

const row = (type: string, data: Record<string, unknown>): Row => ({
  type,
  title: 'stored title',
  message: 'stored message',
  data,
});

function copyOf(notification: Row) {
  const { result } = renderHook(() => useNotificationCopy());
  return result.current(notification);
}

const base = { securityId: 's1', accountId: 'a1', instrumentId: 'i1', currency: 'PLN' };

describe('useNotificationCopy: bond notifications', () => {
  it('BOND_MATURITY_SOON states the payout when it is known', () => {
    const copy = copyOf(
      row('BOND_MATURITY_SOON', {
        ...base,
        seriesCode: 'EDO1026',
        maturityDate: '2026-10-25',
        quantity: 40,
        payout: '4500.00',
        interest: '500.00',
        principalReturned: '4000.00',
        missing: null,
      }),
    );
    expect(copy.title).toContain('EDO1026');
    expect(copy.message).toContain('40 x EDO1026');
    expect(copy.message).toMatch(/payout is .*4,500\.00/);
    expect(copy.message).not.toContain('not known');
  });

  it('BOND_MATURITY_SOON says the payout is not known yet, with the reason, never zero', () => {
    const copy = copyOf(
      row('BOND_MATURITY_SOON', {
        ...base,
        seriesCode: 'EDO1026',
        maturityDate: '2026-10-25',
        quantity: 40,
        payout: null,
        interest: null,
        principalReturned: null,
        missing: 'RATE_UNKNOWN',
      }),
    );
    expect(copy.message).toContain('The payout is not known yet: a rate it depends on is not published yet.');
    expect(copy.message).not.toMatch(/0\.00/);
  });

  it('BOND_REDEMPTION_UNBOOKED composes known and unknown payouts', () => {
    const data = {
      ...base,
      seriesCode: 'ROR0925',
      maturityDate: '2026-10-01',
      quantity: 10,
      interest: null,
      principalReturned: null,
    };
    const known = copyOf(row('BOND_REDEMPTION_UNBOOKED', { ...data, payout: '1020.00', missing: null }));
    expect(known.title).toContain('redemption not booked');
    expect(known.message).toMatch(/1,020\.00/);
    const unknown = copyOf(
      row('BOND_REDEMPTION_UNBOOKED', { ...data, payout: null, missing: 'SOMETHING_ELSE' }),
    );
    expect(unknown.message).toContain('it cannot be worked out from the data stored');
  });

  it('BOND_INTEREST_PAYMENT shows the amount, or that it is not known yet', () => {
    const data = { ...base, seriesCode: 'COI1029', paymentDate: '2026-10-13', quantity: 10 };
    const known = copyOf(row('BOND_INTEREST_PAYMENT', { ...data, amount: '51.00' }));
    expect(known.message).toMatch(/51\.00/);
    const unknown = copyOf(row('BOND_INTEREST_PAYMENT', { ...data, amount: null }));
    expect(unknown.message).toContain('The amount is not known yet');
    expect(unknown.message).not.toMatch(/\d\.00/);
  });

  it('BOND_RATE_RESET formats the fraction as a percentage', () => {
    const copy = copyOf(
      row('BOND_RATE_RESET', {
        ...base,
        seriesCode: 'EDO1026',
        periodStart: '2026-10-13',
        periodEnd: '2027-10-13',
        periodIndex: 2,
        annualRate: '0.069',
        rateSource: 'DERIVED',
      }),
    );
    expect(copy.message).toContain('6.90%');
    expect(copy.message).toContain('period 2');
  });

  it('BOND_BENCHMARK_PUBLISHED lists the series and the count left out', () => {
    const copy = copyOf(
      row('BOND_BENCHMARK_PUBLISHED', {
        securityId: null,
        accountId: null,
        instrumentId: null,
        seriesCode: null,
        currency: 'PLN',
        benchmarkId: 'PL_CPI_GUS_YOY',
        publisher: 'GUS',
        observation: '2026-09',
        value: '0.0490000000',
        unit: 'RATE_FRACTION',
        publishedOn: '2026-10-13',
        affected: [
          { instrumentId: 'i1', seriesCode: 'EDO1026', periodStart: '2026-11-01', annualRate: '0.069', rateSource: 'DERIVED' },
          { instrumentId: 'i2', seriesCode: 'COI1029', periodStart: '2026-12-01', annualRate: null, rateSource: null },
        ],
        affectedMore: 3,
      }),
    );
    expect(copy.title).toContain('CPI, 12 months (GUS)');
    expect(copy.title).not.toContain('PL_CPI_GUS_YOY');
    expect(copy.title).toContain('September 2026');
    expect(copy.message).toContain('GUS published CPI, 12 months (GUS) for September 2026: 4.90%.');
    expect(copy.message).toContain('EDO1026');
    expect(copy.message).toContain('6.90%');
    expect(copy.message).toContain('COI1029');
    expect(copy.message).toContain('the rate is not known yet');
    expect(copy.message).toContain('And 3 more.');
  });

  it('BOND_BENCHMARK_PUBLISHED says a projected rate is projected, and keeps derived, announced and terms rates as known', () => {
    const entry = (seriesCode: string, rateSource: string) => ({
      instrumentId: seriesCode,
      seriesCode,
      periodStart: '2026-11-01',
      annualRate: '0.069',
      rateSource,
    });
    const copy = copyOf(
      row('BOND_BENCHMARK_PUBLISHED', {
        currency: 'PLN',
        benchmarkId: 'PL_CPI_GUS_YOY',
        publisher: 'GUS',
        observation: '2026-09',
        value: '0.0490000000',
        unit: 'RATE_FRACTION',
        affected: [
          entry('PRJ1', 'PROJECTED'),
          entry('DER1', 'DERIVED'),
          entry('ANN1', 'ANNOUNCED'),
          entry('TRM1', 'TERMS'),
        ],
        affectedMore: 0,
      }),
    );
    expect(copy.message).toContain('PRJ1: period from');
    expect(copy.message).toMatch(/PRJ1: period from [^.]*, projected at 6\.90% a year\./);
    for (const known of ['DER1', 'ANN1', 'TRM1']) {
      expect(copy.message).toMatch(new RegExp(`${known}: period from [^,]* at 6\\.90% a year\\.`));
    }
    expect(copy.message).not.toMatch(/DER1[^.]*projected/);
  });

  it('BOND_BENCHMARK_PUBLISHED shows an unknown unit as a plain number and an unlabelled benchmark by its id', () => {
    const copy = copyOf(
      row('BOND_BENCHMARK_PUBLISHED', {
        currency: 'PLN',
        benchmarkId: 'XX_OTHER',
        publisher: 'Pub',
        observation: '2026-09',
        value: '123.5',
        unit: 'INDEX_POINTS',
        affected: [{ seriesCode: 'S1', periodStart: '2026-11-01', annualRate: null }],
        affectedMore: 0,
      }),
    );
    expect(copy.title).toContain('XX_OTHER');
    expect(copy.message).toContain('123.5');
    expect(copy.message).not.toContain('%');
  });

  it('BOND_DATA_MISSING gives one sentence per cause with what to do', () => {
    const copy = copyOf(
      row('BOND_DATA_MISSING', {
        ...base,
        seriesCode: null,
        causes: [
          { code: 'OBSERVATION_MISSING', benchmarkId: 'PL_CPI_GUS_YOY', observation: '2026-08', publisher: 'GUS' },
          { code: 'PURCHASE_OUTSIDE_SALE_WINDOW', instrumentId: 'i1', seriesCode: 'EDO1026', purchaseDate: '2026-01-05', from: '2026-02-01', to: '2026-02-28' },
          { code: 'LOTS_UNDERIVABLE', refusalCode: 'NEGATIVE_QUANTITY' },
        ],
      }),
    );
    expect(copy.title).toBe('Bond figures are not known yet');
    expect(copy.message).toContain('The August 2026 observation of CPI, 12 months (GUS) (GUS) is not stored');
    expect(copy.message).toContain('Refresh on the bond page.');
    expect(copy.message).toContain('Correct the purchase date.');
    expect(copy.message).toContain('(NEGATIVE_QUANTITY). Correct the ledger.');
  });

  it('BOND_DATA_MISSING names a marketable lot bought on or after its maturity', () => {
    const copy = copyOf(
      row('BOND_DATA_MISSING', {
        ...base,
        seriesCode: null,
        causes: [
          { code: 'PURCHASE_AFTER_MATURITY', instrumentId: 'i1', seriesCode: 'S-1', purchaseDate: '2027-04-02', maturityDate: '2027-04-01' },
        ],
      }),
    );
    expect(copy.message).toContain('A purchase of S-1 on');
    expect(copy.message).toContain('is on or after its maturity');
    expect(copy.message).toContain('Correct the purchase date.');
  });

  describe('BOND_DATA_MISSING names the refused row of underivable lots', () => {
    const lots = (refusalCode: string, extra: Record<string, unknown> = {}) =>
      copyOf(
        row('BOND_DATA_MISSING', {
          ...base,
          seriesCode: null,
          causes: [
            { code: 'LOTS_UNDERIVABLE', refusalCode, action: 'SELL', date: '2026-01-02', quantity: '5', rowId: 'r1', ...extra },
          ],
        }),
      ).message;

    it('asks for the series on a purchase without one', () => {
      for (const code of ['SERIES_NOT_DETERMINED', 'SERIES_REQUIRED']) {
        const message = lots(code, { action: 'BUY' });
        expect(message).toContain('Purchase on');
        expect(message).toContain('Choose the series on that transaction.');
      }
    });

    it('says a removal exceeds what the account holds of the series', () => {
      const message = lots('REMOVAL_EXCEEDS_SERIES');
      expect(message).toContain('Sale on');
      expect(message).toContain('removes more than the account holds of that series');
    });

    it('asks to correct the transaction for any other code, with the action as written when it has no label', () => {
      expect(lots('OVER_REMOVAL')).toContain('Correct the transaction.');
      expect(lots('OVER_REMOVAL', { action: 'MYSTERY' })).toContain('Transaction on');
    });
  });

  it('falls back to the stored English when the facts are missing', () => {
    const copy = copyOf(row('BOND_INTEREST_PAYMENT', { seriesCode: 'COI1029' }));
    expect(copy.title).toBe('stored title');
    expect(copy.message).toBe('stored message');
  });
});

describe('useNotificationCopy: AI review notifications', () => {
  afterEach(() => {
    // Unmount first: a store write re-renders a mounted hook outside act().
    cleanup();
    usePreferencesStore.setState({ preferences: null });
  });

  it.each([
    ['Pacific/Auckland', '2026-11-06'],
    ['UTC', '2026-11-05'],
  ])('renders the expiry date in the reader timezone %s, not the server one', (timezone, day) => {
    usePreferencesStore.setState({ preferences: { dateFormat: 'YYYY-MM-DD', timezone } as any });
    const copy = copyOf(
      row('AI_REVIEW_PROPOSALS_EXPIRING', { count: 1, earliestExpiresAt: '2026-11-05T23:30:00.000Z' }),
    );
    expect(copy.message).toContain(`expires on ${day}`);
  });

  it('AI_REVIEW_PROPOSALS_READY states the counts', () => {
    const copy = copyOf(row('AI_REVIEW_PROPOSALS_READY', { count: 1, added: 1 }));
    expect(copy.title).toBe('AI proposals wait for your approval');
    expect(copy.message).toContain('1 AI proposal waits for your approval (1 new)');
    const many = copyOf(row('AI_REVIEW_PROPOSALS_READY', { count: 1200, added: 2 }));
    expect(many.message).toContain('1,200 AI proposals wait');
  });

  it('AI_REVIEW_PROPOSALS_EXPIRING states the count and the earliest date', () => {
    const copy = copyOf(
      row('AI_REVIEW_PROPOSALS_EXPIRING', { count: 2, earliestExpiresAt: '2026-11-05T12:00:00.000Z' }),
    );
    expect(copy.title).toBe('AI proposals expire soon');
    expect(copy.message).toContain('2 AI proposals expire soon');
    expect(copy.message).toMatch(/expires on .*2026/);
  });

  it('falls back to the stored English when the facts are missing or invalid', () => {
    for (const [type, data] of [
      ['AI_REVIEW_PROPOSALS_READY', {}],
      ['AI_REVIEW_PROPOSALS_READY', { count: 3 }],
      ['AI_REVIEW_PROPOSALS_READY', { count: 0, added: 0 }],
      ['AI_REVIEW_PROPOSALS_EXPIRING', { count: 2 }],
      ['AI_REVIEW_PROPOSALS_EXPIRING', { count: 2, earliestExpiresAt: 'not a date' }],
      ['AI_REVIEW_PROPOSALS_EXPIRING', { count: '2', earliestExpiresAt: '2026-11-05T12:00:00.000Z' }],
    ] as const) {
      const copy = copyOf(row(type, { ...data }));
      expect(copy.title).toBe('stored title');
      expect(copy.message).toBe('stored message');
    }
  });
});

describe('useNotificationCopy: warranty notifications', () => {
  afterEach(() => {
    cleanup();
    usePreferencesStore.setState({ preferences: null });
  });

  const facts = { warrantyId: 'w1', name: 'Dishwasher', expiresOn: '2026-11-20', threshold: 30, daysLeft: 30 };

  it('WARRANTY_EXPIRING names the warranty, the mark and the date in the reader format', () => {
    usePreferencesStore.setState({ preferences: { dateFormat: 'YYYY-MM-DD', timezone: 'UTC' } as any });
    const copy = copyOf(row('WARRANTY_EXPIRING', facts));
    expect(copy.title).toBe('Dishwasher: warranty expires within 30 days');
    expect(copy.message).toContain('The warranty for Dishwasher expires on 2026-11-20.');
    expect(copyOf(row('WARRANTY_EXPIRING', { ...facts, threshold: 7 })).title).toContain('within 7 days');
  });

  it('WARRANTY_EXPIRES_TODAY says it expires today', () => {
    usePreferencesStore.setState({ preferences: { dateFormat: 'YYYY-MM-DD', timezone: 'UTC' } as any });
    const copy = copyOf(row('WARRANTY_EXPIRES_TODAY', { ...facts, threshold: 0, daysLeft: 0 }));
    expect(copy.title).toBe('Dishwasher: warranty expires today');
    expect(copy.message).toContain('expires today, 2026-11-20');
  });

  it('falls back to the stored English when the facts are missing or invalid', () => {
    for (const [type, data] of [
      ['WARRANTY_EXPIRING', {}],
      ['WARRANTY_EXPIRING', { ...facts, name: '' }],
      ['WARRANTY_EXPIRING', { ...facts, expiresOn: 'soon' }],
      ['WARRANTY_EXPIRING', { ...facts, threshold: 0 }],
      ['WARRANTY_EXPIRING', { ...facts, threshold: '30' }],
      ['WARRANTY_EXPIRES_TODAY', { name: 'Dishwasher' }],
      ['WARRANTY_EXPIRES_TODAY', { ...facts, expiresOn: 20261120 }],
    ] as const) {
      const copy = copyOf(row(type, { ...data }));
      expect(copy.title).toBe('stored title');
      expect(copy.message).toBe('stored message');
    }
  });
});
