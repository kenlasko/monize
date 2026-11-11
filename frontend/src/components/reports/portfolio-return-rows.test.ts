import { describe, it, expect } from 'vitest';
import {
  PORTFOLIO_RETURN_KEY,
  buildAccountReturnView,
  buildPortfolioReturnView,
} from './portfolio-return-rows';
import type {
  AccountTwrSeries,
  PortfolioTwrSeries,
  PortfolioTwrSeriesByAccount,
} from '@/types/net-worth';

const RANGES = {
  prices: [],
  rates: [],
  cash: [],
} as unknown as PortfolioTwrSeries['incompleteRanges'];

const portfolio = (overrides: Partial<PortfolioTwrSeries> = {}): PortfolioTwrSeries => ({
  currency: 'CAD',
  startDate: '2026-09-15',
  endDate: '2026-09-17',
  points: [
    { date: '2026-09-15', returnPercent: 0 },
    { date: '2026-09-16', returnPercent: 0 },
    { date: '2026-09-17', returnPercent: 10 },
  ],
  complete: true,
  reasons: [],
  incompleteRanges: RANGES,
  ...overrides,
});

const account = (accountId: string, overrides: Partial<AccountTwrSeries> = {}): AccountTwrSeries => ({
  accountId,
  points: [
    { date: '2026-09-15', returnPercent: 0 },
    { date: '2026-09-16', returnPercent: 2 },
  ],
  complete: true,
  reasons: [],
  incompleteRanges: RANGES,
  ...overrides,
});

const byAccount = (accounts: AccountTwrSeries[]): PortfolioTwrSeriesByAccount => ({
  currency: 'CAD',
  startDate: '2026-09-15',
  endDate: '2026-09-16',
  accounts,
});

describe('buildPortfolioReturnView', () => {
  it('draws one heavy line with a row per day, the origin first', () => {
    const view = buildPortfolioReturnView(portfolio(), 'Portfolio');
    expect(view.lines).toHaveLength(1);
    expect(view.lines[0]).toMatchObject({ key: PORTFOLIO_RETURN_KEY, label: 'Portfolio', heavy: true });
    expect(view.rows.map((r) => r[PORTFOLIO_RETURN_KEY])).toEqual([0, 0, 10]);
    expect(view.rows[0].ts).toBeLessThan(view.rows[2].ts);
    expect(view.withheld).toEqual([]);
  });

  it('a withheld series is named with its cause and draws no line, never a flat zero', () => {
    const view = buildPortfolioReturnView(
      portfolio({ points: [], complete: false, reasons: ['incompletePrices'] }),
      'Portfolio',
    );
    expect(view.lines).toEqual([]);
    expect(view.rows).toEqual([]);
    expect(view.withheld).toEqual([
      { key: PORTFOLIO_RETURN_KEY, label: 'Portfolio', cause: 'noPrice' },
    ]);
  });

  it.each([
    [['missingRatePairs'], 'displayFx'],
    [['incompletePrices', 'missingRatePairs'], 'noPrice'],
    [['zeroStart'], 'noBaseline'],
    // The account result's cause: this measure reads no cash.
    [['incompleteCash'], 'noBaseline'],
  ] as const)('ranks the cause of %j as %s', (reasons, cause) => {
    const view = buildPortfolioReturnView(
      portfolio({ points: [], complete: false, reasons: [...reasons] }),
      'P',
    );
    expect(view.withheld[0].cause).toBe(cause);
  });
});

describe('buildPortfolioReturnView with no history', () => {
  it('names nothing, so the chart shows its no-history empty state', () => {
    const view = buildPortfolioReturnView(
      portfolio({ points: [], complete: false, reasons: ['noValueSeries'] }),
      'Portfolio',
    );
    expect(view).toEqual({ rows: [], lines: [], withheld: [] });
  });
});

describe('buildAccountReturnView', () => {
  const names: Record<string, string> = { a1: 'Brokerage A', a2: 'Brokerage B', a3: 'Brokerage C' };
  const nameOf = (id: string) => names[id] ?? id;

  it('one light line per account, coloured by position, in the order asked', () => {
    const view = buildAccountReturnView(byAccount([account('a1'), account('a2')]), nameOf);
    expect(view.lines.map((l) => [l.key, l.label, l.heavy])).toEqual([
      ['a1', 'Brokerage A', false],
      ['a2', 'Brokerage B', false],
    ]);
    expect(view.lines[0].color).not.toBe(view.lines[1].color);
    expect(view.rows.map((r) => [r.a1, r.a2])).toEqual([
      [0, 0],
      [2, 2],
    ]);
  });

  it('names a withheld account instead of dropping it, and keeps the others\' colours', () => {
    const view = buildAccountReturnView(
      byAccount([
        account('a1'),
        account('a2', { points: [], complete: false, reasons: ['missingRatePairs'] }),
        account('a3'),
      ]),
      nameOf,
    );
    expect(view.withheld).toEqual([{ key: 'a2', label: 'Brokerage B', cause: 'displayFx' }]);
    expect(view.lines.map((l) => l.key)).toEqual(['a1', 'a3']);
    // a3 keeps the colour of its position in the request, so withholding an
    // earlier account does not repaint it.
    const all = buildAccountReturnView(byAccount([account('a1'), account('a2'), account('a3')]), nameOf);
    expect(view.lines[1].color).toBe(all.lines[2].color);
  });

  it('leaves a date an account has no point for as a break', () => {
    const view = buildAccountReturnView(
      byAccount([
        account('a1'),
        account('a2', { points: [{ date: '2026-09-16', returnPercent: 5 }] }),
      ]),
      nameOf,
    );
    expect(view.rows[0].a2).toBeNull();
    expect(view.rows[1].a2).toBe(5);
  });

  it('names an account with no history as such, not as one with nothing invested', () => {
    const view = buildAccountReturnView(
      byAccount([account('a1'), account('a2', { points: [], complete: false, reasons: ['noValueSeries'] })]),
      nameOf,
    );
    expect(view.withheld).toEqual([{ key: 'a2', label: 'Brokerage B', cause: 'noHistory' }]);
  });

  it('draws nothing when every account is withheld', () => {
    const view = buildAccountReturnView(
      byAccount([account('a1', { points: [], complete: false, reasons: ['incompletePrices'] })]),
      nameOf,
    );
    expect(view.lines).toEqual([]);
    expect(view.rows).toEqual([]);
    expect(view.withheld).toHaveLength(1);
  });
});
