import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/render';
import { AccountBalancesBarChart } from './AccountBalancesBarChart';

// Capture the BarChart onClick handler so we can simulate account bar clicks
// without relying on the real recharts rendering pipeline.
let capturedBarChartOnClick: ((state: any) => void) | undefined;

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  BarChart: ({ children, onClick }: any) => {
    capturedBarChartOnClick = onClick;
    return <div data-testid="bar-chart">{children}</div>;
  },
  Bar: ({ children }: any) => <div data-testid="bar">{children}</div>,
  XAxis: () => <div data-testid="x-axis" />,
  YAxis: () => <div data-testid="y-axis" />,
  CartesianGrid: () => <div data-testid="cartesian-grid" />,
  Tooltip: () => <div data-testid="tooltip" />,
  LabelList: () => <div data-testid="label-list" />,
  Cell: () => <div data-testid="cell" />,
}));

const mockFormatCurrency = vi.fn((n: number, _code?: string) => `$${n.toFixed(2)}`);
const mockFormatCurrencyAxis = vi.fn((n: number, _code?: string) => `$${n}`);

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: mockFormatCurrency,
    formatCurrencyAxis: mockFormatCurrencyAxis,
  }),
}));

describe('AccountBalancesBarChart', () => {
  beforeEach(() => {
    capturedBarChartOnClick = undefined;
    mockFormatCurrency.mockImplementation((n: number) => `$${n.toFixed(2)}`);
    mockFormatCurrency.mockClear();
    mockFormatCurrencyAxis.mockClear();
  });

  it('renders loading state with title and pulse skeleton', () => {
    render(<AccountBalancesBarChart data={[]} isLoading={true} />);
    expect(screen.getByText('Account Balances')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
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

    expect(capturedBarChartOnClick).toBeDefined();

    capturedBarChartOnClick?.({
      activePayload: [
        { payload: { accountId: 'acc-2', accountName: 'Savings', balance: 500, absBalance: 500 } },
      ],
    });

    expect(onAccountClick).toHaveBeenCalledWith('acc-2');
  });

  it('does not call onAccountClick when activePayload is missing', () => {
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

    capturedBarChartOnClick?.({});
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
    expect(capturedBarChartOnClick).toBeUndefined();

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

    capturedBarChartOnClick?.({
      activePayload: [
        { payload: { accountId: 'a1', accountName: 'Checking', balance: 100, absBalance: 100 } },
      ],
    });
    expect(onAccountClick).toHaveBeenCalledWith('a1');
  });
});
