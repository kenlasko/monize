import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { IncomeExpensesBarChart } from './IncomeExpensesBarChart';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  BarChart: ({ children }: any) => <div data-testid="bar-chart">{children}</div>,
  Bar: ({ dataKey, onClick }: any) => (
    <button data-testid={`bar-${dataKey}`} onClick={() => onClick?.({ payload: { startDate: '2026-02-17', endDate: '2026-02-23' } })} />
  ),
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

vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: vi.fn((selector: any) => selector({ preferences: { weekStartsOn: 1 } })),
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
    expect(screen.getByText('Last 5 weeks')).toBeInTheDocument();
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

  it('skips investment account transactions', () => {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    const transactions = [
      {
        id: '1', amount: -500, currencyCode: 'CAD', isTransfer: false,
        transactionDate: dateStr,
        account: { accountType: 'INVESTMENT' },
      },
      {
        id: '2', amount: 1000, currencyCode: 'CAD', isTransfer: false,
        transactionDate: dateStr,
        account: { accountType: 'INVESTMENT' },
      },
    ] as any[];

    render(<IncomeExpensesBarChart transactions={transactions} isLoading={false} />);
    // All values should be zero since investment transactions are skipped
    const zeroValues = screen.getAllByText('$0');
    expect(zeroValues.length).toBe(3);
  });

  it('includes non-investment account transactions', () => {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    const transactions = [
      {
        id: '1', amount: -300, currencyCode: 'CAD', isTransfer: false,
        transactionDate: dateStr,
        account: { accountType: 'CHECKING' },
      },
      {
        id: '2', amount: -200, currencyCode: 'CAD', isTransfer: false,
        transactionDate: dateStr,
        account: { accountType: 'INVESTMENT' },
      },
    ] as any[];

    render(<IncomeExpensesBarChart transactions={transactions} isLoading={false} />);
    // Only the CHECKING transaction ($300 expense) should be counted
    expect(screen.getByText('$300')).toBeInTheDocument();
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

  it('classifies by category isIncome instead of amount sign', () => {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    const transactions = [
      {
        id: '1', amount: 5000, currencyCode: 'CAD', isTransfer: false,
        transactionDate: dateStr,
        category: { isIncome: true },
      },
      {
        id: '2', amount: -500, currencyCode: 'CAD', isTransfer: false,
        transactionDate: dateStr,
        category: { isIncome: false },
      },
    ] as any[];

    render(<IncomeExpensesBarChart transactions={transactions} isLoading={false} />);
    expect(screen.getByText('$5000')).toBeInTheDocument();
    expect(screen.getByText('$500')).toBeInTheDocument();
    expect(screen.getByText('$4500')).toBeInTheDocument();
  });

  it('counts expense refunds as reducing expenses', () => {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    const transactions = [
      {
        id: '1', amount: -500, currencyCode: 'CAD', isTransfer: false,
        transactionDate: dateStr,
        category: { isIncome: false },
      },
      {
        id: '2', amount: 400, currencyCode: 'CAD', isTransfer: false,
        transactionDate: dateStr,
        category: { isIncome: false },
      },
    ] as any[];

    render(<IncomeExpensesBarChart transactions={transactions} isLoading={false} />);
    // Net expense: 500 - 400 = 100
    expect(screen.getByText('$100')).toBeInTheDocument();
  });

  it('classifies split transactions by split category', () => {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    const transactions = [
      {
        id: '1', amount: 1000, currencyCode: 'CAD', isTransfer: false,
        transactionDate: dateStr,
        category: null,
        splits: [
          { id: 's1', amount: 700, category: { isIncome: true }, transferAccountId: null },
          { id: 's2', amount: 300, category: { isIncome: false }, transferAccountId: null },
        ],
      },
    ] as any[];

    render(<IncomeExpensesBarChart transactions={transactions} isLoading={false} />);
    // Income: 700 from income split
    // Expenses: -300 (positive amount on expense category reduces expenses, so -300)
    // But since expenses can't go below 0 in display, net = 700 - (-300) = 1000
    expect(screen.getByText('$700')).toBeInTheDocument();
  });

  it('skips transfer splits in split transactions', () => {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    const transactions = [
      {
        id: '1', amount: 1000, currencyCode: 'CAD', isTransfer: false,
        transactionDate: dateStr,
        category: null,
        splits: [
          { id: 's1', amount: 600, category: { isIncome: true }, transferAccountId: null },
          { id: 's2', amount: 400, category: { isIncome: true }, transferAccountId: 'acc-123' },
        ],
      },
    ] as any[];

    render(<IncomeExpensesBarChart transactions={transactions} isLoading={false} />);
    // Only s1 counted (600 income), s2 skipped due to transferAccountId
    // $600 appears twice (Income and Net), expenses should be $0
    const amountEls = screen.getAllByText('$600');
    expect(amountEls.length).toBe(2);
    expect(screen.getByText('$0')).toBeInTheDocument();
  });

  it('falls back to sign-based for uncategorized transactions', () => {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    const transactions = [
      {
        id: '1', amount: 300, currencyCode: 'CAD', isTransfer: false,
        transactionDate: dateStr,
        category: null,
      },
      {
        id: '2', amount: -100, currencyCode: 'CAD', isTransfer: false,
        transactionDate: dateStr,
        category: null,
      },
    ] as any[];

    render(<IncomeExpensesBarChart transactions={transactions} isLoading={false} />);
    expect(screen.getByText('$300')).toBeInTheDocument();
    expect(screen.getByText('$100')).toBeInTheDocument();
    expect(screen.getByText('$200')).toBeInTheDocument();
  });

  it('navigates to transactions page with income filter on Income bar click', () => {
    render(<IncomeExpensesBarChart transactions={[]} isLoading={false} />);
    fireEvent.click(screen.getByTestId('bar-Income'));
    expect(mockPush).toHaveBeenCalledWith('/transactions?startDate=2026-02-17&endDate=2026-02-23&categoryType=income');
  });

  it('navigates to transactions page with expense filter on Expenses bar click', () => {
    render(<IncomeExpensesBarChart transactions={[]} isLoading={false} />);
    fireEvent.click(screen.getByTestId('bar-Expenses'));
    expect(mockPush).toHaveBeenCalledWith('/transactions?startDate=2026-02-17&endDate=2026-02-23&categoryType=expense');
  });
});
