import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@/test/render';
import { BalanceHistoryChart } from './BalanceHistoryChart';
import { computeBalanceGradient } from '@/lib/balance-history';
import { parseLocalDate } from '@/lib/utils';
import { clearCurrencyDecimals, registerCurrencyDecimals } from '@/lib/currency-decimals';

/**
 * A day as the x coordinate the chart uses. The axis is a time scale, so a
 * reference dot is positioned by timestamp rather than by ISO date; the tests
 * still name the day they mean.
 */
const at = (isoDate: string) => String(parseLocalDate(isoDate).getTime());

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
  // Exposes the axis configuration, so the tests can assert that distance along
  // it is elapsed time rather than a point index.
  XAxis: ({ type, scale, ticks, tickFormatter }: any) => (
    <div
      data-testid="x-axis"
      data-type={type}
      data-scale={scale}
      data-ticks={(ticks ?? []).join(',')}
      data-labels={(ticks ?? [])
        .map((tick: number) => tickFormatter?.(tick))
        .join(',')}
    />
  ),
  YAxis: () => <div data-testid="y-axis" />,
  CartesianGrid: () => <div data-testid="cartesian-grid" />,
  // Render the tooltip's content with a hovered point, so the marker lines
  // under the value are exercised.
  Tooltip: ({ content }: any) => (
    <div data-testid="tooltip">
      {content
        ? {
            ...content,
            props: {
              ...content.props,
              active: true,
              payload: [
                { payload: { date: '2026-01-02', label: 'Jan 2, 2026', balance: 120 } },
              ],
            },
          }
        : null}
    </div>
  ),
  ReferenceLine: ({ y, x, stroke }: any) => (
    <div
      data-testid="reference-line"
      data-y={y}
      data-x={x}
      data-stroke={stroke}
    />
  ),
  ReferenceDot: ({ x, y, fill }: any) => (
    <div data-testid="reference-dot" data-x={x} data-y={y} data-fill={fill} />
  ),
}));

const mockFormatCurrency = vi.fn((n: number, _code?: string) => `$${n.toFixed(2)}`);
const mockFormatCurrencyAxis = vi.fn((n: number, _code?: string) => `$${n}`);
const mockFormatCurrencyFlag = vi.fn((n: number, _code?: string) => `$${n}`);

const mockFormatCurrencyPrecise = vi.fn(
  (n: number, _code?: string) => `$${n.toFixed(6)}`,
);

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: mockFormatCurrency,
      formatCurrencyPrecise: mockFormatCurrencyPrecise,
      formatCurrencyAxis: mockFormatCurrencyAxis,
      formatCurrencyFlag: mockFormatCurrencyFlag,
    }),
  };
});
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

  it('offers the fold button in every state, only where the page asks for it', () => {
    const onCollapse = vi.fn();
    const data = [
      { date: '2025-01-01', balance: 1000 },
      { date: '2025-01-02', balance: 750 },
    ];
    const { rerender } = render(<BalanceHistoryChart data={data} isLoading={false} />);
    expect(screen.queryByRole('button', { name: 'Hide chart' })).not.toBeInTheDocument();

    for (const props of [
      { data: [], isLoading: true },
      { data: [], isLoading: false },
      { data, isLoading: false },
    ]) {
      rerender(<BalanceHistoryChart {...props} onCollapse={onCollapse} />);
      fireEvent.click(screen.getByRole('button', { name: 'Hide chart' }));
    }
    expect(onCollapse).toHaveBeenCalledTimes(3);
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

  it('shows the covered date range under the title', () => {
    // A multi-year span also exercises the year-based axis tick branch.
    render(
      <BalanceHistoryChart
        data={[
          { date: '2021-01-01', balance: 1000 },
          { date: '2025-06-01', balance: 900 },
        ]}
        isLoading={false}
      />
    );

    expect(screen.getByText(/2021.*–.*2025/)).toBeInTheDocument();
  });

  it('does not render a date-range caption in the empty state', () => {
    render(<BalanceHistoryChart data={[]} isLoading={false} />);
    expect(screen.queryByText(/–/)).not.toBeInTheDocument();
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

  it('omits the "Lowest" alarm styling for liability accounts with a negative balance', () => {
    render(
      <BalanceHistoryChart
        data={[
          { date: '2025-01-01', balance: -100 },
          { date: '2025-01-02', balance: -250 },
        ]}
        isLoading={false}
        isLiability
      />
    );

    // A negative balance is expected for a credit card / loan, so the footer
    // keeps the neutral "Min Balance" label and shows no warning marker.
    expect(screen.getByText('Min Balance')).toBeInTheDocument();
    expect(screen.queryByText('Lowest')).not.toBeInTheDocument();
    expect(screen.queryByText('!')).not.toBeInTheDocument();
    // The value is still coloured red because it is negative (Current and Min
    // are both -250 here).
    screen
      .getAllByText('$-250.00')
      .forEach((el) => expect(el.className).toContain('text-red-600'));
  });

  describe('markerSnap', () => {
    const sparse = [
      { date: '2026-01-01', balance: 0 },
      { date: '2026-06-01', balance: 1200 },
    ];
    const trade = [
      { date: '2026-02-01', direction: 'in' as const, label: 'Bought 10' },
    ];

    it('pins a marker to the preceding point by default', () => {
      render(
        <BalanceHistoryChart data={sparse} isLoading={false} markers={trade} />,
      );
      // A price is continuous, so the last quote before the trade is near enough.
      expect(screen.getByTestId('reference-dot')).toHaveAttribute(
        'data-x',
        at('2026-01-01'),
      );
    });

    it('pins a marker to the first point that reflects it when asked', () => {
      render(
        <BalanceHistoryChart
          data={sparse}
          isLoading={false}
          markers={trade}
          markerSnap="later"
        />,
      );
      // On a value series the purchase is what lifts the line: pinned backwards
      // it landed on the day the position was still zero, drawing the dot flat
      // on the axis where it read as missing entirely.
      const dot = screen.getByTestId('reference-dot');
      expect(dot).toHaveAttribute('data-x', at('2026-06-01'));
      expect(dot).toHaveAttribute('data-y', '1200');
    });

    it('still drops a marker outside the window either way', () => {
      render(
        <BalanceHistoryChart
          data={sparse}
          isLoading={false}
          markers={[{ date: '2030-01-01', direction: 'in', label: 'Later' }]}
          markerSnap="later"
        />,
      );
      expect(screen.queryByTestId('reference-dot')).toBeNull();
    });
  });

  describe('hideExtremeFlags', () => {
    const swinging = [
      { date: '2026-01-01', balance: 100 },
      { date: '2026-02-01', balance: 300 },
      { date: '2026-03-01', balance: 50 },
    ];

    /** Radii of the dots the series' render-prop drew, in DOM order. */
    function dotRadii(): number[] {
      return Array.from(
        screen.getByTestId('line-dots').querySelectorAll('circle'),
      ).map((circle) => Number(circle.getAttribute('r') ?? 0));
    }

    it('draws the high/low bubbles by default', () => {
      render(<BalanceHistoryChart data={swinging} isLoading={false} />);
      // The render-prop draws a zero-radius circle for an ordinary point and a
      // real one for an extreme, so a visible dot means a bubble was drawn.
      expect(dotRadii().some((r) => r > 0)).toBe(true);
    });

    it('drops them when asked', () => {
      render(
        <BalanceHistoryChart data={swinging} isLoading={false} hideExtremeFlags />,
      );
      // They read as "this is what you paid" beside buy/sell markers of the same
      // green and red, and the footer already states these figures.
      expect(dotRadii().every((r) => r === 0)).toBe(true);
    });

    it('keeps the footer figures when the bubbles are gone', () => {
      render(
        <BalanceHistoryChart data={swinging} isLoading={false} hideExtremeFlags />,
      );
      expect(screen.getByText('Min Balance')).toBeInTheDocument();
      // Current and Min are both 50 here, so the figure is on screen twice.
      expect(screen.getAllByText('$50.00').length).toBeGreaterThan(0);
    });
  });

  describe('summaryLabels', () => {
    it('renames the footer figures for a series that is not a balance', () => {
      render(
        <BalanceHistoryChart
          data={[
            { date: '2025-01-01', balance: 86.46 },
            { date: '2025-01-02', balance: 104.9 },
          ]}
          isLoading={false}
          summaryLabels={{
            starting: 'First',
            current: 'Latest',
            ending: 'Ending',
            lowest: 'Lowest price',
          }}
        />,
      );

      // "Min Balance" is simply false about a price series.
      expect(screen.getByText('First')).toBeInTheDocument();
      expect(screen.getByText('Latest')).toBeInTheDocument();
      expect(screen.getByText('Lowest price')).toBeInTheDocument();
      expect(screen.queryByText('Min Balance')).toBeNull();
      expect(screen.queryByText('Starting')).toBeNull();
    });

    it('drops the overdrawn-account alarm for a named series', () => {
      render(
        <BalanceHistoryChart
          data={[
            { date: '2025-01-01', balance: 5 },
            { date: '2025-01-02', balance: -12 },
          ]}
          isLoading={false}
          summaryLabels={{
            starting: 'First',
            current: 'Latest',
            ending: 'Ending',
            lowest: 'Lowest',
          }}
        />,
      );

      // A negative return is a loss, not an overdraft: no red "!" and no
      // substituted alarm wording.
      expect(screen.queryByText('!')).toBeNull();
      expect(screen.getByText('Lowest')).toBeInTheDocument();
    });

    it('keeps the balance wording when no names are given', () => {
      render(
        <BalanceHistoryChart
          data={[
            { date: '2025-01-01', balance: 100 },
            { date: '2025-01-02', balance: 150 },
          ]}
          isLoading={false}
        />,
      );

      expect(screen.getByText('Starting')).toBeInTheDocument();
      expect(screen.getByText('Min Balance')).toBeInTheDocument();
    });
  });

  it('colours each summary figure green or red by sign', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-04-10T12:00:00Z'));
    try {
      render(
        <BalanceHistoryChart
          data={[
            { date: '2026-01-01', balance: 100 }, // Starting: positive -> green
            { date: '2026-03-01', balance: -50 }, // Current/Min: negative -> red
            { date: '2026-06-01', balance: 200 }, // Ending: positive -> green
          ]}
          isLoading={false}
        />
      );

      expect(screen.getByText('$100.00').className).toContain('text-green-600');
      expect(screen.getByText('$200.00').className).toContain('text-green-600');
      // Current and Min are both -50 here; both render red.
      const negatives = screen.getAllByText('$-50.00');
      expect(negatives).toHaveLength(2);
      negatives.forEach((el) => expect(el.className).toContain('text-red-600'));
    } finally {
      vi.useRealTimers();
    }
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

  describe('markers', () => {
    const series = [
      { date: '2026-01-01', balance: 100 },
      { date: '2026-01-02', balance: 120 },
      { date: '2026-01-03', balance: 110 },
    ];

    it('pins a dot on the day of each event, green in and red out', () => {
      render(
        <BalanceHistoryChart
          data={series}
          isLoading={false}
          markers={[
            { date: '2026-01-02', direction: 'in', label: 'Bought 10' },
            { date: '2026-01-03', direction: 'out', label: 'Sold 4' },
          ]}
        />,
      );

      const dots = screen.getAllByTestId('reference-dot');
      expect(dots).toHaveLength(2);
      expect(dots[0]).toHaveAttribute('data-x', at('2026-01-02'));
      expect(dots[0]).toHaveAttribute('data-y', '120');
      expect(dots[0].getAttribute('data-fill')).not.toBe(
        dots[1].getAttribute('data-fill'),
      );
    });

    it('snaps an event on a non-trading day back to the last known price', () => {
      // A trade on a Saturday has no price row of its own.
      render(
        <BalanceHistoryChart
          data={series}
          isLoading={false}
          markers={[{ date: '2026-01-02T12:00:00Z'.slice(0, 10), direction: 'in', label: 'Bought 1' }]}
        />,
      );
      expect(screen.getByTestId('reference-dot')).toHaveAttribute('data-x', at('2026-01-02'));

      cleanup();
      render(
        <BalanceHistoryChart
          data={series}
          isLoading={false}
          markers={[
            { date: '2025-12-31', direction: 'in', label: 'Bought 100' },
            { date: '2026-01-04', direction: 'out', label: 'Sold 2' },
          ]}
        />,
      );
      // Outside the series entirely: dropped, not clamped onto its ends. A
      // migration carries decades of trades against a couple of years of
      // backfilled prices, and clamping would claim they all happened on the
      // first day it has a price for.
      expect(screen.queryByTestId('reference-dot')).toBeNull();
    });

    it('lists the events for the hovered day in the tooltip', () => {
      render(
        <BalanceHistoryChart
          data={series}
          isLoading={false}
          markers={[
            { date: '2026-01-02', direction: 'in', label: 'Bought 10' },
            { date: '2026-01-02', direction: 'out', label: 'Sold 4' },
          ]}
        />,
      );

      expect(screen.getByText('Bought 10')).toBeInTheDocument();
      expect(screen.getByText('Sold 4')).toBeInTheDocument();
    });

    it('draws no dots without markers', () => {
      render(<BalanceHistoryChart data={series} isLoading={false} />);
      expect(screen.queryByTestId('reference-dot')).toBeNull();
    });
  });

  describe('precise mode', () => {
    const subCent = [
      { date: '2026-01-01', balance: 0.000342 },
      { date: '2026-01-02', balance: 0.000411 },
    ];

    it('keeps sub-cent values and formats them precisely', () => {
      render(
        <BalanceHistoryChart data={subCent} isLoading={false} precise />
      );

      // Rounding a price to cents would flatten the series to zero and print
      // "$0.00" beside a table showing 0.000342.
      expect(mockFormatCurrencyPrecise).toHaveBeenCalled();
      const rounded = mockFormatCurrency.mock.calls.map((call) => call[0]);
      expect(rounded).not.toContain(0);
    });

    it('keeps the quoted values in the footer figures', () => {
      render(<BalanceHistoryChart data={subCent} isLoading={false} precise />);
      const footer = mockFormatCurrencyPrecise.mock.calls.map((call) => call[0]);
      expect(footer).toContain(0.000342);
      expect(footer).toContain(0.000411);
    });

    it('still rounds a balance series to cents', () => {
      render(
        <BalanceHistoryChart
          data={[
            { date: '2026-01-01', balance: 10.005 },
            { date: '2026-01-02', balance: 12.344 },
          ]}
          isLoading={false}
        />,
      );
      expect(mockFormatCurrency).toHaveBeenCalled();
    });
  });
});

describe('BalanceHistoryChart in a four-place currency', () => {
  afterEach(() => {
    clearCurrencyDecimals();
  });

  it('plots and summarises a coin balance at its own places, not cents', () => {
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 4 }]);
    mockFormatCurrency.mockClear();
    render(
      <BalanceHistoryChart
        data={[
          { date: '2026-01-01', balance: 0.0125 },
          { date: '2026-01-02', balance: 0.007 },
        ]}
        isLoading={false}
        currencyCode="BTC"
      />,
    );
    const formatted = mockFormatCurrency.mock.calls.map((call) => call[0]);
    // Rounded to cents, 0.0070 read 0.01 and the summary's Current 0.0100.
    expect(formatted).toContain(0.007);
    expect(formatted).toContain(0.0125);
    expect(formatted).not.toContain(0.01);
  });

  it('rounds an unregistered code at Intl\'s two places', () => {
    mockFormatCurrency.mockClear();
    render(
      <BalanceHistoryChart
        data={[
          { date: '2026-01-01', balance: 10.004 },
          { date: '2026-01-02', balance: 12.346 },
        ]}
        isLoading={false}
        currencyCode="USD"
      />,
    );
    const formatted = mockFormatCurrency.mock.calls.map((call) => call[0]);
    expect(formatted).toContain(10);
    expect(formatted).toContain(12.35);
  });
});

describe('BalanceHistoryChart x axis', () => {
  /** A dense recent stretch after a sparse older one -- the shape that exposed
   *  the bug: yearly points to 2024, then daily ones. */
  const unevenHistory = [
    ...['2021-03-01', '2022-03-01', '2023-03-01', '2024-03-01'].map((date) => ({
      date,
      balance: 100,
    })),
    ...Array.from({ length: 120 }, (_, i) => ({
      date: `2026-0${1 + Math.floor(i / 40)}-${String((i % 28) + 1).padStart(2, '0')}`,
      balance: 150,
    })),
  ];

  it('measures distance along the axis in time, not in data points', () => {
    // On a category axis recharts spaces every point equally, so 120 daily
    // closes in 2026 took thirty times the width of the four years before them
    // and squeezed those year labels into the left edge.
    render(<BalanceHistoryChart data={unevenHistory} isLoading={false} />);
    const axis = screen.getByTestId('x-axis');
    expect(axis).toHaveAttribute('data-type', 'number');
    expect(axis).toHaveAttribute('data-scale', 'time');
  });

  it('puts the year ticks on January 1st, at equal intervals', () => {
    render(<BalanceHistoryChart data={unevenHistory} isLoading={false} />);
    const ticks = screen
      .getByTestId('x-axis')
      .getAttribute('data-ticks')!
      .split(',')
      .map(Number);

    // Every tick is the start of a year...
    for (const tick of ticks) {
      const date = new Date(tick);
      expect(date.getMonth()).toBe(0);
      expect(date.getDate()).toBe(1);
    }
    // ...and consecutive years, so the spacing is a calendar year throughout
    // rather than "wherever that year's data happens to begin".
    const years = ticks.map((tick) => new Date(tick).getFullYear());
    expect(years).toEqual([2022, 2023, 2024, 2025, 2026]);
  });

  it('labels a span of two years or less by month', () => {
    render(
      <BalanceHistoryChart
        data={[
          { date: '2026-01-15', balance: 10 },
          { date: '2026-04-20', balance: 20 },
        ]}
        isLoading={false}
      />,
    );
    const ticks = screen
      .getByTestId('x-axis')
      .getAttribute('data-ticks')!
      .split(',')
      .map(Number);
    expect(ticks.map((tick) => new Date(tick).getMonth())).toEqual([1, 2, 3]);
  });

  it('falls back to the span ends when no boundary is crossed', () => {
    // A week of data crosses no month start; a bare axis would be worse than
    // labelling what it does cover.
    render(
      <BalanceHistoryChart
        data={[
          { date: '2026-03-10', balance: 10 },
          { date: '2026-03-14', balance: 20 },
        ]}
        isLoading={false}
      />,
    );
    expect(
      screen.getByTestId('x-axis').getAttribute('data-ticks')!.split(','),
    ).toHaveLength(2);
  });
});

describe('BalanceHistoryChart lowest-value marker', () => {
  const dipping = [
    { date: '2026-01-01', balance: 100 },
    { date: '2026-02-01', balance: 60 },
    { date: '2026-03-01', balance: 90 },
  ];

  /** Every reference line's `data-y`, as numbers. */
  const lineYs = () =>
    screen
      .getAllByTestId('reference-line')
      .map((el) => el.getAttribute('data-y'))
      .filter((y) => y !== null)
      .map(Number);

  it('marks the lowest point on a balance series', () => {
    render(<BalanceHistoryChart data={dipping} isLoading={false} />);
    // "This is how low you got" is worth flagging on an account balance.
    expect(lineYs()).toContain(60);
  });

  it('leaves it off a series that is not a balance', () => {
    render(
      <BalanceHistoryChart
        data={dipping}
        isLoading={false}
        summaryLabels={{
          starting: 'First',
          current: 'Latest',
          ending: 'Ending',
          lowest: 'Lowest',
        }}
      />,
    );
    // A price or a percentage always has a minimum, and an amber dashed line
    // across it reads as a warning about nothing. `summaryLabels` is the
    // caller saying this is not a balance.
    expect(lineYs()).not.toContain(60);
    // The zero line still belongs there.
    expect(lineYs()).toContain(0);
  });
});

describe('BalanceHistoryChart with a single point', () => {
  it('labels a one-point series once, not twice', () => {
    // `from === to`, so the fallback used to emit the same tick twice: two
    // labels stacked on each other over a zero-width time domain.
    render(
      <BalanceHistoryChart
        data={[{ date: '2026-03-10', balance: 42 }]}
        isLoading={false}
      />,
    );
    expect(
      screen.getByTestId('x-axis').getAttribute('data-ticks')!.split(','),
    ).toHaveLength(1);
  });
});
