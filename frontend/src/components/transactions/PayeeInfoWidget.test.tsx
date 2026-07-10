import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@/test/render';
import { PayeeInfoWidget } from './PayeeInfoWidget';
import { Payee } from '@/types/payee';
import { Category } from '@/types/category';
import { ScheduledTransaction } from '@/types/scheduled-transaction';

vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getSummary: vi.fn(),
    getGroupedTotals: vi.fn(),
    getRecurringCharges: vi.fn(),
  },
}));

vi.mock('@/lib/payees', () => ({
  payeesApi: {
    getAliases: vi.fn(),
  },
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (val: number, currency: string) => `${currency} ${val.toFixed(2)}`,
  }),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    convertToDefault: (amount: number) => amount,
    defaultCurrency: 'CAD',
  }),
}));

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

import { transactionsApi } from '@/lib/transactions';
import { payeesApi } from '@/lib/payees';

const mockedTransactions = vi.mocked(transactionsApi);
const mockedPayees = vi.mocked(payeesApi);

const makePayee = (overrides: Partial<Payee> = {}): Payee =>
  ({
    id: 'p-1',
    userId: 'u-1',
    name: 'Hydro One',
    defaultCategoryId: 'c-1',
    defaultCategory: null,
    notes: null,
    isActive: true,
    createdAt: '2024-01-01',
    ...overrides,
  }) as Payee;

const categories: Category[] = [
  { id: 'c-1', parentId: null, name: 'Utilities' } as Category,
  { id: 'c-2', parentId: 'c-1', name: 'Electricity' } as Category,
];

async function renderWidget(props: Partial<Parameters<typeof PayeeInfoWidget>[0]> = {}) {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <PayeeInfoWidget
        payee={makePayee()}
        categories={categories}
        filterParams={{}}
        onEdit={vi.fn()}
        onCollapse={vi.fn()}
        {...props}
      />,
    );
  });
  return result!;
}

describe('PayeeInfoWidget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedTransactions.getSummary.mockResolvedValue({
      totalIncome: 50,
      totalExpenses: 1200.5,
      netCashFlow: -1150.5,
      transactionCount: 12,
      lastTransactionDate: '2026-06-28',
      byCurrency: {
        CAD: { totalIncome: 50, totalExpenses: 1200.5, netCashFlow: -1150.5, transactionCount: 12 },
      },
    });
    mockedTransactions.getGroupedTotals.mockResolvedValue([
      { id: 'c-2', name: 'Electricity', currencyCode: 'CAD', total: -900, count: 9 },
      { id: 'c-1', name: 'Utilities', currencyCode: 'CAD', total: -300.5, count: 3 },
      { id: null, name: null, currencyCode: 'CAD', total: -10, count: 1 },
    ]);
    mockedTransactions.getRecurringCharges.mockResolvedValue([
      {
        payeeName: 'Hydro One',
        payeeId: 'p-hydro',
        amounts: [100, 100, 100.5],
        dates: ['2026-04-28', '2026-05-28', '2026-06-28'],
        frequency: 'monthly',
        currentAmount: 100.5,
        previousAmount: 100,
        categoryName: 'Electricity',
        categoryId: 'c-2',
      },
    ]);
    mockedPayees.getAliases.mockResolvedValue([
      { id: 'al-1', payeeId: 'p-1', userId: 'u-1', alias: 'HYDRO*ONE', createdAt: '2024-01-01' },
    ]);
  });

  it('shows the payee name, period totals and stats', async () => {
    await renderWidget();

    expect(screen.getByText('Hydro One')).toBeInTheDocument();
    expect(screen.getByText('CAD 1200.50')).toBeInTheDocument(); // total spent
    expect(screen.getByText('CAD 50.00')).toBeInTheDocument(); // income
    expect(screen.getByText('12')).toBeInTheDocument(); // count
    // average = (50 + 1200.5) / 12
    expect(screen.getByText('CAD 104.21')).toBeInTheDocument();
    expect(mockedTransactions.getSummary).toHaveBeenCalledWith(
      expect.objectContaining({ payeeIds: ['p-1'] }),
    );
  });

  it('passes the surrounding page filters through to the queries', async () => {
    await renderWidget({
      filterParams: { startDate: '2026-01-01', endDate: '2026-06-30', accountIds: ['a-1'] },
    });

    expect(mockedTransactions.getSummary).toHaveBeenCalledWith({
      startDate: '2026-01-01',
      endDate: '2026-06-30',
      accountIds: ['a-1'],
      payeeIds: ['p-1'],
    });
    expect(mockedTransactions.getRecurringCharges).toHaveBeenCalledWith({
      payeeIds: ['p-1'],
      startDate: '2026-01-01',
      endDate: '2026-06-30',
    });
  });

  it('shows an inactive badge for inactive payees', async () => {
    await renderWidget({ payee: makePayee({ isActive: false }) });
    expect(screen.getByText('Inactive')).toBeInTheDocument();
  });

  it('renders the top categories with full labels and fires the filter callback', async () => {
    const onCategoryClick = vi.fn();
    await renderWidget({ onCategoryClick });

    // Child category shows its "Parent: Child" label; "Utilities" also
    // appears as the default-category detail row, so expect both.
    const electricity = screen.getByText('Utilities: Electricity');
    expect(screen.getAllByText('Utilities').length).toBeGreaterThan(0);
    expect(screen.getByText('Uncategorized')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(electricity);
    });
    expect(onCategoryClick).toHaveBeenCalledWith('c-2');
  });

  it('shows the recurring cadence line', async () => {
    await renderWidget();
    expect(screen.getByText('Recurring: Monthly · CAD 100.50')).toBeInTheDocument();
  });

  it('hides the recurring line when cadence is irregular', async () => {
    mockedTransactions.getRecurringCharges.mockResolvedValue([]);
    await renderWidget();
    expect(screen.queryByText(/Recurring:/)).not.toBeInTheDocument();
  });

  it('shows aliases and notes', async () => {
    await renderWidget({ payee: makePayee({ notes: 'Provincial power utility' }) });
    expect(screen.getByText('HYDRO*ONE')).toBeInTheDocument();
    expect(screen.getByText('Provincial power utility')).toBeInTheDocument();
  });

  it('resolves the default category name from the categories list', async () => {
    await renderWidget();
    expect(screen.getByText('Default Category')).toBeInTheDocument();
    // c-1 resolves through the label map
    expect(screen.getAllByText('Utilities').length).toBeGreaterThan(0);
  });

  it('surfaces the soonest scheduled bill for this payee', async () => {
    const scheduled = [
      {
        id: 'st-1',
        accountId: 'a-1',
        payeeId: 'p-1',
        payee: null,
        payeeName: 'Hydro One',
        amount: -120,
        currencyCode: 'CAD',
        nextDueDate: '2026-07-28',
        isActive: true,
        nextOverride: null,
      } as unknown as ScheduledTransaction,
    ];
    await renderWidget({ scheduledTransactions: scheduled });

    expect(screen.getByText('Next Bill')).toBeInTheDocument();
    expect(screen.getByText('CAD 120.00')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTitle('View in Bills & Deposits'));
    });
    expect(mockPush).toHaveBeenCalledWith('/bills');
  });

  it('shows the empty state when the period has no transactions', async () => {
    mockedTransactions.getSummary.mockResolvedValue({
      totalIncome: 0,
      totalExpenses: 0,
      netCashFlow: 0,
      transactionCount: 0,
      lastTransactionDate: null,
      byCurrency: {},
    });
    mockedTransactions.getGroupedTotals.mockResolvedValue([]);
    mockedTransactions.getRecurringCharges.mockResolvedValue([]);
    mockedPayees.getAliases.mockResolvedValue([]);

    await renderWidget();
    await waitFor(() =>
      expect(screen.getByText('No transactions in this period')).toBeInTheDocument(),
    );
  });

  it('fires the edit and collapse callbacks', async () => {
    const onEdit = vi.fn();
    const onCollapse = vi.fn();
    await renderWidget({ onEdit, onCollapse });

    fireEvent.click(screen.getByLabelText('Edit payee'));
    expect(onEdit).toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('Hide payee info'));
    expect(onCollapse).toHaveBeenCalled();
  });
});
