import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { AccountBalancesBarChart } from './AccountBalancesBarChart';

// Capture the Bar onClick handler so we can simulate account bar clicks
// without relying on the real recharts rendering pipeline.
let capturedBarOnClick: ((entry: any) => void) | undefined;
// Capture the BarChart onClick so we can simulate clicks anywhere in the
// tooltip-highlighted column (the whitespace above a bar).
let capturedBarChartOnClick: ((state: any) => void) | undefined;
// Capture the YAxis props so we can assert which scale the chart picked.
let capturedYAxisProps: any;
// Capture the XAxis props so we can assert label rotation behaviour.
let capturedXAxisProps: any;
// Capture the BarChart margin so we can assert the Y axis labels have room.
let capturedBarChartMargin: any;

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  BarChart: ({ children, onClick, margin }: any) => {
    capturedBarChartOnClick = onClick;
    capturedBarChartMargin = margin;
    return <div data-testid="bar-chart">{children}</div>;
  },
  Bar: ({ children, onClick }: any) => {
    capturedBarOnClick = onClick;
    return <div data-testid="bar">{children}</div>;
  },
  XAxis: (props: any) => {
    capturedXAxisProps = props;
    return <div data-testid="x-axis" />;
  },
  YAxis: (props: any) => {
    capturedYAxisProps = props;
    return <div data-testid="y-axis" />;
  },
  CartesianGrid: () => <div data-testid="cartesian-grid" />,
  Tooltip: () => <div data-testid="tooltip" />,
  LabelList: () => <div data-testid="label-list" />,
  Cell: () => <div data-testid="cell" />,
}));

const mockFormatCurrency = vi.fn((n: number, _code?: string) => `$${n.toFixed(2)}`);
const mockFormatCurrencyAxis = vi.fn((n: number, _code?: string) => `$${n}`);

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: mockFormatCurrency,
      formatCurrencyAxis: mockFormatCurrencyAxis,
    }),
  };
});

// Control the mobile breakpoint deterministically from tests.
const mockIsMobile = vi.fn(() => false);
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => mockIsMobile(),
}));

describe('AccountBalancesBarChart', () => {
  beforeEach(() => {
    capturedBarOnClick = undefined;
    capturedBarChartOnClick = undefined;
    capturedYAxisProps = undefined;
    capturedXAxisProps = undefined;
    mockFormatCurrency.mockImplementation((n: number) => `$${n.toFixed(2)}`);
    mockFormatCurrency.mockClear();
    mockFormatCurrencyAxis.mockClear();
    mockIsMobile.mockReturnValue(false);
  });

  it('renders loading state with title and pulse skeleton', () => {
    render(<AccountBalancesBarChart data={[]} isLoading={true} />);
    expect(screen.getByText('Account Balances')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('offers the fold button in every state, only where the page asks for it', () => {
    const onCollapse = vi.fn();
    const data = [{ accountId: 'a1', accountName: 'Checking', balance: 1000 }];
    const { rerender } = render(<AccountBalancesBarChart data={data} isLoading={false} />);
    expect(screen.queryByRole('button', { name: 'Hide chart' })).not.toBeInTheDocument();

    for (const props of [
      { data: [], isLoading: true },
      { data: [], isLoading: false },
      { data, isLoading: false },
    ]) {
      rerender(<AccountBalancesBarChart {...props} onCollapse={onCollapse} />);
      fireEvent.click(screen.getByRole('button', { name: 'Hide chart' }));
    }
    expect(onCollapse).toHaveBeenCalledTimes(3);
  });

  it('shows empty state when no data', () => {
    render(<AccountBalancesBarChart data={[]} isLoading={false} />);
    expect(screen.getByText('No account balance data available')).toBeInTheDocument();
  });

  it('renders bar chart with data and summary footer', () => {
    render(
      <AccountBalancesBarChart
        data={[
          { accountId: 'a1', accountName: 'Checking', balance: 1000 },
          { accountId: 'a2', accountName: 'Savings', balance: 2500 },
          { accountId: 'a3', accountName: 'Credit Card', balance: -500 },
        ]}
        isLoading={false}
      />
    );

    expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
    expect(screen.getByText('Average')).toBeInTheDocument();
    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.getByText('Accounts')).toBeInTheDocument();
  });

  it('renders a download button when data is present, titled after the chart', () => {
    render(
      <AccountBalancesBarChart
        data={[
          { accountId: 'a1', accountName: 'Checking', balance: 1000 },
          { accountId: 'a2', accountName: 'Savings', balance: 2500 },
        ]}
        isLoading={false}
      />
    );

    expect(
      screen.getByRole('button', { name: /download account balances as png/i }),
    ).toBeInTheDocument();
  });

  it('hides the download button in loading and empty states', () => {
    const { rerender } = render(
      <AccountBalancesBarChart data={[]} isLoading={true} />,
    );
    expect(screen.queryByRole('button', { name: /download/i })).not.toBeInTheDocument();

    rerender(<AccountBalancesBarChart data={[]} isLoading={false} />);
    expect(screen.queryByRole('button', { name: /download/i })).not.toBeInTheDocument();
  });

  describe('Y-axis scale toggle', () => {
    const similarData = [
      { accountId: 'a1', accountName: 'A', balance: 1000 },
      { accountId: 'a2', accountName: 'B', balance: 3000 },
      { accountId: 'a3', accountName: 'C', balance: 8000 },
    ];
    const skewedData = [
      { accountId: 'a1', accountName: 'Chequing', balance: 1000 },
      { accountId: 'a2', accountName: 'Savings', balance: 3000 },
      { accountId: 'a3', accountName: 'Mortgage', balance: 250000 },
    ];

    it('renders Auto, Linear, Log buttons with Auto active by default', () => {
      render(<AccountBalancesBarChart data={similarData} isLoading={false} />);

      const auto = screen.getByRole('button', { name: 'Auto' });
      const linear = screen.getByRole('button', { name: 'Linear' });
      const log = screen.getByRole('button', { name: 'Log' });
      expect(auto).toHaveAttribute('aria-pressed', 'true');
      expect(linear).toHaveAttribute('aria-pressed', 'false');
      expect(log).toHaveAttribute('aria-pressed', 'false');
    });

    it('sizes the Y axis to its labels without pulling the plot past the card edge', () => {
      render(<AccountBalancesBarChart data={skewedData} isLoading={false} />);
      expect(capturedYAxisProps.width).toBe('auto');
      // A negative left margin shifts the auto-sized axis out of the clipped
      // chart box and cuts off the start of every tick label.
      expect(capturedBarChartMargin.left).toBeGreaterThanOrEqual(0);
    });

    it('Auto mode uses linear scale when balances are similar in magnitude', () => {
      render(<AccountBalancesBarChart data={similarData} isLoading={false} />);
      expect(capturedYAxisProps.scale).toBe('linear');
      expect(capturedYAxisProps.domain).toBeUndefined();
    });

    it('Auto mode switches to log scale when one account dwarfs the others', () => {
      render(<AccountBalancesBarChart data={skewedData} isLoading={false} />);
      expect(capturedYAxisProps.scale).toBe('log');
      expect(capturedYAxisProps.domain).toEqual(['auto', 'auto']);
    });

    it('Auto tooltip exposes the effective scale for discoverability', () => {
      render(<AccountBalancesBarChart data={skewedData} isLoading={false} />);
      expect(screen.getByRole('button', { name: 'Auto' })).toHaveAttribute('title', 'Auto (log)');
    });

    it('clicking Log forces log scale even when the dataset is not skewed', () => {
      render(<AccountBalancesBarChart data={similarData} isLoading={false} />);
      expect(capturedYAxisProps.scale).toBe('linear');

      fireEvent.click(screen.getByRole('button', { name: 'Log' }));

      expect(screen.getByRole('button', { name: 'Log' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('button', { name: 'Auto' })).toHaveAttribute('aria-pressed', 'false');
      expect(capturedYAxisProps.scale).toBe('log');
    });

    it('clicking Linear forces linear scale even when the dataset is skewed', () => {
      render(<AccountBalancesBarChart data={skewedData} isLoading={false} />);
      expect(capturedYAxisProps.scale).toBe('log');

      fireEvent.click(screen.getByRole('button', { name: 'Linear' }));

      expect(screen.getByRole('button', { name: 'Linear' })).toHaveAttribute('aria-pressed', 'true');
      expect(capturedYAxisProps.scale).toBe('linear');
      expect(capturedYAxisProps.domain).toBeUndefined();
    });

    it('clicking Auto after a manual override restores ratio-driven selection', () => {
      render(<AccountBalancesBarChart data={skewedData} isLoading={false} />);

      fireEvent.click(screen.getByRole('button', { name: 'Linear' }));
      expect(capturedYAxisProps.scale).toBe('linear');

      fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
      expect(screen.getByRole('button', { name: 'Auto' })).toHaveAttribute('aria-pressed', 'true');
      expect(capturedYAxisProps.scale).toBe('log');
    });

    it('hides the scale toggle in loading and empty states', () => {
      const { rerender } = render(<AccountBalancesBarChart data={[]} isLoading={true} />);
      expect(screen.queryByRole('button', { name: 'Auto' })).not.toBeInTheDocument();

      rerender(<AccountBalancesBarChart data={[]} isLoading={false} />);
      expect(screen.queryByRole('button', { name: 'Auto' })).not.toBeInTheDocument();
    });
  });

  it('shows correct summary values for positive and negative balances', () => {
    render(
      <AccountBalancesBarChart
        data={[
          { accountId: 'a1', accountName: 'Checking', balance: 1000 },
          { accountId: 'a2', accountName: 'Savings', balance: 2500 },
          { accountId: 'a3', accountName: 'Credit Card', balance: -500 },
        ]}
        isLoading={false}
      />
    );

    // Total = 3000
    expect(screen.getByText('$3000.00')).toBeInTheDocument();
    // Average = 3000 / 3 = 1000
    expect(screen.getByText('$1000.00')).toBeInTheDocument();
    // Accounts count = 3
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('shows negative total when net balance is negative', () => {
    render(
      <AccountBalancesBarChart
        data={[
          { accountId: 'a1', accountName: 'Credit Card', balance: -2000 },
          { accountId: 'a2', accountName: 'Loan', balance: -1000 },
        ]}
        isLoading={false}
      />
    );

    // Total = -3000
    expect(screen.getByText('$-3000.00')).toBeInTheDocument();
    // Average = -1500
    expect(screen.getByText('$-1500.00')).toBeInTheDocument();
  });

  it('avoids floating point drift when summing balances', () => {
    render(
      <AccountBalancesBarChart
        data={[
          { accountId: 'a1', accountName: 'A', balance: 0.1 },
          { accountId: 'a2', accountName: 'B', balance: 0.2 },
        ]}
        isLoading={false}
      />
    );

    // Naive 0.1 + 0.2 === 0.30000000000000004. The component must round to
    // decimal-place precision so the summary renders as $0.30, not $0.30...04.
    expect(screen.getByText('$0.30')).toBeInTheDocument();
    // Average = 0.15
    expect(screen.getByText('$0.15')).toBeInTheDocument();
  });

  it('passes Average and Total through formatCurrency with currencyCode', () => {
    render(
      <AccountBalancesBarChart
        data={[
          { accountId: 'a1', accountName: 'A', balance: 400 },
          { accountId: 'a2', accountName: 'B', balance: 600 },
        ]}
        isLoading={false}
        currencyCode="EUR"
      />
    );

    const calledWith = mockFormatCurrency.mock.calls.map(([n]) => n);
    expect(calledWith).toContain(500);
    expect(calledWith).toContain(1000);

    // Summary footer calls formatCurrency with the currencyCode
    const eurCalls = mockFormatCurrency.mock.calls.filter(
      ([, code]) => code === 'EUR',
    );
    expect(eurCalls.length).toBeGreaterThan(0);
  });

  it('calls onAccountClick with the accountId when a bar is clicked', () => {
    const onAccountClick = vi.fn();
    render(
      <AccountBalancesBarChart
        data={[
          { accountId: 'acc-1', accountName: 'Checking', balance: 1000 },
          { accountId: 'acc-2', accountName: 'Savings', balance: 500 },
        ]}
        isLoading={false}
        onAccountClick={onAccountClick}
      />
    );

    expect(capturedBarOnClick).toBeDefined();

    // Recharts passes the data point directly as the first arg to a Bar's
    // onClick handler.
    capturedBarOnClick?.({ accountId: 'acc-2', accountName: 'Savings', balance: 500, absBalance: 500 });

    expect(onAccountClick).toHaveBeenCalledWith('acc-2');
  });

  it('reads accountId from entry.payload as a fallback', () => {
    const onAccountClick = vi.fn();
    render(
      <AccountBalancesBarChart
        data={[
          { accountId: 'acc-1', accountName: 'Checking', balance: 1000 },
        ]}
        isLoading={false}
        onAccountClick={onAccountClick}
      />
    );

    capturedBarOnClick?.({ payload: { accountId: 'acc-1' } });

    expect(onAccountClick).toHaveBeenCalledWith('acc-1');
  });

  it('fires onAccountClick from BarChart-level clicks (tooltip-highlighted column)', () => {
    const onAccountClick = vi.fn();
    render(
      <AccountBalancesBarChart
        data={[
          { accountId: 'acc-1', accountName: 'Checking', balance: 1000 },
          { accountId: 'acc-2', accountName: 'Savings', balance: 500 },
        ]}
        isLoading={false}
        onAccountClick={onAccountClick}
      />,
    );

    // A click in the column whitespace (above the bar) gives Recharts an
    // activePayload but no direct Bar hit -- it must still fire the filter.
    capturedBarChartOnClick?.({
      activePayload: [
        { payload: { accountId: 'acc-2', accountName: 'Savings', balance: 500, absBalance: 500 } },
      ],
    });

    expect(onAccountClick).toHaveBeenCalledWith('acc-2');
  });

  it('fires onAccountClick when only activeLabel is available (column whitespace)', () => {
    const onAccountClick = vi.fn();
    render(
      <AccountBalancesBarChart
        data={[
          { accountId: 'acc-1', accountName: 'Checking', balance: 1000 },
          { accountId: 'acc-2', accountName: 'Savings', balance: 500 },
        ]}
        isLoading={false}
        onAccountClick={onAccountClick}
      />,
    );

    // Clicks in the highlighted column sometimes populate activeLabel but
    // not activePayload; the handler must fall back to a chartData lookup.
    capturedBarChartOnClick?.({ activeLabel: 'Savings' });

    expect(onAccountClick).toHaveBeenCalledWith('acc-2');
  });

  it('ignores BarChart clicks outside any active column (no activePayload and no activeLabel)', () => {
    const onAccountClick = vi.fn();
    render(
      <AccountBalancesBarChart
        data={[
          { accountId: 'acc-1', accountName: 'Checking', balance: 1000 },
        ]}
        isLoading={false}
        onAccountClick={onAccountClick}
      />,
    );

    capturedBarChartOnClick?.({});
    expect(onAccountClick).not.toHaveBeenCalled();
  });

  it('does not call onAccountClick when no accountId is present on the entry', () => {
    const onAccountClick = vi.fn();
    render(
      <AccountBalancesBarChart
        data={[
          { accountId: 'acc-1', accountName: 'Checking', balance: 1000 },
          { accountId: 'acc-2', accountName: 'Savings', balance: 500 },
        ]}
        isLoading={false}
        onAccountClick={onAccountClick}
      />
    );

    capturedBarOnClick?.({});
    expect(onAccountClick).not.toHaveBeenCalled();
  });

  it('does not register a click handler when onAccountClick is not provided', () => {
    render(
      <AccountBalancesBarChart
        data={[
          { accountId: 'acc-1', accountName: 'Checking', balance: 1000 },
          { accountId: 'acc-2', accountName: 'Savings', balance: 500 },
        ]}
        isLoading={false}
      />
    );

    expect(capturedBarOnClick).toBeUndefined();
    expect(capturedBarChartOnClick).toBeUndefined();
  });

  it('renders each account name in the x-axis dataset', () => {
    // With our recharts mock the axis itself doesn't render text, but the
    // component should still render the expected number of Cells (one per
    // account bar), one for each data point.
    render(
      <AccountBalancesBarChart
        data={[
          { accountId: 'a1', accountName: 'Checking', balance: 100 },
          { accountId: 'a2', accountName: 'Savings', balance: 200 },
          { accountId: 'a3', accountName: 'Loan', balance: -300 },
        ]}
        isLoading={false}
      />
    );

    const cells = screen.getAllByTestId('cell');
    expect(cells).toHaveLength(3);
  });

  it('formats summary with 0 decimal places when formatCurrency returns 0dp (e.g. JPY)', () => {
    mockFormatCurrency.mockImplementation((n: number) => `¥${Math.round(n).toLocaleString('en-US')}`);

    render(
      <AccountBalancesBarChart
        data={[
          { accountId: 'a1', accountName: 'Checking', balance: 60000 },
          { accountId: 'a2', accountName: 'Savings', balance: 40000 },
        ]}
        isLoading={false}
        currencyCode="JPY"
      />
    );

    // Average = 50,000, Total = 100,000
    expect(screen.getByText('¥50,000')).toBeInTheDocument();
    expect(screen.getByText('¥100,000')).toBeInTheDocument();
  });

  describe('x-axis label rotation', () => {
    const buildAccounts = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        accountId: `a${i + 1}`,
        accountName: `Account ${i + 1}`,
        balance: 100 * (i + 1),
      }));

    it('keeps desktop x-axis labels horizontal at or below 10 accounts', () => {
      render(<AccountBalancesBarChart data={buildAccounts(10)} isLoading={false} />);
      expect(capturedXAxisProps.angle).toBe(0);
      expect(capturedXAxisProps.textAnchor).toBe('middle');
      expect(capturedXAxisProps.height).toBe(30);
    });

    it('rotates desktop x-axis labels vertical once account count crosses 10 via a custom tick', () => {
      render(<AccountBalancesBarChart data={buildAccounts(11)} isLoading={false} />);
      // A custom tick renderer handles the rotation so the first character
      // anchors at the axis line (textAnchor='start' + rotate(90)); the
      // XAxis itself no longer sets angle/textAnchor.
      expect(capturedXAxisProps.tick).not.toBe(null);
      expect(typeof capturedXAxisProps.tick).toBe('object');
      expect(capturedXAxisProps.angle).toBe(0);
      expect(capturedXAxisProps.textAnchor).toBe('middle');
      // Reserve enough vertical space for the rotated labels.
      expect(capturedXAxisProps.height).toBeGreaterThan(30);
    });

    it('truncates vertical x-axis labels longer than 15 characters with an ellipsis', () => {
      render(
        <AccountBalancesBarChart
          data={[
            {
              accountId: 'a1',
              accountName: 'A Very Long Account Name That Should Be Truncated',
              balance: 100,
            },
            ...buildAccounts(10),
          ]}
          isLoading={false}
        />,
      );

      // Render the custom tick directly so we can inspect the rendered text.
      const CustomTick = capturedXAxisProps.tick as React.ReactElement<any>;
      const { container } = render(
        <svg>
          {React.cloneElement(CustomTick, {
            x: 0,
            y: 0,
            payload: { value: 'A Very Long Account Name That Should Be Truncated' },
          })}
        </svg>,
      );

      const text = container.querySelector('text');
      expect(text).not.toBeNull();
      expect(text?.textContent).toBe('A Very Long Acc...');
      expect(text?.textContent?.length).toBe(18); // 15 chars + "..."
    });

    it('leaves vertical x-axis labels under 15 characters untouched', () => {
      render(<AccountBalancesBarChart data={buildAccounts(11)} isLoading={false} />);
      const CustomTick = capturedXAxisProps.tick as React.ReactElement<any>;
      const { container } = render(
        <svg>
          {React.cloneElement(CustomTick, {
            x: 0,
            y: 0,
            payload: { value: 'Short Name' },
          })}
        </svg>,
      );
      const text = container.querySelector('text');
      expect(text?.textContent).toBe('Short Name');
    });

    it('uses vertical x-axis labels on mobile regardless of account count', () => {
      mockIsMobile.mockReturnValue(true);
      render(<AccountBalancesBarChart data={buildAccounts(3)} isLoading={false} />);
      // Mobile should use the same custom-tick vertical format as the dense
      // desktop view, not the previous slanted label style.
      expect(typeof capturedXAxisProps.tick).toBe('object');
      expect(capturedXAxisProps.angle).toBe(0);
      expect(capturedXAxisProps.textAnchor).toBe('middle');
      expect(capturedXAxisProps.interval).toBe(0);
      expect(capturedXAxisProps.height).toBeGreaterThan(30);
    });
  });

  it('does not render the tooltip when there is no data', () => {
    render(<AccountBalancesBarChart data={[]} isLoading={false} />);
    expect(screen.queryByTestId('tooltip')).not.toBeInTheDocument();
    expect(screen.queryByTestId('bar-chart')).not.toBeInTheDocument();
  });

  it('surfaces the click cursor style only when onAccountClick is set', () => {
    const { rerender } = render(
      <AccountBalancesBarChart
        data={[
          { accountId: 'a1', accountName: 'Checking', balance: 100 },
          { accountId: 'a2', accountName: 'Savings', balance: 200 },
        ]}
        isLoading={false}
      />,
    );
    // First render without handler
    expect(capturedBarOnClick).toBeUndefined();

    // Re-render with the handler
    const onAccountClick = vi.fn();
    rerender(
      <AccountBalancesBarChart
        data={[
          { accountId: 'a1', accountName: 'Checking', balance: 100 },
          { accountId: 'a2', accountName: 'Savings', balance: 200 },
        ]}
        isLoading={false}
        onAccountClick={onAccountClick}
      />,
    );

    capturedBarOnClick?.({ accountId: 'a1', accountName: 'Checking', balance: 100, absBalance: 100 });
    expect(onAccountClick).toHaveBeenCalledWith('a1');
  });
});
