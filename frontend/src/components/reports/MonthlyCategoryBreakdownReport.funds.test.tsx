import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { within } from '@testing-library/react';
import { MonthlyCategoryBreakdownReport } from './MonthlyCategoryBreakdownReport';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number) => `$${n.toFixed(2)}`,
      formatPercent: (n: number, d = 1) => `${n.toFixed(d)}%`,
      defaultCurrency: 'USD',
    }),
  };
});

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({
    formatDate: (d: string) => d,
    formatMonth: (m: string) => {
      const [year, mon] = m.split('-');
      return `${mon}/${year}`;
    },
    dateFormat: 'MM/DD/YYYY',
    datePattern: 'MM/DD/YYYY',
  }),
}));

vi.mock('@/hooks/useDateRange', () => ({
  useDateRange: () => ({
    dateRange: '6m',
    setDateRange: vi.fn(),
    startDate: '',
    setStartDate: vi.fn(),
    endDate: '',
    setEndDate: vi.fn(),
    resolvedRange: { start: '2025-01-15', end: '2025-06-30' },
    isValid: true,
  }),
}));

vi.mock('@/components/ui/DateRangeSelector', () => ({
  DateRangeSelector: () => <div data-testid="date-range-selector" />,
}));

const mockGetMonthly = vi.fn();
const mockGetIncomeVsExpenses = vi.fn();
// The fixtures write monthly cells; `serveBreakdown` answers them as the
// server does, folded to the period asked for and with its totals.
vi.mock('@/lib/built-in-reports', async () => {
  const { serveBreakdown } = await import('@/test/monthly-breakdown-fixture');
  return {
    builtInReportsApi: {
      getMonthlyCategoryBreakdown: (...args: unknown[]) =>
        Promise.resolve(mockGetMonthly(...args)).then((fixture) =>
          serveBreakdown(fixture, args[0] as never),
        ),
      getIncomeVsExpenses: (...args: unknown[]) => mockGetIncomeVsExpenses(...args),
    },
  };
});

const mockGetAllAccounts = vi.fn();
vi.mock('@/lib/accounts', () => ({
  accountsApi: { getAll: (...args: unknown[]) => mockGetAllAccounts(...args) },
}));
const mockGetAllTags = vi.fn();
vi.mock('@/lib/tags', () => ({
  tagsApi: { getAll: (...args: unknown[]) => mockGetAllTags(...args) },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const ACCOUNT = '11111111-1111-4111-8111-111111111111';

const MONTHLY = {
  currency: 'USD',
  months: ['2025-01', '2025-02'],
  data: [
    {
      categoryId: 'cat-groceries',
      categoryName: 'Groceries',
      parentId: 'cat-food',
      parentName: 'Food',
      parentIsIncome: false,
      isIncome: false,
      valuesByMonth: { '2025-01': 100, '2025-02': 200 },
      depositTotal: 0,
      withdrawalTotal: 300,
    },
  ],
  transfers: [],
};

const totals = { income: 6279, expenses: 8586, net: -2307, knownIncome: 6279, knownExpenses: 8586, knownNet: -2307 };
const period = (p: string, income: number, expenses: number) => ({
  period: p,
  periodStart: `${p}-01`,
  periodEnd: `${p}-28`,
  income,
  expenses,
  net: income - expenses,
});
const flow = (p: string, taggedInflows: number, taggedOutflows = 0) => ({
  ...period(p, 0, 0),
  taggedInflows,
  taggedOutflows,
});
const funding = (over: Record<string, unknown> = {}, bucketOver: Record<string, unknown> = {}) => ({
  data: [period('2025-01', 3000, 100), period('2025-02', 3279, 8486)],
  totals,
  currency: 'USD',
  missingCurrencies: [],
  excludedCount: 0,
  tagKey: 'scope',
  buckets: [
    {
      value: 'household',
      isUntagged: false,
      data: [flow('2025-01', 0), flow('2025-02', 4516)],
      totals,
      taggedInflows: 4516,
      taggedOutflows: 0,
      missingCurrencies: [],
      excludedCount: 0,
      ...bucketOver,
    },
  ],
  ...over,
});

async function renderReport() {
  await act(async () => {
    render(<MonthlyCategoryBreakdownReport />);
  });
  await waitFor(() => expect(screen.getByText('Groceries')).toBeInTheDocument());
}

async function chooseScopeHousehold() {
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Break down by tag key'), { target: { value: 'scope' } });
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Tag value'), { target: { value: 'household' } });
  });
}
const turnSwitchOn = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('switch', { name: 'Include tagged transfers' }));
  });
};

describe('MonthlyCategoryBreakdownReport funding view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockGetMonthly.mockResolvedValue(MONTHLY);
    mockGetAllAccounts.mockResolvedValue([]);
    mockGetAllTags.mockResolvedValue([{ id: 't1', name: 'scope:household' }]);
  });

  it("is today's request with no key: no account scope, no funding call, no summary", async () => {
    mockGetAllTags.mockResolvedValue([]);
    await renderReport();
    expect(mockGetMonthly).toHaveBeenCalledWith({ startDate: '2025-01-01', endDate: '2025-06-30', period: 'month' });
    expect(mockGetIncomeVsExpenses).not.toHaveBeenCalled();
    expect(screen.queryByTestId('monthly-tagged-balance')).not.toBeInTheDocument();
  });

  it('changes nothing with a key and a value chosen but the switch off', async () => {
    await renderReport();
    await chooseScopeHousehold();
    expect(mockGetMonthly).toHaveBeenLastCalledWith({ startDate: '2025-01-01', endDate: '2025-06-30', period: 'month' });
    expect(mockGetIncomeVsExpenses).not.toHaveBeenCalled();
    expect(screen.queryByTestId('monthly-tagged-balance')).not.toBeInTheDocument();
  });

  it('shows the per-month Balance block: 3,279 + 4,516 - 8,486 = -691, -8.86%', async () => {
    mockGetIncomeVsExpenses.mockResolvedValue(funding());
    await renderReport();
    await chooseScopeHousehold();
    await turnSwitchOn();

    await waitFor(() => expect(screen.getByTestId('monthly-tagged-balance').querySelector('table')).toBeTruthy());
    // The same window the table uses, snapped to the first of the month.
    expect(mockGetIncomeVsExpenses).toHaveBeenCalledWith({
      startDate: '2025-01-01',
      endDate: '2025-06-30',
      bucket: 'month',
      tagKey: 'scope',
    });
    const block = within(screen.getByTestId('monthly-tagged-balance'));
    const row = (label: string) => block.getByText(label).closest('tr') as HTMLElement;
    expect(row('Income')).toHaveTextContent('$3000.00');
    expect(row('Income')).toHaveTextContent('$3279.00');
    expect(row('Tagged inflows')).toHaveTextContent('$4516.00');
    expect(row('Expenses')).toHaveTextContent('$8486.00');
    expect(row('Balance')).toHaveTextContent('$-691.00');
    expect(row('Balance %')).toHaveTextContent('-8.86%');
    // January had no tagged inflow: income minus expenses.
    expect(row('Balance')).toHaveTextContent('$2900.00');
    // No tagged outflow in any month: the row is not drawn.
    expect(block.queryByText('Tagged outflows')).toBeNull();
  });

  it('shows the Balance block per year in the yearly view: 6,279 + 4,516 - 8,586 = 2,209', async () => {
    window.localStorage.setItem('monize-reports-monthly-category-breakdown-period', '"year"');
    // Asked for years, the server answers one period per year, its months
    // folded before it is read (issue #2413).
    const year = (income: number, expenses: number) => ({
      ...period('2025', income, expenses),
      periodStart: '2025-01-01',
      periodEnd: '2025-12-31',
    });
    mockGetIncomeVsExpenses.mockResolvedValue(
      funding(
        { data: [year(6279, 8586)] },
        { data: [{ ...year(0, 0), taggedInflows: 4516, taggedOutflows: 0 }] },
      ),
    );
    await renderReport();
    await chooseScopeHousehold();
    await turnSwitchOn();

    await waitFor(() => expect(screen.getByTestId('monthly-tagged-balance').querySelector('table')).toBeTruthy());
    expect(screen.getByText('Balance by year, including tagged transfers: household')).toBeInTheDocument();
    const block = within(screen.getByTestId('monthly-tagged-balance'));
    expect(block.getByText('2025')).toBeInTheDocument();
    const row = (label: string) => block.getByText(label).closest('tr') as HTMLElement;
    expect(row('Income')).toHaveTextContent('$6279.00');
    expect(row('Tagged inflows')).toHaveTextContent('$4516.00');
    expect(row('Expenses')).toHaveTextContent('$8586.00');
    expect(row('Balance')).toHaveTextContent('$2209.00');
    // 2,209 / (6,279 + 4,516).
    expect(row('Balance %')).toHaveTextContent('20.46%');
    expect(mockGetIncomeVsExpenses).toHaveBeenLastCalledWith(
      expect.objectContaining({ bucket: 'year' }),
    );
  });

  it('draws the Tagged outflows row once a shown month has some', async () => {
    mockGetIncomeVsExpenses.mockResolvedValue(
      funding({}, { data: [flow('2025-01', 0, 300), flow('2025-02', 4516)] }),
    );
    await renderReport();
    await chooseScopeHousehold();
    await turnSwitchOn();
    await waitFor(() => expect(screen.getByText('Tagged outflows')).toBeInTheDocument());
  });

  it('never adds a transfer to the category table: its figures are the report response', async () => {
    mockGetIncomeVsExpenses.mockResolvedValue(funding());
    await renderReport();
    const before = screen.getByText('Groceries').closest('tr')!.textContent;
    await chooseScopeHousehold();
    await turnSwitchOn();
    await waitFor(() => expect(screen.getByTestId('monthly-tagged-balance').querySelector('table')).toBeTruthy());
    expect(screen.getByText('Groceries').closest('tr')!.textContent).toBe(before);
  });

  it('shows a month the funding answer does not cover as unknown, not zero', async () => {
    mockGetIncomeVsExpenses.mockResolvedValue(funding({ data: [period('2025-01', 3000, 100)] }));
    await renderReport();
    await chooseScopeHousehold();
    await turnSwitchOn();
    await waitFor(() => expect(screen.getByTestId('monthly-tagged-balance').querySelector('table')).toBeTruthy());
    const block = within(screen.getByTestId('monthly-tagged-balance'));
    const balanceRow = block.getByText('Balance').closest('tr') as HTMLElement;
    const cells = within(balanceRow).getAllByRole('cell');
    expect(cells[1]).toHaveTextContent('$2900.00');
    expect(cells[2]).toHaveTextContent('\u2014');
  });

  it('marks Balance partial, withholds the percentage and says why when a rate is missing', async () => {
    mockGetIncomeVsExpenses.mockResolvedValue(funding({ missingCurrencies: ['EUR'], excludedCount: 1 }));
    await renderReport();
    await chooseScopeHousehold();
    await turnSwitchOn();
    await waitFor(() => expect(screen.getByTestId('monthly-tagged-balance').querySelector('table')).toBeTruthy());
    const block = within(screen.getByTestId('monthly-tagged-balance'));
    expect(block.getByText('Balance').closest('tr')).toHaveTextContent('$-691.00*');
    expect(block.getByText('Balance %').closest('tr')).not.toHaveTextContent('%*');
    expect(block.getByText('Balance %').closest('tr')).not.toHaveTextContent('-8.86');
    expect(block.getByText(/no exchange rate for EUR/)).toBeInTheDocument();
  });

  it('says so when the funding request fails, leaving the table in place', async () => {
    mockGetIncomeVsExpenses.mockRejectedValue(new Error('boom'));
    await renderReport();
    await chooseScopeHousehold();
    await turnSwitchOn();
    await waitFor(() =>
      expect(screen.getByText('The tagged transfer figures could not be loaded.')).toBeInTheDocument(),
    );
    expect(screen.getByText('Groceries')).toBeInTheDocument();
  });

  it('sends the account filter to the report and to the funding fetch', async () => {
    mockGetAllAccounts.mockResolvedValue([
      { id: ACCOUNT, name: 'Checking', accountType: 'CHEQUING', isClosed: false },
    ]);
    window.localStorage.setItem(
      'monize-reports-monthly-category-breakdown-accounts',
      JSON.stringify([ACCOUNT]),
    );
    mockGetIncomeVsExpenses.mockResolvedValue(funding());
    await renderReport();
    expect(mockGetMonthly).toHaveBeenLastCalledWith({
      startDate: '2025-01-01',
      endDate: '2025-06-30',
      period: 'month',
      accountIds: [ACCOUNT],
    });
    await chooseScopeHousehold();
    await turnSwitchOn();
    await waitFor(() => expect(mockGetIncomeVsExpenses).toHaveBeenCalled());
    expect(mockGetIncomeVsExpenses).toHaveBeenLastCalledWith({
      startDate: '2025-01-01',
      endDate: '2025-06-30',
      bucket: 'month',
      tagKey: 'scope',
      accountIds: [ACCOUNT],
    });
  });
});
