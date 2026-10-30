import { describe, it, expect } from 'vitest';
import {
  groupPricesByPeriod,
  allPriceGroupKeys,
  defaultOpenPriceGroups,
  inferDistributionPolicy,
  totalReturnOf,
  toPriceSeries,
  buildQuantitySteps,
  quantityAt,
  buildChartSeries,
  periodStartDate,
  computePeriodReturn,
  computePositionReturn,
  filterPriceWindow,
  priceDecimals,
  MAX_PRICE_DECIMALS,
  shiftWindow,
  maxSpansBack,
  documentHost,
} from './security-detail';
import type {
  SecurityPrice,
  SecurityHistoryTransaction,
} from '@/types/investment';
import { TransactionStatus } from '@/types/transaction';

function price(
  priceDate: string,
  closePrice: number,
  adjustedClose: number | null = null,
): SecurityPrice {
  return {
    id: 1,
    securityId: 'sec-1',
    priceDate,
    openPrice: null,
    highPrice: null,
    lowPrice: null,
    closePrice,
    adjustedClose,
    volume: null,
    source: 'yahoo_finance',
    quotedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function transaction(
  transactionDate: string,
  runningQuantityAll: number,
): SecurityHistoryTransaction {
  return {
    id: `tx-${transactionDate}-${runningQuantityAll}`,
    transactionDate,
    accountId: 'acct-1',
    accountName: 'Brokerage',
    action: 'BUY',
    quantity: runningQuantityAll,
    price: 100,
    commission: 0,
    totalAmount: 100,
    description: null,
    status: TransactionStatus.CLEARED,
    runningQuantityAccount: runningQuantityAll,
    runningQuantityAll,
  };
}

describe('totalReturnOf', () => {
  it('prefers the adjusted close', () => {
    expect(totalReturnOf({ date: '2026-01-01', close: 100, totalReturnClose: 104 })).toBe(104);
  });

  it('falls back to the quoted close when there is no adjusted one', () => {
    // Same rule as the backend's COALESCE(adjusted_close, close_price).
    expect(totalReturnOf({ date: '2026-01-01', close: 100 })).toBe(100);
  });
});

describe('toPriceSeries', () => {
  it('carries the adjusted close through when the provider supplies one', () => {
    const [point] = toPriceSeries([price('2026-01-01', 100, 97.5)]);
    expect(point.close).toBe(100);
    expect(point.totalReturnClose).toBe(97.5);
  });

  it('leaves the total-return value unset for a provider without one', () => {
    // MSN stores null here; the series must not pretend price is total return.
    const [point] = toPriceSeries([price('2026-01-01', 100, null)]);
    expect(point.totalReturnClose).toBeUndefined();
  });

  it('ignores a nonsensical adjusted close', () => {
    const [point] = toPriceSeries([price('2026-01-01', 100, 0)]);
    expect(point.totalReturnClose).toBeUndefined();
  });

  it('flips the newest-first API order into oldest-first', () => {
    const series = toPriceSeries([
      price('2026-03-01', 30),
      price('2026-01-01', 10),
      price('2026-02-01', 20),
    ]);
    expect(series.map((p) => p.date)).toEqual([
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
    ]);
  });

  it('trims a timestamp down to the calendar day', () => {
    const series = toPriceSeries([price('2026-01-15T00:00:00.000Z', 10)]);
    expect(series[0].date).toBe('2026-01-15');
  });

  it('drops rows whose price is not a number', () => {
    const series = toPriceSeries([
      price('2026-01-01', 10),
      { ...price('2026-01-02', 0), closePrice: NaN },
    ]);
    expect(series).toHaveLength(1);
  });
});

describe('inferDistributionPolicy', () => {
  it('calls a fund accumulating when the two series never part', () => {
    // Yahoo's close is split-adjusted and its adjusted close is split- and
    // dividend-adjusted, so agreement throughout means nothing was paid out.
    expect(
      inferDistributionPolicy([
        { date: '2024-01-01', close: 100, totalReturnClose: 100 },
        { date: '2025-01-01', close: 120, totalReturnClose: 120 },
      ]),
    ).toBe('accumulating');
  });

  it('calls a fund distributing once the series diverge', () => {
    expect(
      inferDistributionPolicy([
        { date: '2024-01-01', close: 100, totalReturnClose: 97 },
        { date: '2025-01-01', close: 120, totalReturnClose: 120 },
      ]),
    ).toBe('distributing');
  });

  it('ignores an adjusted close above the quoted one, which is bad data', () => {
    // Back-adjustment only ever pushes the adjusted series *below* the quoted
    // one, so a point above it says nothing about distributions -- it says the
    // row is wrong. Reading the gap unsigned let a single such row relabel an
    // accumulating fund as distributing, and the label then stuck for every
    // reader of the page.
    expect(
      inferDistributionPolicy([
        { date: '2024-01-01', close: 100, totalReturnClose: 100 },
        { date: '2024-06-01', close: 101, totalReturnClose: 101 },
        { date: '2025-01-01', close: 103, totalReturnClose: 103.5 },
      ]),
    ).toBe('accumulating');
  });

  it('ignores a gap that is only provider rounding', () => {
    // Six decimal places of storage can leave a hair of difference; that is not
    // a dividend.
    expect(
      inferDistributionPolicy([
        { date: '2024-01-01', close: 100, totalReturnClose: 100.00002 },
        { date: '2025-01-01', close: 120, totalReturnClose: 120.00001 },
      ]),
    ).toBe('accumulating');
  });

  it('concludes nothing without an adjusted series', () => {
    // MSN supplies none, so there is nothing to compare and nothing to say.
    expect(
      inferDistributionPolicy([
        { date: '2024-01-01', close: 100 },
        { date: '2025-01-01', close: 120 },
      ]),
    ).toBe('unknown');
  });

  it('concludes nothing from a single comparable point', () => {
    // The two series always agree on the newest point, because no distribution
    // has happened since it.
    expect(
      inferDistributionPolicy([
        { date: '2025-01-01', close: 120, totalReturnClose: 120 },
      ]),
    ).toBe('unknown');
  });

  it('concludes nothing from an empty history', () => {
    expect(inferDistributionPolicy([])).toBe('unknown');
  });

  it('ignores points with no usable close', () => {
    expect(
      inferDistributionPolicy([
        { date: '2024-01-01', close: 0, totalReturnClose: 5 },
        { date: '2025-01-01', close: 120, totalReturnClose: 120 },
      ]),
    ).toBe('unknown');
  });
});

describe('buildQuantitySteps', () => {
  it('reads the running total the backend already computed', () => {
    const steps = buildQuantitySteps([
      transaction('2024-01-01', 10),
      transaction('2024-06-01', 25),
      transaction('2025-01-01', 5),
    ]);
    expect(steps).toEqual([
      { date: '2024-01-01', quantity: 10 },
      { date: '2024-06-01', quantity: 25 },
      { date: '2025-01-01', quantity: 5 },
    ]);
  });

  it('collapses several trades on one day to that day s closing balance', () => {
    const steps = buildQuantitySteps([
      transaction('2024-01-01', 10),
      transaction('2024-01-01', 30),
      transaction('2024-01-01', 22),
    ]);
    expect(steps).toEqual([{ date: '2024-01-01', quantity: 22 }]);
  });

  it('returns nothing for a security that was never traded', () => {
    expect(buildQuantitySteps([])).toEqual([]);
  });
});

describe('quantityAt', () => {
  const steps = [
    { date: '2024-01-01', quantity: 10 },
    { date: '2024-06-01', quantity: 25 },
  ];

  it('holds the last step forward in time', () => {
    expect(quantityAt(steps, '2024-03-15')).toBe(10);
    expect(quantityAt(steps, '2025-12-31')).toBe(25);
  });

  it('includes the step s own day', () => {
    expect(quantityAt(steps, '2024-06-01')).toBe(25);
  });

  it('is zero before the first trade', () => {
    expect(quantityAt(steps, '2023-12-31')).toBe(0);
  });
});

describe('buildChartSeries', () => {
  const window = [
    { date: '2024-01-01', close: 100 },
    { date: '2024-02-01', close: 110 },
    { date: '2024-03-01', close: 90 },
  ];
  const steps = [
    { date: '2024-01-01', quantity: 10 },
    { date: '2024-02-15', quantity: 20 },
  ];

  it('plots the quoted close in price mode', () => {
    expect(buildChartSeries(window, steps, 'price')).toEqual([
      { date: '2024-01-01', balance: 100 },
      { date: '2024-02-01', balance: 110 },
      { date: '2024-03-01', balance: 90 },
    ]);
  });

  it('multiplies price by the shares held that day in value mode', () => {
    expect(buildChartSeries(window, steps, 'value')).toEqual([
      { date: '2024-01-01', balance: 1000 },
      { date: '2024-02-01', balance: 1100 },
      // The 15 Feb top-up doubles the position before the March point.
      { date: '2024-03-01', balance: 1800 },
    ]);
  });

  it('walks the steps once and still reads every date as quantityAt does', () => {
    // Value mode advances a cursor through the steps instead of re-scanning them
    // per price point. The cases that separate a correct walk from a plausible
    // one: a price before any trade, several steps between two prices (the last
    // one wins), and a step landing exactly on a price date (it counts that day).
    const prices = [
      { date: '2024-01-01', close: 10 },
      { date: '2024-06-01', close: 10 },
      { date: '2024-06-15', close: 10 },
      { date: '2024-12-01', close: 10 },
    ];
    const manySteps = [
      { date: '2024-03-01', quantity: 5 },
      { date: '2024-04-01', quantity: 9 },
      { date: '2024-05-01', quantity: 12 },
      { date: '2024-06-15', quantity: 20 },
    ];

    expect(buildChartSeries(prices, manySteps, 'value')).toEqual([
      // Before the first trade: nothing held, so the position is worth nothing.
      { date: '2024-01-01', balance: 0 },
      // Three steps passed between January and June; only the newest holds.
      { date: '2024-06-01', balance: 120 },
      // A step dated the same day as the price counts on that day.
      { date: '2024-06-15', balance: 200 },
      { date: '2024-12-01', balance: 200 },
    ]);

    // Same answer the per-point lookup gives, which is the contract the walk
    // replaced.
    for (const point of prices) {
      const viaLookup = point.close * quantityAt(manySteps, point.date);
      const viaWalk = buildChartSeries([point], manySteps, 'value')[0].balance;
      expect(viaWalk).toBe(viaLookup);
    }
  });

  it('uses the adjusted series in return mode, matching the Performance card', () => {
    const withAdjusted = [
      { date: '2024-01-01', close: 100, totalReturnClose: 100 },
      { date: '2024-02-01', close: 100, totalReturnClose: 102 },
    ];
    expect(buildChartSeries(withAdjusted, [], 'return')).toEqual([
      { date: '2024-01-01', balance: 0 },
      { date: '2024-02-01', balance: 2 },
    ]);
  });

  it('keeps price and value modes on the quoted close', () => {
    // The adjusted series is not what the security traded at, so neither the
    // price line nor the position's value may use it.
    const withAdjusted = [{ date: '2024-01-01', close: 100, totalReturnClose: 90 }];
    expect(buildChartSeries(withAdjusted, [], 'price')).toEqual([
      { date: '2024-01-01', balance: 100 },
    ]);
    expect(
      buildChartSeries(withAdjusted, [{ date: '2024-01-01', quantity: 2 }], 'value'),
    ).toEqual([{ date: '2024-01-01', balance: 200 }]);
  });

  it('re-bases the window on its own first point in return mode', () => {
    expect(buildChartSeries(window, steps, 'return')).toEqual([
      { date: '2024-01-01', balance: 0 },
      { date: '2024-02-01', balance: 10 },
      { date: '2024-03-01', balance: -10 },
    ]);
  });

  it('gives up on return mode when the baseline is unusable', () => {
    expect(buildChartSeries([], steps, 'return')).toEqual([]);
    expect(
      buildChartSeries([{ date: '2024-01-01', close: 0 }], steps, 'return'),
    ).toEqual([]);
  });

  it('values an untraded window at zero rather than at the price', () => {
    const series = buildChartSeries(window, [], 'value');
    expect(series.every((point) => point.balance === 0)).toBe(true);
  });
});

describe('periodStartDate', () => {
  const now = new Date('2026-07-28T12:00:00Z');

  it('matches the app s existing preset conventions', () => {
    expect(periodStartDate('1m', now)).toBe('2026-06-28');
    expect(periodStartDate('3m', now)).toBe('2026-04-29');
    expect(periodStartDate('1y', now)).toBe('2025-07-28');
    expect(periodStartDate('5y', now)).toBe('2021-07-28');
  });

  it('starts the year-to-date period on 1 January', () => {
    expect(periodStartDate('ytd', now)).toBe('2026-01-01');
  });

  it('supports the three-year period the shared preset helper lacks', () => {
    expect(periodStartDate('3y', now)).toBe('2023-07-28');
  });
});

describe('computePeriodReturn', () => {
  it('measures the return on the adjusted series, dividends included', () => {
    // Price is flat, but the adjusted series rose 4%: a distributing fund whose
    // return is entirely its dividend. Measured on price it would read 0%.
    const series = [
      { date: '2024-01-01', close: 100, totalReturnClose: 100 },
      { date: '2026-01-01', close: 100, totalReturnClose: 104 },
    ];
    expect(computePeriodReturn(series, '2024-06-01')).toBe(4);
  });

  it('falls back to price when the provider gives no adjusted series', () => {
    const series = [
      { date: '2024-01-01', close: 100 },
      { date: '2026-01-01', close: 110 },
    ];
    expect(computePeriodReturn(series, '2024-06-01')).toBe(10);
  });

  const series = [
    { date: '2024-01-01', close: 100 },
    { date: '2025-01-01', close: 120 },
    { date: '2026-01-01', close: 150 },
  ];

  it('measures from the last price at or before the start date', () => {
    // From 120 (1 Jan 2025) to the latest 150.
    expect(computePeriodReturn(series, '2025-06-01')).toBe(25);
  });

  it('uses a price that falls exactly on the start date', () => {
    expect(computePeriodReturn(series, '2025-01-01')).toBe(25);
  });

  it('reports a loss with a negative sign', () => {
    const falling = [
      { date: '2024-01-01', close: 200 },
      { date: '2026-01-01', close: 150 },
    ];
    expect(computePeriodReturn(falling, '2024-06-01')).toBe(-25);
  });

  it('returns null when the history does not reach the period start', () => {
    // A security listed in 2024 has no 2019-based return to report.
    expect(computePeriodReturn(series, '2019-01-01')).toBeNull();
  });

  it('returns null for an empty history', () => {
    expect(computePeriodReturn([], '2024-01-01')).toBeNull();
  });

  it('returns null when the baseline is also the newest price', () => {
    const single = [{ date: '2026-01-01', close: 150 }];
    expect(computePeriodReturn(single, '2026-06-01')).toBeNull();
  });

  it('returns null rather than dividing by a zero baseline', () => {
    const zeroed = [
      { date: '2024-01-01', close: 0 },
      { date: '2026-01-01', close: 150 },
    ];
    expect(computePeriodReturn(zeroed, '2024-06-01')).toBeNull();
  });

  it('rounds to two decimals', () => {
    const thirds = [
      { date: '2024-01-01', close: 3 },
      { date: '2026-01-01', close: 4 },
    ];
    expect(computePeriodReturn(thirds, '2024-06-01')).toBe(33.33);
  });
});

describe('filterPriceWindow', () => {
  const series = [
    { date: '2024-01-01', close: 10 },
    { date: '2025-01-01', close: 20 },
    { date: '2026-01-01', close: 30 },
  ];

  it('keeps both boundary days', () => {
    expect(
      filterPriceWindow(series, '2024-01-01', '2025-01-01').map((p) => p.date),
    ).toEqual(['2024-01-01', '2025-01-01']);
  });

  it('treats an empty start as all of history', () => {
    expect(filterPriceWindow(series, '', '2026-01-01')).toHaveLength(3);
  });
});

describe('groupPricesByPeriod', () => {
  const history = [
    price('2026-07-28', 150),
    price('2026-07-01', 145),
    price('2026-06-30', 140),
    price('2025-12-31', 120),
    price('2025-01-02', 100),
  ];

  it('groups into years, newest first', () => {
    expect(groupPricesByPeriod(history).map((y) => y.key)).toEqual([
      '2026',
      '2025',
    ]);
  });

  it('groups each year into months, newest first', () => {
    const [twentySix] = groupPricesByPeriod(history);
    expect(twentySix.months.map((m) => m.key)).toEqual(['2026-07', '2026-06']);
  });

  it('counts a whole year, so a folded year can still state its size', () => {
    const [twentySix, twentyFive] = groupPricesByPeriod(history);
    expect(twentySix.count).toBe(3);
    expect(twentyFive.count).toBe(2);
  });

  it('keeps the API order inside a month', () => {
    const [twentySix] = groupPricesByPeriod(history);
    expect(twentySix.months[0].prices.map((p) => p.priceDate)).toEqual([
      '2026-07-28',
      '2026-07-01',
    ]);
  });

  it('keys each month the way formatMonth takes it', () => {
    const [twentySix] = groupPricesByPeriod(history);
    // `formatMonth` reads `yyyy-MM`; handing it a full date worked by accident
    // and made the month heading indistinguishable from a row's own date.
    expect(twentySix.months[0].key).toBe('2026-07');
  });

  it('handles an empty history', () => {
    expect(groupPricesByPeriod([])).toEqual([]);
  });

  it('tolerates a timestamp rather than a plain date', () => {
    const groups = groupPricesByPeriod([price('2026-07-28T00:00:00.000Z', 150)]);
    expect(groups[0].key).toBe('2026');
    expect(groups[0].months[0].key).toBe('2026-07');
  });
});

describe('allPriceGroupKeys', () => {
  it('lists every year and every month', () => {
    const groups = groupPricesByPeriod([
      price('2026-07-28', 150),
      price('2025-01-02', 100),
    ]);
    expect(allPriceGroupKeys(groups)).toEqual([
      '2026',
      '2026-07',
      '2025',
      '2025-01',
    ]);
  });
});

describe('defaultOpenPriceGroups', () => {
  it('opens the newest year and its newest month', () => {
    const groups = groupPricesByPeriod([
      price('2026-07-28', 150),
      price('2026-06-30', 140),
      price('2025-01-02', 100),
    ]);
    // Recent prices on screen without a click; everything older stays folded.
    expect(defaultOpenPriceGroups(groups)).toEqual(['2026', '2026-07']);
  });

  it('opens nothing when there is nothing', () => {
    expect(defaultOpenPriceGroups([])).toEqual([]);
  });
});

describe('computePositionReturn', () => {
  /** A held position that cost 10,000 and is now worth 13,000. */
  const base = {
    totalInvested: 10000,
    marketValue: 13000,
    costBasis: 10000,
    dividends: 200,
    realizedGain: null as number | null,
    realizedGainCurrency: null as string | null,
    realizedSaleCount: 0,
    securityCurrency: 'EUR',
    isPositionClosed: false,
  };

  it('adds realized gains and income to the unrealized gain', () => {
    expect(
      computePositionReturn({
        ...base,
        realizedGain: 500,
        realizedGainCurrency: 'EUR',
        realizedSaleCount: 1,
      }),
    ).toEqual({ profit: 3700, percent: 37 });
  });

  it('treats a security never sold as having realized nothing', () => {
    expect(computePositionReturn(base)).toEqual({ profit: 3200, percent: 32 });
  });

  it('counts a commission once: it is already in the basis', () => {
    // BUY 10 @ 100 with 10 commission: basis and invested are 1,010; at a price
    // of 100 the true return is -10, not -20.
    expect(
      computePositionReturn({
        ...base,
        totalInvested: 1010,
        costBasis: 1010,
        marketValue: 1000,
        dividends: 0,
      }),
    ).toEqual({ profit: -10, percent: -0.99 });
  });

  it('states nothing when the capital invested is unknown', () => {
    expect(computePositionReturn({ ...base, totalInvested: null })).toBeNull();
  });

  it('needs no market value once the position is closed', () => {
    // Nothing is held, so there is no unrealized component to be missing.
    expect(
      computePositionReturn({
        ...base,
        isPositionClosed: true,
        marketValue: null,
        costBasis: null,
        realizedGain: 900,
        realizedGainCurrency: 'EUR',
        realizedSaleCount: 1,
      }),
    ).toEqual({ profit: 1100, percent: 11 });
  });

  describe('refusals', () => {
    it('states nothing without capital to measure against', () => {
      expect(computePositionReturn({ ...base, totalInvested: 0 })).toBeNull();
    });

    it('states nothing when the held part cannot be priced', () => {
      // A partial total reads as a complete one, which is the whole reason this
      // returns null rather than leaving the unpriced part out at zero.
      expect(
        computePositionReturn({ ...base, marketValue: null }),
      ).toBeNull();
      expect(computePositionReturn({ ...base, costBasis: null })).toBeNull();
    });

    it('refuses to add a realized gain from another currency', () => {
      expect(
        computePositionReturn({
          ...base,
          realizedGain: 500,
          realizedGainCurrency: 'PLN',
          realizedSaleCount: 1,
        }),
      ).toBeNull();
    });

    it('refuses when sales spanned currencies and were not added up', () => {
      expect(
        computePositionReturn({
          ...base,
          realizedGain: null,
          realizedGainCurrency: null,
          realizedSaleCount: 2,
        }),
      ).toBeNull();
    });
  });

  it('reports a loss with its sign intact', () => {
    const loss = computePositionReturn({
      ...base,
      marketValue: 8000,
      dividends: 0,
    });
    expect(loss).toEqual({ profit: -2000, percent: -20 });
  });
});

describe('priceDecimals', () => {
  it('gives a whole column the widest count any value needs', () => {
    // The case that prompted this: a provider hands back 93.239998 and 93.18 in
    // one series, and per-value formatting put two decimals beside six.
    expect(priceDecimals([93.239998, 93.18])).toBe(6);
  });

  it('never drops below two, so a price still reads as money', () => {
    expect(priceDecimals([12, 15])).toBe(2);
    expect(priceDecimals([12.5])).toBe(2);
  });

  it('ignores gaps in the series', () => {
    expect(priceDecimals([null, 4.5, null])).toBe(2);
    expect(priceDecimals([])).toBe(2);
  });

  it('caps at what the price columns can store', () => {
    expect(priceDecimals([1.23456789012345])).toBe(MAX_PRICE_DECIMALS);
  });

  it('is not widened by binary float noise in one value', () => {
    // 0.1 + 0.2 is 0.30000000000000004, seventeen countable decimals. Counting
    // them took the whole column to the cap, so a table of two-decimal prices
    // rendered as 93.1800000000 because one value had been through arithmetic.
    // Storage is NUMERIC(24,10); past the tenth place there is no information to
    // preserve.
    expect(priceDecimals([0.1 + 0.2, 93.18])).toBe(2);
  });

  it('goes to the cap for a price written in exponent form', () => {
    // 1e-7 has digits that cannot be counted off its string form; assuming two
    // would round a sub-cent price to nothing.
    expect(priceDecimals([1e-7, 5])).toBe(MAX_PRICE_DECIMALS);
  });
});

describe('shiftWindow', () => {
  const year = { start: '2026-01-01', end: '2026-12-31' };

  it('leaves the latest window alone', () => {
    expect(shiftWindow(year, 0)).toEqual(year);
    expect(shiftWindow(year, -1)).toEqual(year);
  });

  it('moves back by one full window per step', () => {
    // The point of the feature: 1Y stays 1Y, and stepping back shows the year
    // before it at the same zoom rather than forcing a jump to 5Y.
    // Jan 1 to Dec 31 is 364 days, so each step moves both ends back by that
    // much: window 1 ends where window 0 begins, sharing the boundary day.
    expect(shiftWindow(year, 1)).toEqual({
      start: '2025-01-02',
      end: '2026-01-01',
    });
    expect(shiftWindow(year, 2)).toEqual({
      start: '2024-01-04',
      end: '2025-01-02',
    });
  });

  it('keeps the span the same length as it moves', () => {
    const shifted = shiftWindow(year, 3);
    const days = (a: string, b: string) =>
      (new Date(b).getTime() - new Date(a).getTime()) / 86_400_000;
    expect(days(shifted.start, shifted.end)).toBe(days(year.start, year.end));
  });

  it('has nothing to shift without both ends', () => {
    // The "all" preset has no start, and there is no window to move.
    expect(shiftWindow({ start: '', end: '2026-12-31' }, 2)).toEqual({
      start: '',
      end: '2026-12-31',
    });
  });
});

describe('maxSpansBack', () => {
  const year = { start: '2026-01-01', end: '2026-12-31' };

  it('counts the steps the history can still fill', () => {
    expect(maxSpansBack(year, '2024-01-01')).toBe(3);
  });

  it('is zero when the window already reaches the oldest price', () => {
    // The control that steps back must be able to stop, or it scrolls off into
    // empty charts.
    expect(maxSpansBack(year, '2026-01-01')).toBe(0);
    expect(maxSpansBack(year, '2026-06-01')).toBe(0);
  });

  it('allows one step for a partial window of older data', () => {
    // Half a year earlier is still worth a step; it just shows a half-full one.
    expect(maxSpansBack(year, '2025-07-01')).toBe(1);
  });

  it('is zero without a bounded window or a known oldest date', () => {
    expect(maxSpansBack({ start: '', end: '' }, '2020-01-01')).toBe(0);
    expect(maxSpansBack(year, '')).toBe(0);
  });
});

describe('documentHost', () => {
  it('reduces a long document link to its host', () => {
    // The address column is a column of hosts; the full URL is on the link.
    expect(
      documentHost('https://www.ishares.com/de/literature/factsheet/x.pdf'),
    ).toBe('ishares.com');
  });

  it('drops the www prefix, which is noise in a column of hosts', () => {
    expect(documentHost('https://www.vanguard.co.uk/a.pdf')).toBe(
      'vanguard.co.uk',
    );
    expect(documentHost('https://vanguard.co.uk/a.pdf')).toBe('vanguard.co.uk');
  });

  it('keeps a subdomain that is not www', () => {
    expect(documentHost('https://docs.example.com/a.pdf')).toBe(
      'docs.example.com',
    );
  });

  it('shows an unparseable address as it was typed', () => {
    // The reader is the one who can tell what is wrong with it; hiding it would
    // leave a blank cell and no way to find out.
    expect(documentHost('not a url')).toBe('not a url');
  });
});
