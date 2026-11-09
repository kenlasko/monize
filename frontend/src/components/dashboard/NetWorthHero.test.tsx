import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from '@testing-library/react';
import { render, screen, fireEvent, within } from '@/test/render';
import type { MonthlyNetWorth } from '@/types/net-worth';
import type { PortfolioSummary } from '@/types/investment';
import { NetWorthHero } from './NetWorthHero';
import { DASHBOARD_HERO_DEFAULT, type DashboardHeroConfig } from './widget-config';

const configState: { current: DashboardHeroConfig } = { current: DASHBOARD_HERO_DEFAULT };

const getMonthly = vi.fn();
vi.mock('@/lib/net-worth', () => ({
  netWorthApi: { getMonthly: (...a: unknown[]) => getMonthly(...a) },
}));

// The chart's data and dot renderer, captured so a test can draw the flagged
// points the way Recharts would.
const chartState: {
  data: Array<{ key: string; value: number | null }>;
  margin?: { top: number };
} = { data: [] };
const viewport = { belowDesktop: false };
vi.mock('@/hooks/useIsMobile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useIsMobile')>()),
  useIsBelowDesktop: () => viewport.belowDesktop,
}));
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  AreaChart: ({ children, data, margin }: any) => {
    chartState.data = data;
    chartState.margin = margin;
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

const month = (m: string, netWorth: number, extra: Partial<MonthlyNetWorth> = {}): MonthlyNetWorth => ({
  month: m,
  assets: netWorth + 400,
  liabilities: 400,
  netWorth,
  ...extra,
});

const SERIES: MonthlyNetWorth[] = [
  month('2026-08', 900),
  month('2026-09', 700),
  month('2026-10', 1000),
  month('2026-11', 1100),
];

const portfolio = (overrides: Partial<PortfolioSummary> = {}): PortfolioSummary =>
  ({
    totalHoldingsValue: 5000,
    totalCashValue: 250,
    holdings: [{ securityId: 'sec-1', symbol: 'VFV' }],
    holdingsByAccount: [],
    valuationComplete: true,
    pricesComplete: true,
    fxComplete: true,
    ...overrides,
  }) as unknown as PortfolioSummary;

async function renderHero(props: Partial<Parameters<typeof NetWorthHero>[0]> = {}) {
  await act(async () => {
    render(
      <NetWorthHero
        config={configState.current}
        portfolioSummary={portfolio()}
        hasInvestments
        isLoading={false}
        investmentSummaryLoading={false}
        header={<h1>Good evening, Ken</h1>}
        {...props}
      />,
    );
  });
}

describe('NetWorthHero', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configState.current = DASHBOARD_HERO_DEFAULT;
    viewport.belowDesktop = false;
    getMonthly.mockResolvedValue(SERIES);
  });

  it('heads with the newest month\'s net worth and its change since last month', async () => {
    await renderHero();
    expect(screen.getByTestId('dashboard-hero-headline')).toHaveTextContent(/1,100/);
    const change = screen.getByTestId('dashboard-hero-pill');
    expect(change).toHaveTextContent(/Up/);
    expect(change).toHaveTextContent(/100/);
    expect(change).toHaveTextContent(/10(\.0)?\s?%/);
    expect(change).toHaveTextContent(/this month/);
  });

  it('says a fall in words, not only with the arrow', async () => {
    getMonthly.mockResolvedValue([month('2026-10', 1000), month('2026-11', 800)]);
    await renderHero();
    expect(screen.getByTestId('dashboard-hero-pill')).toHaveTextContent(/Down/);
  });

  it('shows assets, liabilities and the invested securities without their cash', async () => {
    await renderHero();
    const hero = screen.getByTestId('dashboard-hero');
    expect(within(hero).getByText(/assets/)).toHaveTextContent(/1,500/);
    expect(within(hero).getByText(/liabilities/)).toHaveTextContent(/400/);
    // 5,000 of securities; the 250 of cash beside them is not invested.
    expect(within(hero).getByText(/invested/)).toHaveTextContent(/5,000/);
  });

  it('leaves out the invested figure when there are no investments', async () => {
    await renderHero({ hasInvestments: false, portfolioSummary: null });
    expect(screen.queryByText(/invested/)).not.toBeInTheDocument();
  });

  it('draws the greeting header inside the hero, beside the chart', async () => {
    await renderHero();
    const hero = screen.getByTestId('dashboard-hero');
    expect(within(hero).getByRole('heading', { name: 'Good evening, Ken' })).toBeInTheDocument();
    expect(within(hero).getByTestId('dashboard-hero-chart')).toBeInTheDocument();
    // The window is chosen in Customize Dashboard, not over the chart.
    expect(within(hero).queryByRole('group')).not.toBeInTheDocument();
  });

  it('trims the space reserved over the chart only where it stacks under the figures', async () => {
    await renderHero();
    expect(chartState.margin?.top).toBe(36);
  });

  it('keeps room for the flag bubble when the chart is stacked under the figures', async () => {
    viewport.belowDesktop = true;
    await renderHero();
    // A 22px bubble centred on a point at the top of the plot rises 11px.
    expect(chartState.margin?.top).toBe(12);
  });

  it('loads the window chosen in Customize Dashboard', async () => {
    configState.current = { ...DASHBOARD_HERO_DEFAULT, range: '5y' };
    await renderHero();
    const { startDate } = getMonthly.mock.calls[0][0] as { startDate?: string };
    const years = (Date.now() - new Date(startDate as string).getTime()) / (365.25 * 24 * 3600 * 1000);
    expect(years).toBeGreaterThan(4.5);
    expect(years).toBeLessThan(5.5);
  });

  it('charts each month at its own figure, not rounded to a whole unit', async () => {
    getMonthly.mockResolvedValue([month('2026-10', 1000.4), month('2026-11', 1250.75)]);
    await renderHero();
    expect(chartState.data.map((p) => p.value)).toEqual([1000.4, 1250.75]);
    expect(screen.getByTestId('dashboard-hero-headline')).toHaveTextContent(/1,250\.75/);
  });

  it('flags the highest and lowest months, and a flag can be dismissed', async () => {
    await renderHero();
    const area = screen.getByTestId('area');
    expect(area).toHaveTextContent(/1,100|1\.10?K/);
    expect(area).toHaveTextContent(/700/);
    const dismissButtons = within(area).getAllByRole('button', { name: 'Hide this value' });
    expect(dismissButtons).toHaveLength(2);
    await act(async () => {
      fireEvent.click(dismissButtons[0]);
    });
    expect(within(screen.getByTestId('area')).getAllByRole('button', { name: 'Hide this value' })).toHaveLength(1);
  });

  it('draws a month that did not fully convert as a gap and calls its change unknown', async () => {
    getMonthly.mockResolvedValue([
      month('2026-09', 900),
      month('2026-10', 1000),
      month('2026-11', 1100, { fxComplete: false, missingRatePairs: ['EUR->CAD'] }),
    ]);
    await renderHero();
    expect(chartState.data.map((p) => p.value)).toEqual([900, 1000, null]);
    expect(within(screen.getByTestId('dashboard-hero-pill')).getByTestId('unknown-amount')).toBeInTheDocument();
  });

  it('is busy while loading', async () => {
    await renderHero({ isLoading: true });
    expect(screen.getByRole('region', { name: 'Net worth summary' })).toHaveAttribute('aria-busy', 'true');
  });

  it('stays busy while the portfolio summary behind "invested" is still loading, so it never pops in late', async () => {
    await renderHero({ investmentSummaryLoading: true });
    expect(screen.getByRole('region', { name: 'Net worth summary' })).toHaveAttribute('aria-busy', 'true');
  });

  it('is not held up by investmentSummaryLoading when there are no investments', async () => {
    await renderHero({ hasInvestments: false, portfolioSummary: null, investmentSummaryLoading: true });
    expect(screen.getByTestId('dashboard-hero')).toBeInTheDocument();
    expect(screen.queryByText(/invested/)).not.toBeInTheDocument();
  });

  it('says so when the net worth could not be loaded', async () => {
    getMonthly.mockRejectedValue(new Error('boom'));
    await renderHero();
    expect(screen.queryByTestId('dashboard-hero')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Good evening, Ken' })).toBeInTheDocument();
    expect(screen.getByText(/Couldn't load your net worth history/)).toBeInTheDocument();
  });

  it('marks an invested figure with an unpriced holding and names the holding', async () => {
    await renderHero({
      portfolioSummary: portfolio({
        valuationComplete: false,
        pricesComplete: false,
        unpricedSecurityIds: ['sec-1'],
      }),
    });
    const invested = screen.getByText(/invested/);
    expect(within(invested).getByTestId('partial-total-marker')).toBeInTheDocument();
    // Net worth itself is complete, so only the invested figure is marked.
    expect(within(screen.getByTestId('dashboard-hero-headline')).queryByTestId('partial-total-marker')).toBeNull();
  });
});
