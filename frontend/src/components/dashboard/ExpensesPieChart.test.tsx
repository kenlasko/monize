import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@/test/render';
import { ExpensesPieChart } from './ExpensesPieChart';
import type { SpendingByCategoryResponse } from '@/types/built-in-reports';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

// The breakdown is the Spending by Category report's answer. What counts as
// spending -- VOID rows, transfers, investment linkage, refunds netted against
// their category -- is the report's to decide and is tested against the query
// in `spending-reports.service.spec.ts`; this suite covers what the widget does
// with the answer.
const mockGetSpendingByCategory = vi.fn();
vi.mock('@/lib/built-in-reports', () => ({
  builtInReportsApi: {
    getSpendingByCategory: (...args: any[]) => mockGetSpendingByCategory(...args),
  },
}));

const { widgetConfig, mockUpdateConfig } = vi.hoisted(() => ({
  widgetConfig: {
    current: {
      range: '1m',
      accountIds: [] as string[],
      topLevelOnly: false,
      view: 'legend' as 'legend' | 'callouts',
    },
  },
  mockUpdateConfig: vi.fn(),
}));
vi.mock('@/hooks/useWidgetConfig', () => ({
  useWidgetConfig: () => ({
    config: widgetConfig.current,
    updateConfig: mockUpdateConfig,
  }),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  PieChart: ({ children }: any) => <div data-testid="pie-chart">{children}</div>,
  Pie: ({ data, dataKey, onClick }: any) => (
    <div data-testid="pie" style={{ display: 'none' }}>
      {data?.map((d: any, i: number) => (
        <button
          key={i}
          data-testid={`pie-slice-${d.name}`}
          data-weight={typeof dataKey === 'function' ? dataKey(d) : d[dataKey]}
          onClick={() => onClick?.(d, i)}
        />
      ))}
    </div>
  ),
  Cell: () => null,
  Tooltip: () => null,
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrencyCompact: (n: number) => `$${n.toFixed(2)}`,
    }),
  };
});

vi.mock('@/lib/chart-colours', () => ({
  CHART_COLOURS: ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6'],
}));

const category = (
  categoryId: string | null,
  categoryName: string,
  total: number,
  color: string | null = null,
) => ({ categoryId, categoryName, color, total });

/** A complete report answer: nothing excluded, so the total is a total. */
const report = (
  data: SpendingByCategoryResponse['data'],
  over: Partial<SpendingByCategoryResponse> = {},
): SpendingByCategoryResponse => {
  const knownSpending = data.reduce((sum, item) => sum + item.total, 0);
  return {
    data,
    totalSpending: knownSpending,
    knownSpending,
    currency: 'CAD',
    missingCurrencies: [],
    excludedCount: 0,
    ...over,
  };
};

async function renderChart(
  response: SpendingByCategoryResponse | null,
  isLoading = false,
) {
  if (response) mockGetSpendingByCategory.mockResolvedValue(response);
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<ExpensesPieChart accounts={[]} isLoading={isLoading} />);
  });
  return result!;
}

describe('ExpensesPieChart', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockGetSpendingByCategory.mockReset();
    mockUpdateConfig.mockClear();
    widgetConfig.current = { range: '1m', accountIds: [], topLevelOnly: false, view: 'legend' };
  });

  it('renders loading state with title and pulse animation', async () => {
    await renderChart(report([]), true);
    expect(screen.getByText('Expenses by Category')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
    expect(screen.queryByTestId('pie-chart')).not.toBeInTheDocument();
  });

  it('renders the selected timeframe label', async () => {
    await renderChart(report([]));
    expect(screen.getByText('1M')).toBeInTheDocument();
  });

  it('renders empty state when the report finds no spending', async () => {
    await renderChart(report([]));
    await waitFor(() => {
      expect(screen.getByText('No expense data for this period.')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('pie-chart')).not.toBeInTheDocument();
  });

  it('draws the report rows as slices, in the order it returned them', async () => {
    await renderChart(
      report([
        category('cat1', 'Food', 50, '#ef4444'),
        category('cat2', 'Transport', 30, '#3b82f6'),
      ]),
    );

    expect(screen.getByTestId('pie-slice-Food')).toBeInTheDocument();
    expect(screen.getByTestId('pie-slice-Transport')).toBeInTheDocument();
    expect(screen.getByText('Food')).toBeInTheDocument();
    expect(screen.getByText('Transport')).toBeInTheDocument();
  });

  it('draws the supplied shares even when the rounded currency amounts match', async () => {
    await renderChart(report([
      { ...category('one', 'First', 1), percentage: 50.2 },
      { ...category('two', 'Second', 1), percentage: 49.8 },
    ], { netSpending: true }));
    expect(screen.getByTestId('pie-slice-First')).toHaveAttribute('data-weight', '50.2');
    expect(screen.getByTestId('pie-slice-Second')).toHaveAttribute('data-weight', '49.8');
  });

  it('keeps every returned group visible for a refund-dominated period', async () => {
    await renderChart(report([
      category('cat1', 'Food', 30), category('cat2', 'Clothes', -50),
      category('cat3', 'Travel', 0),
    ], { netSpending: true }));
    expect(screen.queryByTestId('pie-chart')).not.toBeInTheDocument();
    for (const amount of ['$30.00', '$-50.00', '$0.00', '$-20.00']) {
      expect(screen.getByText(amount)).toBeInTheDocument();
    }
    expect(screen.queryAllByText(/%/)).toHaveLength(0);
  });

  it('does not let the Other slice conceal a refund in an otherwise positive period', async () => {
    const positive = Array.from({ length: 12 }, (_, i) => category(String(i), `Category ${i}`, 10));
    await renderChart(report([...positive, category('credit', 'Clothes', -1)], { netSpending: true }));

    expect(screen.queryByTestId('pie-chart')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Clothes/ })).toHaveTextContent('$-1.00');
    expect(screen.getByText('$119.00')).toBeInTheDocument();
    expect(screen.queryByText('Other')).not.toBeInTheDocument();
  });

  it('shows each category total beside its legend row', async () => {
    await renderChart(
      report([
        category('cat1', 'Food', 50, '#ef4444'),
        category('cat2', 'Transport', 30, '#3b82f6'),
      ]),
    );

    expect(screen.getByRole('button', { name: /Food/ })).toHaveTextContent('$50.00');
    expect(screen.getByRole('button', { name: /Transport/ })).toHaveTextContent('$30.00');
  });

  it('shows the report total, not a sum it worked out itself', async () => {
    await renderChart(
      report([category('cat1', 'Food', 50), category('cat2', 'Transport', 30)]),
    );
    expect(screen.getByText('$80.00')).toBeInTheDocument();
  });

  it('gives a category with no colour one from the palette', async () => {
    await renderChart(report([category('cat1', 'Food', 50)]));
    // Rendered at all, rather than as an uncoloured slice.
    expect(screen.getByTestId('pie-slice-Food')).toBeInTheDocument();
  });

  it('names the uncategorized bucket the report returned', async () => {
    await renderChart(report([category(null, 'Uncategorized', 40)]));
    expect(screen.getByTestId('pie-slice-Uncategorized')).toBeInTheDocument();
  });

  // --- what the widget asks the report for -------------------------------

  it('asks for the configured window, accounts and rollup', async () => {
    widgetConfig.current = {
      range: '1m',
      accountIds: ['acct-1', 'acct-2'],
      topLevelOnly: true,
      view: 'legend',
    };
    await renderChart(report([]));

    expect(mockGetSpendingByCategory).toHaveBeenCalledWith(
      expect.objectContaining({
        accountIds: ['acct-1', 'acct-2'],
        rollupToParent: true,
      }),
    );
  });

  it('asks for leaf categories when the rollup is off', async () => {
    await renderChart(report([]));
    expect(mockGetSpendingByCategory).toHaveBeenCalledWith(
      expect.objectContaining({ rollupToParent: false }),
    );
  });

  it('sends no account filter for an empty selection', async () => {
    await renderChart(report([]));
    expect(mockGetSpendingByCategory).toHaveBeenCalledWith(
      expect.objectContaining({ accountIds: undefined }),
    );
  });

  // --- partial totals ----------------------------------------------------

  it('marks the total a subtotal when the report excluded a row', async () => {
    await renderChart(
      report([category('cat1', 'Food', 50)], {
        totalSpending: null,
        knownSpending: 50,
        missingCurrencies: ['JPY'],
        excludedCount: 1,
      }),
    );

    // The figure shown is the part that converted, marked rather than presented
    // as the whole.
    const partialTotal = screen.getByTestId('partial-total');
    expect(within(partialTotal).getByText('$50.00')).toBeInTheDocument();
  });

  it('leaves a complete total unmarked', async () => {
    await renderChart(report([category('cat1', 'Food', 50)]));
    expect(screen.queryByTestId('partial-total')).toBeNull();
  });

  // --- Other, and its disclosure -----------------------------------------

  const overflowReport = (count: number) =>
    report(
      Array.from({ length: count }, (_, i) =>
        // Descending so the ordering is unambiguous: the largest keep a slice.
        category(`c${i}`, `Cat ${i}`, (count - i) * 10),
      ),
    );

  it('opens Other into the categories it merged, and closes it again', async () => {
    await renderChart(overflowReport(14));

    expect(screen.getByText('Other')).toBeInTheDocument();
    expect(screen.queryByText('Cat 13')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('pie-slice-Other'));

    expect(screen.getByText('3 categories in Other')).toBeInTheDocument();
    expect(screen.getByText('Cat 11')).toBeInTheDocument();
    expect(screen.getByText('Cat 12')).toBeInTheDocument();
    expect(screen.getByText('Cat 13')).toBeInTheDocument();
    // The chart still shows eleven categories plus Other; opening the tail does
    // not turn it into twenty slivers.
    expect(screen.getByTestId('pie-slice-Cat 0')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('pie-slice-Other'));
    expect(screen.queryByText('Cat 13')).not.toBeInTheDocument();
  });

  it('keeps the total over every category, including the ones inside Other', async () => {
    // 14 categories at 140 down to 10: the donut's total is all of them, which
    // is also what the slices plus Other add up to.
    await renderChart(overflowReport(14));
    expect(screen.getByText('$1050.00')).toBeInTheDocument();
  });

  it('opens the transactions for a category listed inside Other', async () => {
    await renderChart(overflowReport(14));
    fireEvent.click(screen.getByTestId('pie-slice-Other'));
    fireEvent.click(screen.getByText('Cat 12'));

    expect(mockPush).toHaveBeenCalledWith(
      expect.stringContaining('categoryIds=c12'),
    );
  });

  it('closes Other when the categories inside it change', async () => {
    const { rerender } = await renderChart(overflowReport(14));
    fireEvent.click(screen.getByTestId('pie-slice-Other'));
    expect(screen.getByText('Cat 13')).toBeInTheDocument();

    widgetConfig.current = { range: '3m', accountIds: [], topLevelOnly: false, view: 'legend' };
    mockGetSpendingByCategory.mockResolvedValue(overflowReport(13));
    await act(async () => {
      rerender(<ExpensesPieChart accounts={[]} isLoading={false} />);
    });
    await waitFor(() => {
      expect(screen.queryByText('Cat 12')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Other')).toBeInTheDocument();
  });

  // --- drill-down --------------------------------------------------------

  it('opens the transactions for a clicked slice, scoped to the window', async () => {
    await renderChart(report([category('cat1', 'Food', 50)]));
    fireEvent.click(screen.getByTestId('pie-slice-Food'));

    expect(mockPush).toHaveBeenCalledWith(
      expect.stringContaining('categoryIds=cat1'),
    );
    expect(mockPush).toHaveBeenCalledWith(expect.stringContaining('endDate='));
  });

  it('does nothing for a slice with no category to open', async () => {
    await renderChart(report([category(null, 'Uncategorized', 40)]));
    fireEvent.click(screen.getByTestId('pie-slice-Uncategorized'));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('leaves Uncategorized inert even while Other has categories in it', async () => {
    await renderChart(
      report([
        category(null, 'Uncategorized', 500),
        ...Array.from({ length: 12 }, (_, i) => category(`c${i}`, `Cat ${i}`, 200 - i)),
      ]),
    );
    expect(screen.getByRole('button', { name: /Uncategorized/ })).toBeDisabled();
    fireEvent.click(screen.getByTestId('pie-slice-Uncategorized'));
    expect(screen.queryByText(/categories in Other/)).not.toBeInTheDocument();
  });

  // --- views -------------------------------------------------------------

  describe('callout view', () => {
    /** A ResizeObserver that reports the given content box as soon as it observes. */
    function observeAs(width: number, height: number) {
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(private readonly callback: ResizeObserverCallback) {}
          observe() {
            this.callback(
              [{ contentRect: { width, height } } as ResizeObserverEntry],
              this as unknown as ResizeObserver,
            );
          }
          unobserve() {}
          disconnect() {}
        },
      );
    }

    beforeEach(() => {
      widgetConfig.current = { range: '1m', accountIds: [], topLevelOnly: false, view: 'callouts' };
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('boxes the top ten categories and Other inside the chart area', async () => {
      observeAs(560, 300);
      await renderChart(overflowReport(14));

      const callouts = screen.getByRole('list', { name: 'Expenses by Category' });
      const boxes = within(callouts).getAllByRole('listitem');
      expect(boxes).toHaveLength(11);
      expect(within(callouts).getByText('Cat 9')).toBeInTheDocument();
      expect(within(callouts).queryByText('Cat 10')).not.toBeInTheDocument();
      expect(within(callouts).getByText('Other')).toBeInTheDocument();
      for (const box of boxes) {
        expect(parseFloat(box.style.left)).toBeGreaterThanOrEqual(0);
        expect(parseFloat(box.style.top)).toBeGreaterThanOrEqual(0);
        expect(parseFloat(box.style.left) + parseFloat(box.style.width)).toBeLessThanOrEqual(560);
        expect(parseFloat(box.style.top) + parseFloat(box.style.height)).toBeLessThanOrEqual(300);
      }
      // The total stays in the hole, compact so it fits the callout view's
      // smaller one.
      expect(screen.getByText('$1.1K')).toBeInTheDocument();
      expect(screen.queryByText('$1050.00')).not.toBeInTheDocument();
    });

    it('opens a category from its box, and Other into the four it merged', async () => {
      observeAs(560, 300);
      await renderChart(overflowReport(14));
      const callouts = screen.getByRole('list', { name: 'Expenses by Category' });

      fireEvent.click(within(callouts).getByRole('button', { name: /Cat 3/ }));
      expect(mockPush).toHaveBeenCalledWith(expect.stringContaining('categoryIds=c3'));

      fireEvent.click(within(callouts).getByRole('button', { name: /Other/ }));
      expect(screen.getByText('4 categories in Other')).toBeInTheDocument();
    });

    it('falls back to the legend where the boxes would not fit', async () => {
      observeAs(300, 300);
      await renderChart(overflowReport(14));
      expect(screen.queryByRole('list', { name: 'Expenses by Category' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Cat 0/ })).toHaveTextContent('$140.00');
    });
  });

  it('stores the view chosen in the settings', async () => {
    await renderChart(report([category('cat1', 'Food', 50)]));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Configure Expenses by Category' }));
    });
    expect(screen.getByText("Labels need a wider screen. Where they don't fit, the legend is shown.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Labels' }));
    expect(mockUpdateConfig).toHaveBeenCalledWith({ view: 'callouts' });
  });
});
