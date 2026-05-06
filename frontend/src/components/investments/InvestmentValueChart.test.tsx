import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from 'react';
import { render, screen, waitFor } from '@/test/render';
import {
  InvestmentValueChart,
  INVESTMENT_CHART_REFRESH_EVENT,
} from './InvestmentValueChart';
import { netWorthApi } from '@/lib/net-worth';
import { investmentsApi } from '@/lib/investments';

const dateRangeState = { dateRange: '1y', resolvedRange: { start: '2023-01-01', end: '2024-01-01' } };

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  AreaChart: ({ children }: any) => <div data-testid="area-chart">{children}</div>,
  Area: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
    formatCurrencyAxis: (n: number) => `$${n}`,
  }),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    defaultCurrency: 'CAD',
    convertToDefault: (amount: number) => amount,
    getRate: () => null,
  }),
}));

vi.mock('@/hooks/useDateRange', () => ({
  useDateRange: () => ({
    dateRange: dateRangeState.dateRange,
    setDateRange: vi.fn(),
    resolvedRange: dateRangeState.resolvedRange,
    isValid: true,
  }),
}));

vi.mock('@/lib/net-worth', () => ({
  netWorthApi: {
    getInvestmentsDaily: vi.fn().mockResolvedValue([
      { date: '2023-06-01', value: 10000 },
      { date: '2024-01-01', value: 15000 },
    ]),
    getInvestmentsMonthly: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getIntradayValue: vi.fn().mockResolvedValue({
      points: [],
      interval: '1m',
      currency: 'CAD',
      range: '1d',
      fetchedAt: new Date().toISOString(),
      skippedSymbols: [],
      fallbackToDaily: false,
    }),
  },
}));

vi.mock('@/hooks/useLocalStorage', () => ({
  useLocalStorage: (_key: string, initial: any) => [initial, vi.fn()],
}));

vi.mock('@/lib/utils', () => ({
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
  cn: (...args: any[]) => args.filter(Boolean).join(' '),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

const mockDateRangeSelectorProps = vi.fn();
vi.mock('@/components/ui/DateRangeSelector', () => ({
  DateRangeSelector: (props: any) => {
    mockDateRangeSelectorProps(props);
    return <div data-testid="date-range-selector" />;
  },
}));

describe('InvestmentValueChart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dateRangeState.dateRange = '1y';
    dateRangeState.resolvedRange = { start: '2023-01-01', end: '2024-01-01' };
    // 1y is a daily range, so mock getInvestmentsDaily
    vi.mocked(netWorthApi.getInvestmentsDaily).mockResolvedValue([
      { date: '2023-06-01', value: 10000 },
      { date: '2024-01-01', value: 15000 },
    ]);
  });

  it('renders loading state initially', async () => {
    render(<InvestmentValueChart />);
    await waitFor(() => {
      expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
    });
  });

  it('renders title after data loads', async () => {
    render(<InvestmentValueChart />);
    const title = await screen.findByText('Portfolio Value Over Time');
    expect(title).toBeInTheDocument();
  });

  it('renders summary cards after data loads', async () => {
    render(<InvestmentValueChart />);
    const currentValue = await screen.findByText('Current Value');
    expect(currentValue).toBeInTheDocument();
    expect(screen.getByText('Change')).toBeInTheDocument();
    expect(screen.getByText('Change %')).toBeInTheDocument();
  });

  it('renders the chart component after data loads', async () => {
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    expect(screen.getByTestId('area-chart')).toBeInTheDocument();
  });

  it('displays computed summary values', async () => {
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    // current: $15000, initial: $10000, change: $5000, percent: +50.0%
    expect(screen.getByText('$15000')).toBeInTheDocument();
    expect(screen.getByText('+$5000')).toBeInTheDocument();
    expect(screen.getByText('+50.0%')).toBeInTheDocument();
  });

  it('shows no data message when API returns empty', async () => {
    vi.mocked(netWorthApi.getInvestmentsDaily).mockResolvedValue([]);
    render(<InvestmentValueChart />);
    const msg = await screen.findByText('No investment data for this period.');
    expect(msg).toBeInTheDocument();
  });

  it('handles API failure gracefully', async () => {
    vi.mocked(netWorthApi.getInvestmentsDaily).mockRejectedValue(new Error('Network error'));
    render(<InvestmentValueChart />);
    const msg = await screen.findByText('No investment data for this period.');
    expect(msg).toBeInTheDocument();
  });

  it('passes accountIds to API when provided', async () => {
    render(<InvestmentValueChart accountIds={['acc-1', 'acc-2']} />);
    await screen.findByText('Portfolio Value Over Time');
    expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalledWith(
      expect.objectContaining({
        accountIds: 'acc-1,acc-2',
      })
    );
  });

  it('does not pass accountIds when empty array', async () => {
    render(<InvestmentValueChart accountIds={[]} />);
    await screen.findByText('Portfolio Value Over Time');
    expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalledWith(
      expect.objectContaining({
        accountIds: undefined,
      })
    );
  });

  it('passes date filter ranges including 1w, 1m, 3m, ytd to DateRangeSelector', async () => {
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    const lastCall = mockDateRangeSelectorProps.mock.calls[mockDateRangeSelectorProps.mock.calls.length - 1][0];
    expect(lastCall.ranges).toEqual(['1d', '1w', '1m', '3m', 'ytd', '1y', '2y', '5y', 'all']);
  });

  it('shows negative change values correctly', async () => {
    vi.mocked(netWorthApi.getInvestmentsDaily).mockResolvedValue([
      { date: '2023-06-01', value: 20000 },
      { date: '2024-01-01', value: 15000 },
    ]);
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    expect(screen.getByText('$15000')).toBeInTheDocument();
    expect(screen.getByText('-25.0%')).toBeInTheDocument();
  });

  it('uses daily API for 1y range (DAILY_RANGES)', async () => {
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalled();
    expect(netWorthApi.getInvestmentsMonthly).not.toHaveBeenCalled();
  });

  it('uses daily API for 2y range (DAILY_RANGES)', async () => {
    dateRangeState.dateRange = '2y';
    dateRangeState.resolvedRange = { start: '2022-01-01', end: '2024-01-01' };
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalled();
    expect(netWorthApi.getInvestmentsMonthly).not.toHaveBeenCalled();
  });

  it('uses intraday API for 1d range', async () => {
    dateRangeState.dateRange = '1d';
    vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue({
      points: [
        { timestamp: '2024-01-02T14:30:00.000Z', value: 9500 },
        { timestamp: '2024-01-02T14:31:00.000Z', value: 9600 },
      ],
      interval: '1m',
      currency: 'CAD',
      range: '1d',
      fetchedAt: '2024-01-02T15:00:00.000Z',
      skippedSymbols: [],
      fallbackToDaily: false,
    });
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    expect(investmentsApi.getIntradayValue).toHaveBeenCalledWith(
      expect.objectContaining({ range: '1d' }),
    );
    expect(netWorthApi.getInvestmentsDaily).not.toHaveBeenCalled();
  });

  it('shows the unavailable note on 1d when providers are mixed', async () => {
    dateRangeState.dateRange = '1d';
    vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue({
      points: [],
      interval: '1m',
      currency: 'CAD',
      range: '1d',
      fetchedAt: '2024-01-02T15:00:00.000Z',
      skippedSymbols: ['VFV.TO'],
      fallbackToDaily: true,
    });
    render(<InvestmentValueChart />);
    expect(
      await screen.findByText(/Intraday view unavailable/i),
    ).toBeInTheDocument();
  });

  it('falls back to the daily endpoint on 1w when fallbackToDaily=true', async () => {
    dateRangeState.dateRange = '1w';
    dateRangeState.resolvedRange = { start: '2023-12-25', end: '2024-01-01' };
    vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue({
      points: [],
      interval: '5m',
      currency: 'CAD',
      range: '1w',
      fetchedAt: '2024-01-02T15:00:00.000Z',
      skippedSymbols: ['VFV.TO'],
      fallbackToDaily: true,
    });
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    await waitFor(() => {
      expect(netWorthApi.getInvestmentsDaily).toHaveBeenCalled();
    });
  });

  it('clears intraday cache and re-fetches when refresh event fires on 1d', async () => {
    dateRangeState.dateRange = '1d';
    vi.mocked(investmentsApi.getIntradayValue).mockResolvedValue({
      points: [{ timestamp: '2024-01-02T14:30:00.000Z', value: 9500 }],
      interval: '1m',
      currency: 'CAD',
      range: '1d',
      fetchedAt: '2024-01-02T15:00:00.000Z',
      skippedSymbols: [],
      fallbackToDaily: false,
    });
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    const initialCalls = vi.mocked(investmentsApi.getIntradayValue).mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event(INVESTMENT_CHART_REFRESH_EVENT));
    });
    await waitFor(() => {
      expect(
        vi.mocked(investmentsApi.getIntradayValue).mock.calls.length,
      ).toBeGreaterThan(initialCalls);
    });
  });

  it('uses monthly API for 5y range (not in DAILY_RANGES)', async () => {
    dateRangeState.dateRange = '5y';
    dateRangeState.resolvedRange = { start: '2019-01-01', end: '2024-01-01' };
    vi.mocked(netWorthApi.getInvestmentsMonthly).mockResolvedValue([
      { month: '2019-01-01', value: 1000 },
      { month: '2024-01-01', value: 2000 },
    ]);
    render(<InvestmentValueChart />);
    await screen.findByText('Portfolio Value Over Time');
    expect(netWorthApi.getInvestmentsMonthly).toHaveBeenCalled();
    expect(netWorthApi.getInvestmentsDaily).not.toHaveBeenCalled();
  });
});
