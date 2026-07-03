import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { BalanceHistoryChart } from './BalanceHistoryChart';
import { computeBalanceGradient } from '@/lib/balance-history';

// The Area mock invokes the `dot` render-prop so the high/low value bubbles
// are exercised by the data-driven tests below; their output is exposed via
// the "line-dots" test id. Existing assertions are unaffected.
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  AreaChart: ({ children }: any) => <div data-testid="area-chart">{children}</div>,
  Area: ({ dot }: any) => (
    <div data-testid="area">
      {typeof dot === 'function' && (
        <svg data-testid="line-dots">
          {dot({ cx: 50, cy: 60, index: 0 })}
          {dot({ cx: 70, cy: 80, index: 1 })}
        </svg>
      )}
    </div>
  ),
  XAxis: () => <div data-testid="x-axis" />,
  YAxis: () => <div data-testid="y-axis" />,
  CartesianGrid: () => <div data-testid="cartesian-grid" />,
  Tooltip: () => <div data-testid="tooltip" />,
  ReferenceLine: () => <div data-testid="reference-line" />,
}));

const mockFormatCurrency = vi.fn((n: number, _code?: string) => `$${n.toFixed(2)}`);
const mockFormatCurrencyAxis = vi.fn((n: number, _code?: string) => `$${n}`);
const mockFormatCurrencyFlag = vi.fn((n: number, _code?: string) => `$${n}`);

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: mockFormatCurrency,
    formatCurrencyAxis: mockFormatCurrencyAxis,
    formatCurrencyFlag: mockFormatCurrencyFlag,
  }),
}));

describe('BalanceHistoryChart', () => {
  it('renders loading state with title and pulse skeleton', () => {
    render(
      <BalanceHistoryChart data={[]} isLoading={true} />
    );
    expect(screen.getByText('Balance History')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('shows empty state when no data returned', () => {
    render(
      <BalanceHistoryChart data={[]} isLoading={false} />
    );
    expect(screen.getByText('No balance data available')).toBeInTheDocument();
  });

  it('renders chart with data and summary footer', () => {
    render(
      <BalanceHistoryChart
        data={[
          { date: '2025-01-01', balance: 1000 },
          { date: '2025-01-02', balance: 750 },
          { date: '2025-01-03', balance: 900 },
        ]}
        isLoading={false}
      />
    );

    expect(screen.getByTestId('area-chart')).toBeInTheDocument();
    expect(screen.getByText('Starting')).toBeInTheDocument();
    expect(screen.getByText('Current')).toBeInTheDocument();
    expect(screen.getByText('Min Balance')).toBeInTheDocument();
    expect(screen.getByText('$1000.00')).toBeInTheDocument();
    expect(screen.getByText('$900.00')).toBeInTheDocument();
    expect(screen.getByText('$750.00')).toBeInTheDocument();
  });

  it('renders a download button titled after the chart when data is present', () => {
    render(
      <BalanceHistoryChart
        data={[
          { date: '2025-01-01', balance: 1000 },
          { date: '2025-01-02', balance: 900 },
        ]}
        isLoading={false}
      />
    );

    expect(
      screen.getByRole('button', { name: /download balance history as png/i }),
    ).toBeInTheDocument();
  });

  it('hides the download button in loading and empty states', () => {
    const { rerender } = render(
      <BalanceHistoryChart data={[]} isLoading={true} />,
    );
    expect(screen.queryByRole('button', { name: /download/i })).not.toBeInTheDocument();

    rerender(<BalanceHistoryChart data={[]} isLoading={false} />);
    expect(screen.queryByRole('button', { name: /download/i })).not.toBeInTheDocument();
  });

  it('appends the account name to the download button filename when provided', () => {
    render(
      <BalanceHistoryChart
        data={[
          { date: '2025-01-01', balance: 1000 },
          { date: '2025-01-02', balance: 900 },
        ]}
        isLoading={false}
        accountName="Checking"
      />
    );

    expect(
      screen.getByRole('button', { name: /download balance history - checking as png/i }),
    ).toBeInTheDocument();
  });

  it('shows "Lowest" label and warning when balance goes negative', () => {
    render(
      <BalanceHistoryChart
        data={[
          { date: '2025-01-01', balance: 100 },
          { date: '2025-01-02', balance: -50 },
        ]}
        isLoading={false}
      />
    );

    expect(screen.getByText('Lowest')).toBeInTheDocument();
    expect(screen.getByText('!')).toBeInTheDocument();
  });

  it('shows Ending balance when future transactions exist', () => {
    // Lock "today" so the data points after it stay in the future forever;
    // with a real clock this test started failing the day the last hardcoded
    // date stopped being in the future.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-04-10T12:00:00Z'));
    try {
      render(
        <BalanceHistoryChart
          data={[
            { date: '2026-01-01', balance: 1000 },
            { date: '2026-03-19', balance: 800 },
            { date: '2026-04-15', balance: 650 },
            { date: '2026-05-01', balance: 500 },
            { date: '2026-06-01', balance: 400 },
            { date: '2026-07-01', balance: 300 },
          ]}
          isLoading={false}
        />
      );

      expect(screen.getByText('Starting')).toBeInTheDocument();
      expect(screen.getByText('Current')).toBeInTheDocument();
      expect(screen.getByText('Ending')).toBeInTheDocument();
      expect(screen.getByText('Min Balance')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not show Ending balance when no future transactions', () => {
    render(
      <BalanceHistoryChart
        data={[
          { date: '2025-01-01', balance: 1000 },
          { date: '2025-06-01', balance: 750 },
          { date: '2025-12-31', balance: 900 },
        ]}
        isLoading={false}
      />
    );

    expect(screen.getByText('Starting')).toBeInTheDocument();
    expect(screen.getByText('Current')).toBeInTheDocument();
    expect(screen.queryByText('Ending')).not.toBeInTheDocument();
  });

  it('does not show Ending balance when end date filter is in the future but no future transactions exist', () => {
    // The backend returns one row per day in the filtered range, so when the
    // user sets an end date in the future the chart has points after today
    // with the balance carried forward unchanged. "Ending" should not appear.
    render(
      <BalanceHistoryChart
        data={[
          { date: '2026-01-01', balance: 1000 },
          { date: '2026-03-01', balance: 1500 },
          { date: '2026-04-09', balance: 1500 },
          { date: '2026-06-01', balance: 1500 },
          { date: '2026-12-31', balance: 1500 },
        ]}
        isLoading={false}
      />
    );

    expect(screen.getByText('Starting')).toBeInTheDocument();
    expect(screen.getByText('Current')).toBeInTheDocument();
    expect(screen.queryByText('Ending')).not.toBeInTheDocument();
  });

  it('shows Current as today balance and Ending as last future data point', () => {
    // Lock "today" so the test is not date-dependent. With today = 2026-04-10,
    // data: start=2000, dip=1500, current(today-anchor=2026-04-01)=1800, ending=1900.
    // Min balance = 1500.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-04-10T12:00:00Z'));
    try {
      render(
        <BalanceHistoryChart
          data={[
            { date: '2026-03-01', balance: 2000 },
            { date: '2026-03-10', balance: 1500 },
            { date: '2026-04-01', balance: 1800 },
            { date: '2026-04-15', balance: 1900 },
          ]}
          isLoading={false}
        />
      );

      expect(screen.getByText('Ending')).toBeInTheDocument();
      // Starting = 2000, Current = 1800 (today or before), Ending = 1900, Min = 1500
      expect(screen.getByText('$2000.00')).toBeInTheDocument();
      expect(screen.getByText('$1800.00')).toBeInTheDocument();
      expect(screen.getByText('$1900.00')).toBeInTheDocument();
      expect(screen.getByText('$1500.00')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes currencyCode to formatting functions', () => {
    mockFormatCurrency.mockClear();

    render(
      <BalanceHistoryChart
        data={[
          { date: '2025-01-01', balance: 500 },
          { date: '2025-01-02', balance: 600 },
        ]}
        isLoading={false}
        currencyCode="EUR"
      />
    );

    // Summary footer calls formatCurrency with currencyCode
    const eurCalls = mockFormatCurrency.mock.calls.filter(
      ([, code]) => code === 'EUR',
    );
    expect(eurCalls.length).toBeGreaterThan(0);
  });

  it('marks the highest and lowest points with value bubbles', () => {
    mockFormatCurrencyFlag.mockClear();
    render(
      <BalanceHistoryChart
        data={[
          { date: '2025-01-01', balance: 500 },
          { date: '2025-01-02', balance: 600 },
        ]}
        isLoading={false}
        currencyCode="EUR"
      />
    );
    // The lowest (500) and highest (600) points each render a labelled bubble,
    // formatted through the compact "flag" formatter with the chart currency.
    const dots = screen.getByTestId('line-dots');
    const labels = Array.from(dots.querySelectorAll('text')).map((node) => node.textContent);
    expect(labels).toContain('$500');
    expect(labels).toContain('$600');
    const eurFlagCalls = mockFormatCurrencyFlag.mock.calls.filter(([, code]) => code === 'EUR');
    expect(eurFlagCalls.length).toBeGreaterThan(0);
  });

  it('temporarily hides a value bubble when its dismiss control is clicked', () => {
    const { container } = render(
      <BalanceHistoryChart
        data={[
          { date: '2025-01-01', balance: 500 },
          { date: '2025-01-02', balance: 600 },
        ]}
        isLoading={false}
        currencyCode="EUR"
      />
    );
    const labels = () =>
      Array.from(
        container.querySelectorAll('[data-testid="line-dots"] text'),
      ).map((node) => node.textContent);
    expect(labels()).toEqual(expect.arrayContaining(['$500', '$600']));

    // The dot mock renders index 0 (low, $500) then index 1 (high, $600), so
    // the second dismiss control belongs to the high bubble.
    const closeControls = container.querySelectorAll('.chart-flag-dismiss');
    expect(closeControls).toHaveLength(2);
    fireEvent.click(closeControls[1]);

    expect(labels()).toContain('$500');
    expect(labels()).not.toContain('$600');
  });
});

describe('computeBalanceGradient', () => {
  it('fades from the line down toward zero for all-positive balances', () => {
    const g = computeBalanceGradient([1000, 1200, 900]);
    // Line (top) is most shaded; the zero side (bottom) is clear.
    expect(g.topOpacity).toBe(0.3);
    expect(g.bottomOpacity).toBe(0);
    expect(g.zeroOffset).toBe(1);
  });

  it('mirrors the fade so negative balances shade toward the bottom', () => {
    const g = computeBalanceGradient([-1000, -200, -750]);
    // Zero side (top) is clear; the line (bottom) is most shaded.
    expect(g.topOpacity).toBe(0);
    expect(g.bottomOpacity).toBe(0.3);
    expect(g.zeroOffset).toBe(0);
  });

  it('anchors zero in the middle when balances cross zero', () => {
    const g = computeBalanceGradient([100, -100]);
    expect(g.topOpacity).toBe(0.3);
    expect(g.bottomOpacity).toBe(0.3);
    expect(g.zeroOffset).toBeCloseTo(0.5);
  });

  it('places the zero anchor proportionally for an asymmetric crossing range', () => {
    // max=300, min=-100, span=400 -> zero sits 300/400 = 0.75 from the top.
    const g = computeBalanceGradient([300, -100]);
    expect(g.zeroOffset).toBeCloseTo(0.75);
  });

  it('treats a flat positive series as positive shading', () => {
    const g = computeBalanceGradient([500, 500]);
    expect(g.topOpacity).toBe(0.3);
    expect(g.bottomOpacity).toBe(0);
    expect(g.zeroOffset).toBe(1);
  });

  it('treats a flat negative series as negative shading', () => {
    const g = computeBalanceGradient([-500, -500]);
    expect(g.topOpacity).toBe(0);
    expect(g.bottomOpacity).toBe(0.3);
    expect(g.zeroOffset).toBe(0);
  });
});
