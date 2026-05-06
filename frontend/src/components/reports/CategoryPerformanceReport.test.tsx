import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { CategoryPerformanceReport } from './CategoryPerformanceReport';
import type { Budget, CategoryTrendSeries } from '@/types/budget';

const mockGetAll = vi.fn();
const mockGetCategoryTrend = vi.fn();
const mockExportToPdf = vi.fn();

vi.mock('@/lib/budgets', () => ({
  budgetsApi: {
    getAll: (...args: any[]) => mockGetAll(...args),
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
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: (...args: any[]) => mockExportToPdf(...args),
}));

const makeBudget = (overrides: Partial<Budget> = {}): Budget =>
  ({
    id: 'b-1',
    name: 'Default Budget',
    isActive: true,
    ...overrides,
  } as Budget);

const makeSeries = (
  id: string,
  name: string,
  points: { budgeted: number; actual: number }[],
): CategoryTrendSeries => ({
  categoryId: id,
  categoryName: name,
  data: points.map((p, idx) => ({
    month: `2025-0${idx + 1}`,
    budgeted: p.budgeted,
    actual: p.actual,
    variance: p.actual - p.budgeted,
    percentUsed: p.budgeted > 0 ? (p.actual / p.budgeted) * 100 : 0,
  })) as any,
});

async function renderReport() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<CategoryPerformanceReport />);
  });
  return result!;
}

describe('CategoryPerformanceReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExportToPdf.mockResolvedValue(undefined);
  });

  it('shows loading state while category trend is fetching', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetCategoryTrend.mockReturnValue(new Promise(() => {}));
    let container: HTMLElement;
    await act(async () => {
      const r = render(<CategoryPerformanceReport />);
      container = r.container;
    });
    expect(container!.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders empty-budget state when no budgets exist', async () => {
    mockGetAll.mockResolvedValue([]);
    await renderReport();
    await waitFor(() => {
      expect(
        screen.getByText(/No budgets found/i),
      ).toBeInTheDocument();
    });
  });

  it('falls back to first budget when no active budget', async () => {
    mockGetAll.mockResolvedValue([
      makeBudget({ id: 'b-x', name: 'First', isActive: false }),
      makeBudget({ id: 'b-y', name: 'Second', isActive: false }),
    ]);
    mockGetCategoryTrend.mockResolvedValue([]);
    await renderReport();
    await waitFor(() => {
      expect(mockGetCategoryTrend).toHaveBeenCalledWith('b-x', 6);
    });
  });

  it('renders empty table state when no category data', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetCategoryTrend.mockResolvedValue([]);
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText(/No category data available/i)).toBeInTheDocument();
    });
  });

  it('renders category rows with computed metrics covering under/on/over status and trend variants', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetCategoryTrend.mockResolvedValue([
      // Under budget, falling trend (Down)
      makeSeries('c-under', 'Groceries', [
        { budgeted: 100, actual: 90 },
        { budgeted: 100, actual: 80 },
        { budgeted: 100, actual: 80 },
        { budgeted: 100, actual: 50 },
        { budgeted: 100, actual: 40 },
        { budgeted: 100, actual: 30 },
      ]),
      // Over budget, rising trend (Up)
      makeSeries('c-over', 'Dining', [
        { budgeted: 100, actual: 80 },
        { budgeted: 100, actual: 90 },
        { budgeted: 100, actual: 95 },
        { budgeted: 100, actual: 130 },
        { budgeted: 100, actual: 140 },
        { budgeted: 100, actual: 150 },
      ]),
      // On track flat
      makeSeries('c-on', 'Utilities', [
        { budgeted: 100, actual: 90 },
        { budgeted: 100, actual: 92 },
        { budgeted: 100, actual: 95 },
        { budgeted: 100, actual: 90 },
        { budgeted: 100, actual: 92 },
        { budgeted: 100, actual: 95 },
      ]),
      // Zero budget edge case (avgPercent = 0, earlier avg = 0)
      makeSeries('c-zero', 'Misc', [
        { budgeted: 0, actual: 0 },
        { budgeted: 0, actual: 0 },
      ]),
      // Single-point series (length < 2 -> trend '--')
      makeSeries('c-single', 'Solo', [{ budgeted: 100, actual: 110 }]),
    ]);
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Groceries')).toBeInTheDocument();
    });
    expect(screen.getByText('Dining')).toBeInTheDocument();
    expect(screen.getByText('Utilities')).toBeInTheDocument();
    expect(screen.getByText('Misc')).toBeInTheDocument();
    expect(screen.getByText('Solo')).toBeInTheDocument();
    expect(screen.getAllByText('Under Budget').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Over Budget/i).length).toBeGreaterThan(0);
    expect(screen.getByText('On Track')).toBeInTheDocument();
  });

  it('toggles sort direction and switches sort field', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetCategoryTrend.mockResolvedValue([
      makeSeries('a', 'Apples', [{ budgeted: 100, actual: 50 }]),
      makeSeries('b', 'Bananas', [{ budgeted: 100, actual: 200 }]),
    ]);
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText('Apples')).toBeInTheDocument();
    });
    // Default sort is avgPercent desc (High). Click name to switch field, toggling direction logic.
    const nameHeader = screen.getByText(/Category/i);
    await act(async () => { fireEvent.click(nameHeader); });
    // The header now should include direction marker
    await waitFor(() => {
      expect(screen.getByText(/Category .*Z-A/i)).toBeInTheDocument();
    });
    // Toggling sort dir on same field
    await act(async () => { fireEvent.click(nameHeader); });
    await waitFor(() => {
      expect(screen.getByText(/Category .*A-Z/i)).toBeInTheDocument();
    });
    // Switch to variance
    const varianceHeader = screen.getByText(/Total Variance/i);
    await act(async () => { fireEvent.click(varianceHeader); });
    // Switch back to avgPercent
    const pctHeader = screen.getByText(/% Used/i);
    await act(async () => { fireEvent.click(pctHeader); });
    await waitFor(() => {
      expect(screen.getByText(/% Used .*High/i)).toBeInTheDocument();
    });
  });

  it('switches budget and months selectors and refetches', async () => {
    mockGetAll.mockResolvedValue([
      makeBudget({ id: 'b-1', name: 'A', isActive: true }),
      makeBudget({ id: 'b-2', name: 'B', isActive: false }),
    ]);
    mockGetCategoryTrend.mockResolvedValue([]);
    await renderReport();
    await waitFor(() => {
      expect(mockGetCategoryTrend).toHaveBeenCalledWith('b-1', 6);
    });
    const selects = document.querySelectorAll('select');
    // First select = budget; Second select = months
    await act(async () => {
      fireEvent.change(selects[0], { target: { value: 'b-2' } });
    });
    await waitFor(() => {
      expect(mockGetCategoryTrend).toHaveBeenCalledWith('b-2', 6);
    });
    await act(async () => {
      fireEvent.change(selects[1], { target: { value: '12' } });
    });
    await waitFor(() => {
      expect(mockGetCategoryTrend).toHaveBeenCalledWith('b-2', 12);
    });
  });

  it('handles budget load failure gracefully', async () => {
    mockGetAll.mockRejectedValue(new Error('boom'));
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText(/No budgets found/i)).toBeInTheDocument();
    });
  });

  it('handles category trend load failure gracefully', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetCategoryTrend.mockRejectedValue(new Error('nope'));
    await renderReport();
    await waitFor(() => {
      expect(screen.getByText(/No category data available/i)).toBeInTheDocument();
    });
  });

  it('exports to PDF when export button clicked', async () => {
    mockGetAll.mockResolvedValue([makeBudget()]);
    mockGetCategoryTrend.mockResolvedValue([
      makeSeries('a', 'Apples', [
        { budgeted: 100, actual: 110 },
        { budgeted: 100, actual: 120 },
      ]),
    ]);
    await renderReport();
    const exportBtn = await screen.findByTitle('Export PDF');
    await act(async () => { fireEvent.click(exportBtn); });
    await waitFor(() => {
      expect(mockExportToPdf).toHaveBeenCalled();
    });
    const arg = mockExportToPdf.mock.calls[0][0];
    expect(arg.title).toBe('Category Performance');
    expect(arg.tableData.headers).toContain('Category');
  });
});
