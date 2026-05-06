import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { BudgetVsActualReport } from './BudgetVsActualReport';
import type { Budget, BudgetTrendPoint, CategoryTrendSeries } from '@/types/budget';

const mockGetAll = vi.fn();
const mockGetTrend = vi.fn();
const mockGetCategoryTrend = vi.fn();
const mockExportToPdf = vi.fn();

vi.mock('@/lib/budgets', () => ({
  budgetsApi: {
    getAll: (...args: any[]) => mockGetAll(...args),
    getTrend: (...args: any[]) => mockGetTrend(...args),
    getCategoryTrend: (...args: any[]) => mockGetCategoryTrend(...args),
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

vi.mock('@/components/budgets/BudgetCategoryTrend', () => ({
  BudgetCategoryTrend: ({ data }: { data: CategoryTrendSeries[] }) => (
    <div data-testid="cat-trend">categories={data.length}</div>
  ),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  BarChart: ({ children }: any) => <div data-testid="bar-chart">{children}</div>,
  Bar: () => null,
  LineChart: ({ children }: any) => <div data-testid="line-chart">{children}</div>,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Legend: () => null,
  Tooltip: ({ content }: any) => {
    const C = content;
    if (!C) return null;
    const samples = [
      { active: true, payload: [{ dataKey: 'budgeted', name: 'Budgeted', color: '#3b82f6', value: 1000 }, { dataKey: 'actual', name: 'Actual', color: '#10b981', value: 1100 }], label: 'tip-1' },
      { active: true, payload: [{ value: 100 }], label: 'tip-2' },
      { active: true, payload: [{ value: -50 }], label: 'tip-3' },
      { active: false, payload: [], label: '' },
      { active: true, payload: null, label: 'no payload' },
    ];
    return <div>{samples.map((s, i) => <div key={i}>{C(s)}</div>)}</div>;
  },
}));

const makeBudget = (overrides: Partial<Budget> = {}): Budget =>
  ({ id: 'b-1', name: 'Default', isActive: true, ...overrides } as Budget);

const makePoint = (
  month: string,
  budgeted: number,
  actual: number,
): BudgetTrendPoint => ({
  month,
  budgeted,
  actual,
  variance: actual - budgeted,
  percentUsed: budgeted > 0 ? Math.round((actual / budgeted) * 100) : 0,
});

async function renderReport() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<BudgetVsActualReport />);
  });
  return result!;
}

describe('BudgetVsActualReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExportToPdf.mockResolvedValue(undefined);
  });

  it('renders loading skeleton', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetTrend.mockReturnValue(new Promise(() => {}));
    mockGetCategoryTrend.mockReturnValue(new Promise(() => {}));
    let container: HTMLElement;
    await act(async () => {
      const r = render(<BudgetVsActualReport />);
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

  it('falls back to first budget when no active', async () => {
    mockGetAll.mockResolvedValue([
      makeBudget({ id: 'a', isActive: false }),
      makeBudget({ id: 'b', isActive: false }),
    ]);
    mockGetTrend.mockResolvedValue([]);
    mockGetCategoryTrend.mockResolvedValue([]);
    await renderReport();
    await waitFor(() => expect(mockGetTrend).toHaveBeenCalledWith('a', 6));
  });

  it('renders empty trend message in overview', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetTrend.mockResolvedValue([]);
    mockGetCategoryTrend.mockResolvedValue([]);
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText(/No trend data available/i)).toBeInTheDocument();
    });
  });

  it('renders trend table with positive and negative variance rows', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetTrend.mockResolvedValue([
      makePoint('2025-01', 1000, 1100),
      makePoint('2025-02', 1000, 900),
    ]);
    mockGetCategoryTrend.mockResolvedValue([]);
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('2025-01')).toBeInTheDocument();
    });
    expect(screen.getByText('2025-02')).toBeInTheDocument();
  });

  it('toggles to By Category view', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetTrend.mockResolvedValue([makePoint('2025-01', 1000, 800)]);
    mockGetCategoryTrend.mockResolvedValue([
      { categoryId: 'c1', categoryName: 'X', data: [] },
    ]);
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('By Category')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByText('By Category'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('cat-trend')).toBeInTheDocument();
    });
    // Toggle back to overview
    await act(async () => {
      fireEvent.click(screen.getByText('Overview'));
    });
  });

  it('switches budget and months selectors and refetches', async () => {
    mockGetAll.mockResolvedValue([
      makeBudget({ id: 'b-1' }),
      makeBudget({ id: 'b-2', isActive: false }),
    ]);
    mockGetTrend.mockResolvedValue([]);
    mockGetCategoryTrend.mockResolvedValue([]);
    await renderReport();
    const selects = document.querySelectorAll('select');
    await act(async () => { fireEvent.change(selects[0], { target: { value: 'b-2' } }); });
    await waitFor(() => expect(mockGetTrend).toHaveBeenCalledWith('b-2', 6));
    await act(async () => { fireEvent.change(selects[1], { target: { value: '24' } }); });
    await waitFor(() => expect(mockGetTrend).toHaveBeenCalledWith('b-2', 24));
  });

  it('handles fetch error gracefully', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetTrend.mockRejectedValue(new Error('boom'));
    mockGetCategoryTrend.mockResolvedValue([]);
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText(/No trend data available/i)).toBeInTheDocument();
    });
  });

  it('exports to PDF', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetTrend.mockResolvedValue([makePoint('2025-01', 1000, 1100)]);
    mockGetCategoryTrend.mockResolvedValue([]);
    await renderReport();
    const exportBtn = await screen.findByTitle('Export PDF');
    await act(async () => { fireEvent.click(exportBtn); });
    await waitFor(() => expect(mockExportToPdf).toHaveBeenCalled());
    expect(mockExportToPdf.mock.calls[0][0].title).toBe('Budget vs Actual');
  });
});
