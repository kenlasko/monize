import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/render';
import { IncomeExpensesBarChart } from './IncomeExpensesBarChart';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  BarChart: ({ children }: any) => <div data-testid="bar-chart">{children}</div>,
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
}));

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: any) => typeof d === 'string' ? d : d.toISOString().slice(0, 10) }),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
    formatCurrencyAxis: (n: number) => `$${n}`,
  }),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    convertToDefault: (n: number) => n,
  }),
}));

vi.mock('@/lib/utils', () => ({
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
  cn: (...args: any[]) => args.filter(Boolean).join(' '),
}));

describe('IncomeExpensesBarChart', () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  it('renders loading state with title and pulse animation', () => {
    render(<IncomeExpensesBarChart transactions={[]} isLoading={true} />);
    expect(screen.getByText('Income vs Expenses')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
    expect(screen.queryByTestId('bar-chart')).not.toBeInTheDocument();
  });

  it('renders chart title and date range when not loading', () => {
    render(<IncomeExpensesBarChart transactions={[]} isLoading={false} />);
    expect(screen.getByText('Income vs Expenses')).toBeInTheDocument();
    expect(screen.getByText('Past 30 days')).toBeInTheDocument();
    expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
  });

  it('shows income, expenses, and net totals in footer', () => {
    render(<IncomeExpensesBarChart transactions={[]} isLoading={false} />);
    expect(screen.getByText('Income')).toBeInTheDocument();
    expect(screen.getByText('Expenses')).toBeInTheDocument();
    expect(screen.getByText('Net')).toBeInTheDocument();
  });

  it('calculates income and expenses from transactions', () => {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    const transactions = [
      {
        id: '1', amount: 500, currencyCode: 'CAD', isTransfer: false,
        transactionDate: dateStr,
      },
      {
        id: '2', amount: -200, currencyCode: 'CAD', isTransfer: false,
        transactionDate: dateStr,
      },
    ] as any[];

    render(<IncomeExpensesBarChart transactions={transactions} isLoading={false} />);
    // Net = 500 - 200 = 300
    expect(screen.getByText('$500')).toBeInTheDocument();
    expect(screen.getByText('$200')).toBeInTheDocument();
    expect(screen.getByText('$300')).toBeInTheDocument();
  });

  it('skips transfer transactions', () => {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    const transactions = [
      {
        id: '1', amount: -100, currencyCode: 'CAD', isTransfer: true,
        transactionDate: dateStr,
      },
    ] as any[];

    render(<IncomeExpensesBarChart transactions={transactions} isLoading={false} />);
    // All values should be zero since transfer is skipped
    const zeroValues = screen.getAllByText('$0');
    expect(zeroValues.length).toBe(3);
  });

  it('applies green color class for positive net', () => {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    const transactions = [
      { id: '1', amount: 1000, currencyCode: 'CAD', isTransfer: false, transactionDate: dateStr },
    ] as any[];

    render(<IncomeExpensesBarChart transactions={transactions} isLoading={false} />);
    // Income = $1000, Expenses = $0, Net = $1000
    // $1000 appears twice (Income and Net), both green
    const amountEls = screen.getAllByText('$1000');
    expect(amountEls.length).toBe(2);
    // Both should have green text styling
    amountEls.forEach(el => {
      expect(el.className).toContain('text-green');
    });
  });

  it('renders responsive container with bar chart', () => {
    render(<IncomeExpensesBarChart transactions={[]} isLoading={false} />);
    expect(screen.getByTestId('responsive-container')).toBeInTheDocument();
    expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
  });
});
