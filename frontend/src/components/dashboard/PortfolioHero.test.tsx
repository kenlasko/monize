import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from '@testing-library/react';
import { render, screen, within } from '@/test/render';
import type { PortfolioSummary } from '@/types/investment';
import type { Account } from '@/types/account';
import type { PortfolioPeriodResult } from '@/types/net-worth';
import { PortfolioHero } from './PortfolioHero';
import { DASHBOARD_HERO_DEFAULT, type DashboardHeroConfig } from './widget-config';

const getPortfolioSummary = vi.fn();
const getPortfolioValuation = vi.fn();
const never = () => new Promise(() => {});
vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getPortfolioSummary: (...a: unknown[]) => getPortfolioSummary(...a),
    getPortfolioValuation: (...a: unknown[]) => getPortfolioValuation(...a),
  },
}));

const loadSeries = vi.fn();
vi.mock('@/components/investments/portfolio-value-series', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/investments/portfolio-value-series')>()),
  loadPortfolioValueSeries: (...a: unknown[]) => loadSeries(...a),
}));

const period: { current: { periodResult: Partial<PortfolioPeriodResult> | null; failed: boolean } } = {
  current: { periodResult: null, failed: false },
};
const periodArgs = vi.fn();
vi.mock('@/hooks/usePortfolioPeriodResult', () => ({
  usePortfolioPeriodResult: (opts: unknown) => {
    periodArgs(opts);
    return period.current;
  },
}));

const chartState: { data: Array<{ key: string; value: number | null }> } = { data: [] };
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  AreaChart: ({ children, data }: any) => {
    chartState.data = data;
    return <div data-testid="area-chart">{children}</div>;
  },
  Area: ({ dot }: any) => (
    <svg data-testid="area">
      {chartState.data.map((_, index) => (
        <g key={index}>{dot({ cx: 20 + index * 40, cy: 50, index })}</g>
      ))}
    </svg>
  ),
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
}));

const account = (id: string, name: string, accountSubType: string | null): Account =>
  ({ id, name, accountType: 'INVESTMENT', accountSubType }) as unknown as Account;

const ACCOUNTS: Account[] = [
  account('tfsa', 'TFSA - Brokerage', 'INVESTMENT_BROKERAGE'),
  account('tfsa-cash', 'TFSA - Cash', 'INVESTMENT_CASH'),
  account('rrsp', 'RRSP - Brokerage', 'INVESTMENT_BROKERAGE'),
  account('cash-cash', 'RRSP - Cash', 'INVESTMENT_CASH'),
  account('lira', 'LIRA', null),
];

const summary = (overrides: Partial<PortfolioSummary> = {}): PortfolioSummary =>
  ({
    totalPortfolioValue: 154523.85,
    totalHoldingsValue: 150000.4,
    totalCashValue: 4523.45,
    totalGainLossPercent: 12.345,
    timeWeightedReturn: 8.4,
    moneyWeightedReturn: 7.1,
    cagr: 6.2,
    holdings: [],
    holdingsByAccount: [],
    valuationComplete: true,
    pricesComplete: true,
    fxComplete: true,
    missingRatePairs: [],
    ...overrides,
  }) as unknown as PortfolioSummary;

const config = (overrides: Partial<DashboardHeroConfig> = {}): DashboardHeroConfig => ({
  ...DASHBOARD_HERO_DEFAULT,
  set: 'portfolio',
  ...overrides,
});

async function renderHero(cfg: DashboardHeroConfig = config(), props: { hasInvestments?: boolean } = {}) {
  await act(async () => {
    render(
      <PortfolioHero
        config={cfg}
        header={<h1>Good evening, Ken</h1>}
        investmentAccounts={ACCOUNTS}
        hasInvestments={props.hasInvestments ?? true}
        isLoading={false}
      />,
    );
  });
}

const metric = () => screen.getByTestId('dashboard-hero-metric');

describe('PortfolioHero', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPortfolioSummary.mockResolvedValue(summary());
    getPortfolioValuation.mockResolvedValue(summary());
    loadSeries.mockResolvedValue({
      points: [
        { at: '2026-09-30', value: 140000, intraday: false },
        { at: '2026-10-31', value: 150000.4, intraday: false },
      ],
      intradayUnavailable: false,
    });
    period.current = {
      periodResult: { valueChange: 12345.67, reasons: [], investedReasons: [] },
      failed: false,
    };
  });

  it('heads with the total value, the change over the window, and the holdings and cash under it', async () => {
    await renderHero();
    expect(screen.getByTestId('dashboard-hero-headline')).toHaveTextContent(/154,523\.85/);
    const pill = screen.getByTestId('dashboard-hero-pill');
    expect(pill).toHaveTextContent(/Up/);
    expect(pill).toHaveTextContent(/12,345\.67/);
    expect(pill).toHaveTextContent(/1Y/);
    expect(screen.getByText(/holdings/)).toHaveTextContent(/150,000\.40/);
    expect(screen.getByText(/cash/)).toHaveTextContent(/4,523\.45/);
    expect(screen.getByRole('heading', { name: 'Good evening, Ken' })).toBeInTheDocument();
  });

  it('names all accounts in brackets when none is chosen', async () => {
    await renderHero();
    expect(screen.getByText(/Portfolio value/)).toHaveTextContent('Portfolio value (All Accounts)');
    expect(getPortfolioValuation).toHaveBeenCalledWith([]);
    expect(loadSeries).toHaveBeenCalledWith(expect.objectContaining({ range: '1y', accountIds: undefined }));
  });

  it('names the chosen accounts as the Investments page does, a brokerage by its main name', async () => {
    await renderHero(config({ portfolioAccountIds: ['tfsa'] }));
    expect(screen.getByText(/Portfolio value/)).toHaveTextContent('Portfolio value (TFSA)');
    expect(getPortfolioValuation).toHaveBeenCalledWith(['tfsa']);
    expect(loadSeries).toHaveBeenCalledWith(expect.objectContaining({ accountIds: 'tfsa' }));
    expect(periodArgs).toHaveBeenCalledWith(expect.objectContaining({ accountIds: 'tfsa', range: '1y' }));
  });

  it('names the ones left out when most are chosen', async () => {
    await renderHero(config({ portfolioAccountIds: ['tfsa', 'rrsp'] }));
    expect(screen.getByText(/Portfolio value/)).toHaveTextContent('Portfolio value (All but LIRA)');
  });

  it('shows the chosen return beside the holdings and cash', async () => {
    await renderHero(config({ portfolioMetric: 'twr' }));
    expect(metric()).toHaveTextContent(/\+8\.40\s?%/);
    expect(metric()).toHaveTextContent(/TWR/);
  });

  it.each([
    ['simpleReturn', /\+12\.35\s?%.*simple return/],
    ['mwr', /\+7\.10\s?%.*MWR/],
    ['cagr', /\+6\.20\s?%.*CAGR/],
  ] as const)('shows %s as the summary card does', async (portfolioMetric, pattern) => {
    await renderHero(config({ portfolioMetric }));
    expect(metric()).toHaveTextContent(pattern);
  });

  it('names a withheld return rather than showing a zero', async () => {
    getPortfolioSummary.mockResolvedValue(summary({ cagr: null, timeWeightedReturn: null }));
    await renderHero(config({ portfolioMetric: 'cagr' }));
    expect(within(metric()).getByTestId('unknown-amount')).toBeInTheDocument();
  });

  it('does not ask for the since-inception walk to show a simple return', async () => {
    await renderHero(config({ portfolioMetric: 'simpleReturn' }));
    expect(metric()).toHaveTextContent(/\+12\.35\s?%/);
    expect(getPortfolioSummary).not.toHaveBeenCalled();
  });

  it('draws the figures while a since-inception return is on its way, holding only its place', async () => {
    getPortfolioSummary.mockImplementation(never);
    await renderHero(config({ portfolioMetric: 'twr' }));
    expect(screen.getByTestId('dashboard-hero-headline')).toHaveTextContent(/154,523\.85/);
    expect(within(metric()).getByTestId('dashboard-hero-figure-skeleton')).toBeInTheDocument();
  });

  it('says a since-inception return failed to load rather than leaving its place empty', async () => {
    getPortfolioSummary.mockRejectedValue(new Error('boom'));
    await renderHero(config({ portfolioMetric: 'mwr' }));
    expect(within(metric()).getByTestId('unknown-amount')).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-hero-headline')).toHaveTextContent(/154,523\.85/);
  });

  it('draws the figures while the chart series is on its way, holding only the chart', async () => {
    loadSeries.mockImplementation(never);
    period.current = { periodResult: null, failed: false };
    await renderHero();
    expect(screen.getByTestId('dashboard-hero-headline')).toHaveTextContent(/154,523\.85/);
    expect(screen.getByTestId('dashboard-hero-chart-skeleton')).toBeInTheDocument();
  });

  it('keeps the figures and says so in the chart when only the series failed', async () => {
    loadSeries.mockRejectedValue(new Error('boom'));
    period.current = { periodResult: null, failed: false };
    await renderHero();
    expect(screen.getByTestId('dashboard-hero-headline')).toHaveTextContent(/154,523\.85/);
    expect(screen.getByTestId('dashboard-hero-chart')).toHaveTextContent(/Couldn't load your portfolio/);
  });

  it('marks the value as partial while a holding has no price', async () => {
    getPortfolioValuation.mockResolvedValue(
      summary({ valuationComplete: false, pricesComplete: false, unpricedSecurityIds: ['s1'] }),
    );
    await renderHero();
    expect(within(screen.getByTestId('dashboard-hero-headline')).getByTestId('partial-total-marker')).toBeInTheDocument();
  });

  it('says a failed change request failed, and holds nothing for one still in flight', async () => {
    period.current = { periodResult: null, failed: true };
    await renderHero();
    expect(screen.getByTestId('dashboard-hero-pill')).toHaveTextContent(/Couldn't load the change/);
  });

  it('holds the pill\'s place while the change has not answered', async () => {
    period.current = { periodResult: null, failed: false };
    await renderHero();
    expect(screen.queryByTestId('dashboard-hero-pill')).not.toBeInTheDocument();
    expect(screen.getByTestId('dashboard-hero-figure-skeleton')).toBeInTheDocument();
  });

  it('says a one-day chart cannot be drawn when a holding has no intraday prices', async () => {
    loadSeries.mockResolvedValue({ points: [], intradayUnavailable: true });
    await renderHero(config({ portfolioRange: '1d' }));
    expect(screen.getByTestId('dashboard-hero-chart')).toHaveTextContent(/no intraday prices/);
  });

  it('flags the highest and lowest points, unrounded', async () => {
    await renderHero();
    expect(chartState.data.map((p) => p.value)).toEqual([140000, 150000.4]);
    expect(within(screen.getByTestId('area')).getAllByRole('button', { name: 'Hide this value' })).toHaveLength(2);
  });

  it('says there is nothing to show without investment accounts, and asks for nothing', async () => {
    await renderHero(config(), { hasInvestments: false });
    expect(screen.getByText(/No investment accounts yet/)).toBeInTheDocument();
    expect(getPortfolioSummary).not.toHaveBeenCalled();
    expect(getPortfolioValuation).not.toHaveBeenCalled();
    expect(loadSeries).not.toHaveBeenCalled();
    expect(periodArgs).toHaveBeenCalledWith(expect.objectContaining({ skip: true }));
  });

  it('says so when the portfolio could not be loaded', async () => {
    getPortfolioValuation.mockRejectedValue(new Error('boom'));
    await renderHero();
    expect(screen.getByText(/Couldn't load your portfolio/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Good evening, Ken' })).toBeInTheDocument();
  });
});
