import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@/test/render';
import { CategoryInfoWidget } from './CategoryInfoWidget';
import { Category } from '@/types/category';
import { ScheduledTransaction } from '@/types/scheduled-transaction';

vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getSummary: vi.fn(),
    getGroupedTotals: vi.fn(),
  },
}));

vi.mock('@/lib/budgets', () => ({
  budgetsApi: {
    getCategoryBudgetStatus: vi.fn(),
  },
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (val: number, currency: string) => `${currency} ${val.toFixed(2)}`,
    }),
  };
});
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
import { budgetsApi } from '@/lib/budgets';

const mockedTransactions = vi.mocked(transactionsApi);
const mockedBudgets = vi.mocked(budgetsApi);

const makeCategory = (overrides: Partial<Category> = {}): Category =>
  ({
    id: 'c-1',
    userId: 'u-1',
    parentId: null,
    name: 'Food',
    description: null,
    icon: null,
    color: '#ff8800',
    effectiveColor: '#ff8800',
    isIncome: false,
    isSystem: false,
    createdAt: '2024-01-01',
    ...overrides,
  }) as Category;

const categories: Category[] = [
  makeCategory(),
  makeCategory({ id: 'c-2', parentId: 'c-1', name: 'Groceries' }),
  makeCategory({ id: 'c-3', parentId: 'c-1', name: 'Dining Out' }),
  makeCategory({ id: 'c-4', parentId: 'c-2', name: 'Bulk Store' }),
];

async function renderWidget(props: Partial<Parameters<typeof CategoryInfoWidget>[0]> = {}) {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <CategoryInfoWidget
        category={makeCategory()}
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

describe('CategoryInfoWidget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedTransactions.getSummary.mockResolvedValue({
      totalIncome: 0,
      totalExpenses: 800,
      netCashFlow: -800,
      transactionCount: 20,
      lastTransactionDate: '2026-06-20',
      byCurrency: {
        CAD: { totalIncome: 0, totalExpenses: 800, netCashFlow: -800, transactionCount: 20 },
      },
    });
    mockedTransactions.getGroupedTotals.mockImplementation(async ({ groupBy }) =>
      groupBy === 'payee'
        ? [
            { id: 'p-1', name: 'Loblaws', currencyCode: 'CAD', total: -500, count: 10 },
            { id: 'p-2', name: 'Tim Hortons', currencyCode: 'CAD', total: -200, count: 8 },
            { id: null, name: null, currencyCode: 'CAD', total: -100, count: 2 },
          ]
        : [
            // Leaf rows: grandchild rolls up into c-2, plus the category's own bucket
            { id: 'c-4', name: 'Bulk Store', currencyCode: 'CAD', total: -300, count: 4 },
            { id: 'c-2', name: 'Groceries', currencyCode: 'CAD', total: -200, count: 6 },
            { id: 'c-3', name: 'Dining Out', currencyCode: 'CAD', total: -200, count: 8 },
            { id: 'c-1', name: 'Food', currencyCode: 'CAD', total: -100, count: 2 },
          ],
    );
    mockedBudgets.getCategoryBudgetStatus.mockResolvedValue({
      'c-1': { budgeted: 1000, spent: 800, remaining: 200, percentUsed: 80 },
    });
  });

  it('shows the category name, badge, swatch and headline total', async () => {
    await renderWidget();

    expect(screen.getByText('Food')).toBeInTheDocument();
    expect(screen.getByText('Expense')).toBeInTheDocument();
    expect(screen.getByText('Total Spent')).toBeInTheDocument();
    expect(screen.getByText('CAD 800.00')).toBeInTheDocument();
    expect(mockedTransactions.getSummary).toHaveBeenCalledWith(
      expect.objectContaining({ basis:'cash', categoryIds: ['c-1'] }),
    );
  });

  // Issue #1125: the headline read the gross debits, so a refund filed against
  // the category left it disagreeing with the register's own balance for the
  // same filter.
  it('nets a credit filed against an expense category out of the headline', async () => {
    mockedTransactions.getSummary.mockResolvedValue({
      totalIncome: 6.18,
      totalExpenses: 23212.25,
      netCashFlow: -23206.07,
      transactionCount: 41,
      lastTransactionDate: '2026-06-20',
      byCurrency: {
        CAD: {
          totalIncome: 6.18,
          totalExpenses: 23212.25,
          netCashFlow: -23206.07,
          transactionCount: 41,
        },
      },
    });
    await renderWidget();

    expect(screen.getByText('CAD 23206.07')).toBeInTheDocument();
    expect(screen.queryByText('CAD 23212.25')).not.toBeInTheDocument();
  });

  it('nets a debit filed against an income category out of the headline', async () => {
    mockedTransactions.getSummary.mockResolvedValue({
      totalIncome: 5000,
      totalExpenses: 250,
      netCashFlow: 4750,
      transactionCount: 4,
      lastTransactionDate: '2026-06-20',
      byCurrency: {
        CAD: {
          totalIncome: 5000,
          totalExpenses: 250,
          netCashFlow: 4750,
          transactionCount: 4,
        },
      },
    });
    await renderWidget({ category: makeCategory({ isIncome: true }) });

    expect(screen.getByText('CAD 4750.00')).toBeInTheDocument();
    expect(screen.queryByText('CAD 5000.00')).not.toBeInTheDocument();
  });

  it('shows earned labels for income categories and hides the budget bar', async () => {
    await renderWidget({
      category: makeCategory({ isIncome: true }),
    });

    expect(screen.getByText('Income')).toBeInTheDocument();
    expect(screen.getByText('Total Earned')).toBeInTheDocument();
    expect(screen.queryByText("This Month's Budget")).not.toBeInTheDocument();
  });

  it('renders the budget progress with spent of budgeted', async () => {
    await renderWidget();

    expect(screen.getByText("This Month's Budget")).toBeInTheDocument();
    expect(screen.getByText('CAD 800.00 of CAD 1000.00')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '80');
  });

  it('hides the budget section when the category has no active budget', async () => {
    mockedBudgets.getCategoryBudgetStatus.mockResolvedValue({});
    await renderWidget();
    expect(screen.queryByText("This Month's Budget")).not.toBeInTheDocument();
  });

  it('shows the parent breadcrumb for subcategories', async () => {
    await renderWidget({ category: categories[1] }); // Groceries under Food
    expect(screen.getByText('Groceries')).toBeInTheDocument();
    expect(screen.getByText('Food')).toBeInTheDocument();
  });

  it('rolls subcategory shares up to direct children with a This category bucket', async () => {
    const onSubcategoryClick = vi.fn();
    await renderWidget({ onSubcategoryClick });

    // c-4 (300) rolled into c-2 (200) => 500; shares of 800 total
    expect(screen.getByText('CAD 500.00 · 63%')).toBeInTheDocument();
    expect(screen.getByText('Dining Out')).toBeInTheDocument();
    expect(screen.getByText('CAD 200.00 · 25%')).toBeInTheDocument();
    expect(screen.getByText('This category')).toBeInTheDocument();
    expect(screen.getByText('CAD 100.00 · 13%')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByText('Groceries'));
    });
    expect(onSubcategoryClick).toHaveBeenCalledWith('c-2');
  });

  it('renders top payees and fires the payee filter callback', async () => {
    const onPayeeClick = vi.fn();
    await renderWidget({ onPayeeClick });

    expect(screen.getByText('Top Payees')).toBeInTheDocument();
    expect(screen.getByText('Tim Hortons')).toBeInTheDocument();
    expect(screen.getByText('No payee')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByText('Loblaws'));
    });
    expect(onPayeeClick).toHaveBeenCalledWith('p-1');
  });

  it('computes average and monthly average amounts', async () => {
    await renderWidget({
      monthlyTotals: [
        { month: '2026-04', total: -300, count: 8 },
        { month: '2026-05', total: -200, count: 5 },
        { month: '2026-06', total: -300, count: 7 },
      ],
    });

    // average = 800 / 20
    expect(screen.getByText('CAD 40.00')).toBeInTheDocument();
    // monthly average = (300+200+300)/3 (3 consecutive, gap-free months)
    expect(screen.getByText('CAD 266.67')).toBeInTheDocument();
  });

  it('averages spend over elapsed months, including gap months', async () => {
    await renderWidget({
      monthlyTotals: [
        { month: '2026-01', total: -300, count: 4 },
        { month: '2026-04', total: -300, count: 4 },
      ],
    });

    // 4 elapsed months (Jan..Apr): 600 / 4 = 150, not 600 / 2 = 300.
    expect(screen.getByText('CAD 150.00')).toBeInTheDocument();
  });

  it('refetches the summary when refreshKey changes', async () => {
    const { rerender } = await renderWidget({ refreshKey: 0 });
    expect(mockedTransactions.getSummary).toHaveBeenCalledTimes(1);

    await act(async () => {
      rerender(
        <CategoryInfoWidget
          category={makeCategory()}
          categories={categories}
          filterParams={{}}
          refreshKey={1}
          onEdit={vi.fn()}
          onCollapse={vi.fn()}
        />,
      );
    });

    expect(mockedTransactions.getSummary).toHaveBeenCalledTimes(2);
  });

  it('surfaces the next scheduled transaction in the category subtree', async () => {
    const scheduled = [
      {
        id: 'st-1',
        accountId: 'a-1',
        payeeId: 'p-1',
        payee: null,
        payeeName: 'Loblaws',
        categoryId: 'c-4', // grandchild of c-1
        amount: -80,
        currencyCode: 'CAD',
        nextDueDate: '2026-07-10',
        isActive: true,
        nextOverride: null,
      } as unknown as ScheduledTransaction,
    ];
    await renderWidget({ scheduledTransactions: scheduled });

    expect(screen.getByText('Next Scheduled')).toBeInTheDocument();
    expect(screen.getByText('CAD 80.00')).toBeInTheDocument();
  });

  it('shows the empty state and description when the period has no transactions', async () => {
    mockedTransactions.getSummary.mockResolvedValue({
      totalIncome: 0,
      totalExpenses: 0,
      netCashFlow: 0,
      transactionCount: 0,
      lastTransactionDate: null,
      byCurrency: {},
    });
    mockedTransactions.getGroupedTotals.mockResolvedValue([]);
    mockedBudgets.getCategoryBudgetStatus.mockResolvedValue({});

    await renderWidget({
      category: makeCategory({ description: 'Everything edible' }),
    });

    await waitFor(() =>
      expect(screen.getByText('No transactions in this period')).toBeInTheDocument(),
    );
    expect(screen.getByText('Everything edible')).toBeInTheDocument();
  });

  it('fires the edit and collapse callbacks', async () => {
    const onEdit = vi.fn();
    const onCollapse = vi.fn();
    await renderWidget({ onEdit, onCollapse });

    fireEvent.click(screen.getByLabelText('Edit category'));
    expect(onEdit).toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('Hide category info'));
    expect(onCollapse).toHaveBeenCalled();
  });

  it('opens the category detail page from the details button', async () => {
    await renderWidget();

    fireEvent.click(screen.getByLabelText('View category details'));
    expect(mockPush).toHaveBeenCalledWith('/categories/c-1');
  });
  describe('the category glyph', () => {
    /**
     * The glyph sits in the header row beside the name. Scope every assertion
     * to that row: the widget draws other icons further down, so a bare
     * `querySelector('svg')` would pass whether or not the glyph rendered.
     */
    const headerRow = (container: HTMLElement) =>
      container.querySelector('.flex.items-center.gap-3') as HTMLElement;

    it('draws the icon rather than printing its name', async () => {
      // The header used to interpolate `category.icon` into the heading, so a
      // category with an icon read "shopping-cart Bakery".
      const { container } = await renderWidget({
        category: makeCategory({ name: 'Bakery', icon: 'shopping-cart' }),
      });

      expect(screen.queryByText(/shopping-cart/)).toBeNull();
      expect(headerRow(container).querySelector('svg')).toBeTruthy();
      expect(screen.getByText('Bakery')).toBeInTheDocument();
    });

    it('inherits a parent icon when the category has none of its own', async () => {
      const { container } = await renderWidget({
        category: makeCategory({
          name: 'Bakery',
          icon: null,
          effectiveIcon: 'shopping-cart',
        }),
      });

      expect(headerRow(container).querySelector('svg')).toBeTruthy();
      expect(screen.queryByText(/shopping-cart/)).toBeNull();
    });

    it('falls back to the colour dot when there is no icon anywhere', async () => {
      const { container } = await renderWidget({
        category: makeCategory({
          name: 'Bakery',
          icon: null,
          effectiveIcon: null,
          color: '#ff0000',
          effectiveColor: '#ff0000',
        }),
      });

      const row = headerRow(container);
      expect(row.querySelector('svg')).toBeNull();
      expect(row.querySelector('span[class*="rounded-full"]')).toBeTruthy();
    });
  });
});
