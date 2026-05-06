import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { FlexGroupAnalysisReport } from './FlexGroupAnalysisReport';
import type { Budget, FlexGroupStatus } from '@/types/budget';

const mockGetAll = vi.fn();
const mockGetFlexGroupStatus = vi.fn();
const mockExportToPdf = vi.fn();

vi.mock('@/lib/budgets', () => ({
  budgetsApi: {
    getAll: (...args: any[]) => mockGetAll(...args),
    getFlexGroupStatus: (...args: any[]) => mockGetFlexGroupStatus(...args),
  },
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    formatCurrencyCompact: (n: number) => `$${Math.round(n)}`,
    formatCurrencyAxis: (n: number) => `$${n}`,
    defaultCurrency: 'USD',
  }),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: (...args: any[]) => mockExportToPdf(...args),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  BarChart: ({ children }: any) => <div data-testid="bar-chart">{children}</div>,
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Legend: () => null,
  ReferenceLine: () => null,
  Tooltip: ({ content }: any) => {
    const C = content;
    if (!C) return null;
    const samples = [
      { active: true, payload: [{ dataKey: 'spent', name: 'Spent', color: '#3b82f6', value: 500 }], label: 'tip-x' },
      { active: false, payload: [], label: '' },
      { active: true, payload: [], label: 'empty' },
    ];
    return <div>{samples.map((s, i) => <div key={i}>{C(s)}</div>)}</div>;
  },
}));

const makeBudget = (overrides: Partial<Budget> = {}): Budget =>
  ({ id: 'b-1', name: 'Default', isActive: true, ...overrides } as Budget);

const makeGroup = (
  groupName: string,
  categories: { id: string; name: string; budgeted: number; spent: number }[],
): FlexGroupStatus => {
  const totalBudgeted = categories.reduce((s, c) => s + c.budgeted, 0);
  const totalSpent = categories.reduce((s, c) => s + c.spent, 0);
  return {
    groupName,
    totalBudgeted,
    totalSpent,
    remaining: totalBudgeted - totalSpent,
    percentUsed: totalBudgeted > 0 ? Math.round((totalSpent / totalBudgeted) * 100) : 0,
    categories: categories.map((c) => ({
      categoryId: c.id,
      categoryName: c.name,
      budgeted: c.budgeted,
      spent: c.spent,
      percentUsed: c.budgeted > 0 ? Math.round((c.spent / c.budgeted) * 100) : 0,
    })),
  };
};

async function renderReport() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<FlexGroupAnalysisReport />);
  });
  return result!;
}

describe('FlexGroupAnalysisReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExportToPdf.mockResolvedValue(undefined);
  });

  it('renders loading skeleton', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetFlexGroupStatus.mockReturnValue(new Promise(() => {}));
    let container: HTMLElement;
    await act(async () => {
      const r = render(<FlexGroupAnalysisReport />);
      container = r.container;
    });
    expect(container!.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders no-budgets state', async () => {
    mockGetAll.mockResolvedValue([]);
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText(/No budgets found/i)).toBeInTheDocument();
    });
  });

  it('renders no-flex-groups state', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetFlexGroupStatus.mockResolvedValue([]);
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText(/No flex groups configured/i)).toBeInTheDocument();
    });
  });

  it('renders multiple flex groups covering all status colors (over/warn/ok)', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetFlexGroupStatus.mockResolvedValue([
      makeGroup('Wants', [
        { id: 'c1', name: 'Dining', budgeted: 100, spent: 130 }, // over
        { id: 'c2', name: 'Movies', budgeted: 100, spent: 90 }, // warn (90%)
        { id: 'c3', name: 'Books', budgeted: 100, spent: 50 }, // ok (50%)
      ]),
      makeGroup('Needs', [
        { id: 'c4', name: 'Rent', budgeted: 1000, spent: 1000 },
      ]),
    ]);
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Wants')).toBeInTheDocument();
    });
    expect(screen.getByText('Needs')).toBeInTheDocument();
    expect(screen.getByText('Dining')).toBeInTheDocument();
    expect(screen.getByText('Rent')).toBeInTheDocument();
  });

  it('falls back to first budget when no active', async () => {
    mockGetAll.mockResolvedValue([
      makeBudget({ id: 'a', isActive: false }),
      makeBudget({ id: 'b', isActive: false }),
    ]);
    mockGetFlexGroupStatus.mockResolvedValue([]);
    await renderReport();
    await waitFor(() => expect(mockGetFlexGroupStatus).toHaveBeenCalledWith('a'));
  });

  it('switches budget in no-flex-groups state', async () => {
    mockGetAll.mockResolvedValue([
      makeBudget({ id: 'b-1' }),
      makeBudget({ id: 'b-2', isActive: false }),
    ]);
    mockGetFlexGroupStatus.mockResolvedValue([]);
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText(/No flex groups configured/i)).toBeInTheDocument();
    });
    const select = document.querySelector('select')!;
    await act(async () => { fireEvent.change(select, { target: { value: 'b-2' } }); });
    await waitFor(() => expect(mockGetFlexGroupStatus).toHaveBeenCalledWith('b-2'));
  });

  it('switches budget in populated state', async () => {
    mockGetAll.mockResolvedValue([
      makeBudget({ id: 'b-1' }),
      makeBudget({ id: 'b-2', isActive: false }),
    ]);
    mockGetFlexGroupStatus.mockResolvedValue([
      makeGroup('Wants', [{ id: 'c', name: 'Cat', budgeted: 100, spent: 50 }]),
    ]);
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Wants')).toBeInTheDocument();
    });
    const select = document.querySelector('select')!;
    await act(async () => { fireEvent.change(select, { target: { value: 'b-2' } }); });
    await waitFor(() => expect(mockGetFlexGroupStatus).toHaveBeenCalledWith('b-2'));
  });

  it('handles fetch error gracefully', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetFlexGroupStatus.mockRejectedValue(new Error('boom'));
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText(/No flex groups configured/i)).toBeInTheDocument();
    });
  });

  it('exports to PDF', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetFlexGroupStatus.mockResolvedValue([
      makeGroup('Wants', [{ id: 'c', name: 'Cat', budgeted: 100, spent: 80 }]),
    ]);
    await renderReport();
    const exportBtn = await screen.findByTitle('Export PDF');
    await act(async () => { fireEvent.click(exportBtn); });
    await waitFor(() => expect(mockExportToPdf).toHaveBeenCalled());
    expect(mockExportToPdf.mock.calls[0][0].title).toBe('Flex Group Analysis');
  });
});
