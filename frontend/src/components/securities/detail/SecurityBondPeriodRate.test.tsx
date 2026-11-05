import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { render } from '@/test/render';
import { SecurityBondPeriodRate } from './SecurityBondPeriodRate';
import { SecurityBondLotsTable } from './SecurityBondLotsTable';
import { SecurityBondRateSection } from './SecurityBondRateSection';
import { valuationRefusalText } from './bond-labels';
import type {
  BondLotValuation,
  BondRateRule,
  BondRateScheduleEntry,
  BondValuation,
} from '@/types/bond';

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      // Percent units in, as the real formatter takes them.
      formatPercentTrimmed: (value: number) => `${Number(value.toFixed(6))}%`,
    }),
  };
});
vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (date: string) => `d(${date})` }),
}));

const FRN_RULE: BondRateRule = {
  type: 'DAILY_INDEX_PLUS_SPREAD',
  benchmarkId: 'US_TBILL_13W_MMY',
  annualRate: null,
  firstPeriodRate: null,
  addend: '0.00103',
  benchmarkFloor: '0',
  lockoutBusinessDays: 2,
};
const BILL_RULE: BondRateRule = {
  type: 'ZERO_COUPON_DISCOUNT',
  benchmarkId: null,
  annualRate: null,
  firstPeriodRate: null,
  addend: null,
  benchmarkFloor: null,
};
const FIXED_RULE: BondRateRule = { ...BILL_RULE, type: 'FIXED', annualRate: '0.0440' };

const entry = (over: Partial<BondRateScheduleEntry> = {}): BondRateScheduleEntry => ({
  index: 1,
  start: '2026-04-30',
  end: '2026-07-31',
  annualRate: null,
  rateSource: null,
  benchmark: null,
  addend: null,
  interest: null,
  fixedPart: null,
  benchmarkPart: null,
  addendPart: null,
  announcedPart: null,
  ...over,
});

function valuation(
  rateRule: BondRateRule,
  rateSchedule: BondRateScheduleEntry[],
  over: Partial<BondValuation> = {},
): BondValuation {
  return {
    asOf: '2026-05-10',
    status: 'OPEN',
    refusal: null,
    seriesCode: 'X',
    termsVersion: 1,
    quantity: 100,
    maturityDate: '2028-04-30',
    currentPeriod: {
      index: 1,
      start: '2026-04-30',
      end: '2026-07-31',
      annualRate: null,
      rateSource: rateSchedule[0]?.rateSource ?? null,
    },
    rateRule,
    rateSchedule,
    principal: '100.000000',
    accruedInterest: '12.34',
    grossValue: '10012.34',
    earlyRedemptionValue: null,
    earlyRedemptionRefusal: 'NOT_REDEEMABLE',
    knownCashflows: [],
    projectedCashflows: [],
    nextPayment: [],
    nextRateReset: null,
    nextCapitalization: null,
    maturityValueKnown: null,
    maturityValueProjected: null,
    projectionAssumptions: [],
    dataCompleteness: {
      termsComplete: true,
      referenceDataComplete: true,
      earlyRedemptionTermsComplete: true,
    },
    missing: [],
    projectionMissing: [],
    valuationComplete: true,
    ...over,
  } as BondValuation;
}

const RUNS = [
  { from: '2026-04-30', to: '2026-05-05', index: '0.0360', rate: '0.03703', dailyAccrual: '0.0102861', projected: false },
  { from: '2026-05-05', to: '2026-05-12', index: '0.0362', rate: '0.03723', dailyAccrual: '0.0103417', projected: true },
];

describe('SecurityBondPeriodRate', () => {
  it('shows the daily rates of a floating period in runs, never "Unknown"', () => {
    const v = valuation(FRN_RULE, [entry({ rateSource: 'DERIVED', dailyRates: RUNS })]);
    render(<SecurityBondPeriodRate valuation={v} period={v.rateSchedule[0]} detail withSource={false} />);
    expect(screen.queryByText('Unknown')).toBeNull();
    // Rates are fractions: 0.03703 is 3.703 percent.
    expect(screen.getByText('From d(2026-04-30): 3.703%')).toBeInTheDocument();
    expect(screen.getByText('From d(2026-05-05): 3.723%')).toBeInTheDocument();
    expect(screen.getByText('Projected')).toBeInTheDocument();
  });

  it('says "Daily" with the benchmark in a compact cell, with the source badge', () => {
    const v = valuation(FRN_RULE, [entry({ rateSource: 'DERIVED', dailyRates: RUNS })]);
    render(<SecurityBondPeriodRate valuation={v} period={v.currentPeriod!} />);
    expect(screen.queryByText('Unknown')).toBeNull();
    expect(screen.getByText(/^Daily, /)).toBeInTheDocument();
    expect(screen.getByText('Derived')).toBeInTheDocument();
  });

  it('says a floating period with no index stored yet has none, rather than "Unknown"', () => {
    const v = valuation(FRN_RULE, [entry({ dailyRates: [] })]);
    render(<SecurityBondPeriodRate valuation={v} period={v.currentPeriod!} />);
    expect(screen.getByText(/no index stored yet/)).toBeInTheDocument();
    expect(screen.queryByText('Unknown')).toBeNull();
  });

  it('says a bill earns the discount to its face value', () => {
    const v = valuation(BILL_RULE, [entry()]);
    render(<SecurityBondPeriodRate valuation={v} period={v.currentPeriod!} />);
    expect(screen.getByText('Discount to face value')).toBeInTheDocument();
    expect(screen.queryByText('Unknown')).toBeNull();
  });

  it('shows a stated rate as a percentage with its source', () => {
    const v = valuation(FIXED_RULE, [entry({ annualRate: '0.0440', rateSource: 'TERMS' })]);
    render(
      <SecurityBondPeriodRate
        valuation={v}
        period={{ index: 1, annualRate: '0.0440', rateSource: 'TERMS' }}
      />,
    );
    expect(screen.getByText('4.4%')).toBeInTheDocument();
    expect(screen.getByText('Terms')).toBeInTheDocument();
  });

  it('keeps "Unknown" for a rate that is really not known', () => {
    const rule: BondRateRule = { ...FIXED_RULE, type: 'BENCHMARK_PLUS_SPREAD', annualRate: null };
    const v = valuation(rule, [entry()]);
    render(<SecurityBondPeriodRate valuation={v} period={v.currentPeriod!} />);
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });
});

describe('SecurityBondLotsTable rate and principal', () => {
  const lot = (v: BondValuation): BondLotValuation => ({
    instrumentId: 'id-1',
    purchaseDate: '2026-04-30',
    quantity: 100,
    purchaseDateAssumed: false,
    valuation: v,
  }) as BondLotValuation;

  it('shows the daily rate of a floating lot and the discount of a bill, not "Unknown" in the rate column', () => {
    const frn = valuation(FRN_RULE, [entry({ rateSource: 'DERIVED', dailyRates: RUNS })]);
    const bill = valuation(BILL_RULE, [entry()]);
    render(<SecurityBondLotsTable lots={[lot(frn), lot(bill)]} currency="USD" />);
    // The rate is the fifth column, after the date, quantity, maturity and period.
    const rateCell = (row: HTMLElement) => within(row).getAllByRole('cell')[4];
    const rows = screen.getAllByRole('row').slice(1);
    expect(within(rateCell(rows[0])).getByText(/^Daily, /)).toBeInTheDocument();
    expect(within(rateCell(rows[1])).getByText('Discount to face value')).toBeInTheDocument();
    expect(within(rateCell(rows[0])).queryByText('Unknown')).toBeNull();
    expect(within(rateCell(rows[1])).queryByText('Unknown')).toBeNull();
  });

  it('says a lot priced at the auction price has no cost entered', () => {
    const issue = valuation(BILL_RULE, [entry()], { principalBasis: 'ISSUE_PRICE' });
    const cost = valuation(BILL_RULE, [entry()], { principalBasis: 'LOT_COST' });
    const { unmount } = render(<SecurityBondLotsTable lots={[lot(issue)]} currency="USD" />);
    expect(screen.getByText('No cost entered: the auction price is used')).toBeInTheDocument();
    unmount();
    render(<SecurityBondLotsTable lots={[lot(cost)]} currency="USD" />);
    expect(screen.queryByText('No cost entered: the auction price is used')).toBeNull();
  });
});

describe('SecurityBondRateSection rate column', () => {
  const lotOf = (v: BondValuation) =>
    ({
      instrumentId: 'id-1',
      purchaseDate: '2026-04-30',
      quantity: 100,
      purchaseDateAssumed: false,
      valuation: v,
    }) as BondLotValuation;

  it('lists the daily rates of a floating period and the discount of a bill', () => {
    const frn = valuation(FRN_RULE, [entry({ rateSource: 'DERIVED', dailyRates: RUNS })]);
    const { unmount } = render(
      <SecurityBondRateSection lots={[lotOf(frn)]} currency="USD" redemptionTerms={null} />,
    );
    expect(screen.getByText('From d(2026-04-30): 3.703%')).toBeInTheDocument();
    // The floor sentence is about the day's rate, not the index.
    expect(
      screen.getByText('The daily rate (index plus spread) is never below 0%'),
    ).toBeInTheDocument();
    unmount();
    render(
      <SecurityBondRateSection
        lots={[lotOf(valuation(BILL_RULE, [entry()]))]}
        currency="USD"
        redemptionTerms={null}
      />,
    );
    const rateCell = within(screen.getAllByRole('row')[1]).getAllByRole('cell')[2];
    expect(within(rateCell).getByText('Discount to face value')).toBeInTheDocument();
  });
});

describe('valuationRefusalText', () => {
  const t = Object.assign(
    ((key: string, values?: Record<string, string | number>) =>
      `${key}${values ? JSON.stringify(values) : ''}`) as never,
    { has: () => false },
  ) as Parameters<typeof valuationRefusalText>[0];
  const fmt = (date: string) => `d(${date})`;

  it('names each refusal code with its own message', () => {
    expect(
      valuationRefusalText(
        t,
        { code: 'PURCHASE_AFTER_MATURITY', params: { maturityDate: 'M', purchaseDate: 'P' } },
        fmt,
      ),
    ).toBe('bond.valuationRefusal.PURCHASE_AFTER_MATURITY{"maturityDate":"d(M)","purchaseDate":"d(P)"}');
    expect(
      valuationRefusalText(
        t,
        { code: 'PURCHASE_OUTSIDE_SALE_WINDOW', params: { from: 'F', to: 'T', purchaseDate: 'P' } },
        fmt,
      ),
    ).toBe(
      'bond.valuationRefusal.PURCHASE_OUTSIDE_SALE_WINDOW{"from":"d(F)","to":"d(T)","purchaseDate":"d(P)"}',
    );
  });

  it('says nothing for a code it does not know, never another code\'s message', () => {
    expect(
      valuationRefusalText(t, { code: 'NOT_A_CODE', params: {} } as never, fmt),
    ).toBeNull();
  });
});
